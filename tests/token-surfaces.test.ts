import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { OPERATIONS } from "../src/operations/registry";
import { type TokenPrincipal, OWNER } from "../src/operations/types";
import { createVolume } from "../src/services/volumes";
import { scopeAllowed } from "../src/tokens/model";
import { silenceLogs } from "./support/app";
import { SseReader } from "./support/sse";
import { call, type Harness, mint, principalOf, refused, startHarness } from "./support/tokens";

const ALL_TOOLSETS = "core,session,network,storage,tools,meta,rebuild,move";

let harness: Harness;
let restoreLogs: () => void;
const readers: SseReader[] = [];

beforeEach(() => {
  restoreLogs = silenceLogs();
  harness = startHarness();
});

afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.close();
  harness.stop();
  restoreLogs();
});

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function openStream(path: string, token: string): Promise<SseReader> {
  const res = await fetch(`${harness.base}${path}`, { headers: bearer(token) });
  expect(res.status).toBe(200);
  if (!res.body) throw new Error("the stream has no body");
  const reader = new SseReader(res.body.getReader());
  readers.push(reader);
  return reader;
}

async function createBox(token: string, name: string, extra: Record<string, unknown> = {}) {
  return call(harness.base, "/api/boxes", { token, body: { name, cpus: 1, memoryMb: 256, ...extra } });
}

async function startSnapshot(token: string, boxId: string): Promise<string> {
  const taken = await call(harness.base, `/api/boxes/${boxId}/snapshots`, { token, body: { name: "held" } });
  expect(taken.status).toBe(202);
  return taken.json.taskId ?? "";
}

async function revoke(id: string): Promise<void> {
  const res = await call(harness.base, `/api/tokens/${id}`, { method: "DELETE" });
  expect(res.status).toBe(200);
}

interface RpcReply {
  result?: {
    tools?: { name: string }[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
}

async function rpc(token: string, method: string, params: unknown, session?: string): Promise<Response> {
  const headers: Record<string, string> = {
    ...bearer(token),
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (session) headers["mcp-session-id"] = session;
  return fetch(`${harness.base}/mcp?toolsets=${ALL_TOOLSETS}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function openMcp(token: string): Promise<string> {
  const res = await rpc(token, "initialize", { protocolVersion: "2025-03-26", capabilities: {} });
  return res.headers.get("mcp-session-id") ?? "";
}

async function toolCall(token: string, session: string, name: string, args: unknown): Promise<RpcReply> {
  const res = await rpc(token, "tools/call", { name, arguments: args }, session);
  return (await res.json()) as RpcReply;
}

/** The MCP tool names a principal's scopes reach, computed from the operation registry rather than hand-written. */
function reachableTools(principal: TokenPrincipal): string[] {
  return OPERATIONS.flatMap((op) =>
    op.mcp && scopeAllowed(principal.grants, op.scope) ? [op.mcp.name] : [],
  ).toSorted();
}

describe("MCP for an agent token", () => {
  test("tools/list offers a token exactly the tools its scopes reach", async () => {
    const reader = mint(harness.app, { name: "reader", preset: "readonly" });
    const session = await openMcp(reader.secret);
    const listed = (await (await rpc(reader.secret, "tools/list", {}, session)).json()) as RpcReply;
    const names = (listed.result?.tools ?? []).map((tool) => tool.name).toSorted();

    expect(names).toEqual(reachableTools(principalOf(harness.app, reader.secret)));
    expect(names).toContain("list_boxes");
    expect(names).not.toContain("create_box");
    expect(names).not.toContain("exec");
  });

  test("a tool the token's scopes do not reach fails with the forbidden code and runs nothing", async () => {
    const reader = mint(harness.app, { name: "reader", preset: "readonly" });
    const session = await openMcp(reader.secret);
    const reply = await toolCall(reader.secret, session, "create_box", { name: "nope", cpus: 1, memoryMb: 256 });

    expect(reply.result?.isError).toBe(true);
    expect(reply.result?.structuredContent).toMatchObject({ code: "forbidden" });
    expect(harness.runtime.callsTo("createContainer")).toHaveLength(0);
    expect(harness.app.hosts.get().specs.list()).toHaveLength(0);
  });

  test("list_boxes shows a token its own boxes and no box another principal made", async () => {
    await call(harness.base, "/api/boxes", { body: { name: "owners", cpus: 1, memoryMb: 256 } });
    const agent = mint(harness.app, { name: "agent", preset: "operator" });
    expect((await createBox(agent.secret, "mine")).status).toBe(201);

    const session = await openMcp(agent.secret);
    const reply = await toolCall(agent.secret, session, "list_boxes", {});
    const boxes = (reply.result?.structuredContent?.boxes ?? []) as { name: string }[];
    expect(boxes.map((box) => box.name)).toEqual(["mine"]);
  });

  test("a session belongs to the principal that opened it, and ends when its token is revoked", async () => {
    const opener = mint(harness.app, { name: "opener", preset: "operator" });
    const other = mint(harness.app, { name: "other", preset: "operator" });
    const openerPrincipal = principalOf(harness.app, opener.secret);
    const otherPrincipal = principalOf(harness.app, other.secret);
    const session = await openMcp(opener.secret);
    const sessions = harness.app.mcpSessions;

    expect(sessions.get(session, openerPrincipal)).toBeDefined();
    expect(sessions.get(session, otherPrincipal)).toBeUndefined();
    expect(sessions.get(session, OWNER)).toBeUndefined();

    const foreignClose = await fetch(`${harness.base}/mcp`, {
      method: "DELETE",
      headers: { ...bearer(other.secret), "mcp-session-id": session },
    });
    expect(foreignClose.status).toBe(204);
    expect(sessions.get(session, openerPrincipal)).toBeDefined();

    await revoke(opener.id);
    expect(sessions.get(session, openerPrincipal)).toBeUndefined();
    expect((await rpc(opener.secret, "ping", {})).status).toBe(401);
  });
});

describe("streams end when the token that opened them is revoked", () => {
  test("the event stream of a revoked token ends", async () => {
    const watcher = mint(harness.app, { name: "watcher", preset: "readonly" });
    const stream = await openStream("/api/events/stream", watcher.secret);
    await stream.until((frame) => frame.event === "sync");

    await revoke(watcher.id);
    await stream.untilEnd();
  });

  test("the progress stream of a task ends when the token that started it is revoked", async () => {
    const held = harness.runtime.hold("commitContainer");
    try {
      const snapper = mint(harness.app, { name: "snapper", preset: "operator" });
      const box = await createBox(snapper.secret, "source");
      const taskId = await startSnapshot(snapper.secret, box.json.box?.id ?? "");
      const stream = await openStream(`/api/tasks/${taskId}/events`, snapper.secret);

      await revoke(snapper.id);
      await stream.untilEnd();
    } finally {
      held.release();
      await harness.app.tasks.drain();
    }
  });
});

describe("tasks a token may see", () => {
  test("a token lists and reads only the tasks it started or whose box it may see", async () => {
    const held = harness.runtime.hold("commitContainer");
    try {
      const starter = mint(harness.app, { name: "starter", preset: "operator" });
      const rival = mint(harness.app, { name: "rival", preset: "operator" });
      const box = await createBox(starter.secret, "source");
      const taskId = await startSnapshot(starter.secret, box.json.box?.id ?? "");

      const listed = await call(harness.base, "/api/tasks", { token: starter.secret });
      expect((listed.json.tasks ?? []).map((task) => task.id)).toContain(taskId);
      const hidden = await call(harness.base, "/api/tasks", { token: rival.secret });
      expect((hidden.json.tasks ?? []).map((task) => task.id)).not.toContain(taskId);

      expect(refused(await call(harness.base, `/api/tasks/${taskId}`, { token: rival.secret }))).toEqual({
        status: 404,
        key: "task_not_found",
      });

      const viewer = mint(harness.app, { name: "viewer", preset: "readonly", boxes: { type: "all" } });
      const shown = await call(harness.base, "/api/tasks", { token: viewer.secret });
      expect((shown.json.tasks ?? []).map((task) => task.id)).toContain(taskId);
      expect((await call(harness.base, `/api/tasks/${taskId}`, { token: viewer.secret })).status).toBe(200);
      const stream = await fetch(`${harness.base}/api/tasks/${taskId}/events`, { headers: bearer(rival.secret) });
      expect(stream.status).toBe(404);
    } finally {
      held.release();
      await harness.app.tasks.drain();
    }
  });
});

describe("volumes a token may mount", () => {
  test("no token mounts a pool root, and the owner's rebuild is refused the same way", async () => {
    const carrier = mint(harness.app, { name: "carrier", preset: "operator" });
    const box = await createBox(carrier.secret, "carrier-box");
    const id = box.json.box?.id ?? "";
    const headers = { "if-match": String(box.json.box?.revision ?? 1) };
    const mounts = [{ volume: "mbtest-pool-local", path: "/mnt/pool", mode: "rw" }];

    const byToken = await call(harness.base, `/api/boxes/${id}/rebuild`, {
      token: carrier.secret,
      body: { confirm: true, mounts },
      headers,
    });
    expect(refused(byToken)).toEqual({ status: 403, key: "volume_reserved" });

    const byOwner = await call(harness.base, `/api/boxes/${id}/rebuild`, { body: { confirm: true, mounts }, headers });
    expect(refused(byOwner)).toEqual({ status: 403, key: "volume_reserved" });
  });

  test("a token cannot attach another token's volume by id, even when every volume is granted", async () => {
    const maker = mint(harness.app, { name: "maker", preset: "operator" });
    const mounter = mint(harness.app, { name: "mounter", preset: "operator", volumes: { type: "all" } });
    const made = await call(harness.base, "/api/volumes", {
      token: maker.secret,
      body: { name: "maker-notes", confirm: true },
    });
    expect(made.status).toBe(201);
    const box = await createBox(mounter.secret, "mounter-box");
    const attach = {
      token: mounter.secret,
      body: { box: box.json.box?.boxId, path: "/srv/notes", mode: "ro", confirm: true },
      headers: { "if-match": String(box.json.box?.revision ?? 1) },
    };

    const refusedAttach = await call(harness.base, `/api/volumes/${made.json.volume?.id}/attach`, attach);
    expect(refused(refusedAttach)).toEqual({ status: 403, key: "volume_attach_forbidden" });

    const shared = await createVolume(harness.app.hosts.get(), {
      name: "shared-notes",
      role: null,
      createdBy: "owner",
    });
    const attached = await call(harness.base, `/api/volumes/${shared.id}/attach`, attach);
    expect(attached.status).toBe(200);
  });

  test("a token mounts a volume granted to it by id, and is refused a volume it was not granted by name", async () => {
    const shared = await createVolume(harness.app.hosts.get(), {
      name: "shared-notes",
      role: null,
      createdBy: "owner",
    });
    const granted = mint(harness.app, {
      name: "granted",
      preset: "operator",
      volumes: { type: "list", ids: [shared.id] },
    });
    const other = mint(harness.app, { name: "other", preset: "operator", volumes: { type: "list", ids: [] } });

    const mounted = await createBox(granted.secret, "reader", {
      mounts: [{ volume: shared.id, path: "/srv/shared", mode: "ro" }],
    });
    expect(mounted.status).toBe(201);

    const byName = await createBox(other.secret, "reader-two", {
      mounts: [{ volume: "shared-notes", path: "/srv/shared", mode: "ro" }],
    });
    expect(refused(byName)).toEqual({ status: 403, key: "volume_attach_forbidden" });
  });
});

interface EventRow {
  op: string;
  principal: { id: string };
  target?: { name: string };
}

/** The owner's events about a box named `web`, as the operations that recorded them. */
function ownerEventsNamedWeb(events: EventRow[]): string[] {
  return events
    .filter((event) => event.principal.id === "owner" && event.target?.name === "web")
    .map((event) => event.op);
}

describe("networks a token may give a box", () => {
  test("a token's rebuild cannot put a box on a shared or unmanaged network, and the refused box keeps its network", async () => {
    const carrier = mint(harness.app, { name: "carrier", preset: "operator" });
    const box = await createBox(carrier.secret, "carrier-box");
    const id = box.json.box?.id ?? "";
    const revision = String(box.json.box?.revision ?? 1);
    const specs = harness.app.hosts.get().specs;
    const network = specs.read(id)?.network;
    const creates = harness.runtime.callsTo("createContainer").length;

    const refusals: [string, { status: number; key: string }][] = [
      ["host", { status: 403, key: "network_reserved" }],
      ["none", { status: 403, key: "network_reserved" }],
      ["container:abc123", { status: 400, key: "network_invalid" }],
      ["bridge", { status: 403, key: "network_not_managed" }],
    ];
    for (const [requested, expected] of refusals) {
      const reply = await call(harness.base, `/api/boxes/${id}/rebuild`, {
        token: carrier.secret,
        body: { confirm: true, network: requested },
        headers: { "if-match": revision },
      });
      expect(refused(reply)).toEqual(expected);
    }
    expect(harness.runtime.callsTo("createContainer")).toHaveLength(creates);
    expect(specs.read(id)?.network).toBe(network);
  });
});

describe("events about a box name", () => {
  test("an earlier box of the same name keeps its events from a token, and the owner's events survive a rebuild", async () => {
    const first = await call(harness.base, "/api/boxes", { body: { name: "web", cpus: 1, memoryMb: 256 } });
    expect((await call(harness.base, `/api/boxes/${first.json.box?.id}`, { method: "DELETE" })).status).toBe(200);
    await Bun.sleep(5);

    const agent = mint(harness.app, { name: "agent", preset: "operator" });
    const made = await createBox(agent.secret, "web");
    expect(made.status).toBe(201);
    const agentBoxId = made.json.box?.id ?? "";

    const before = await call(harness.base, "/api/events?limit=100", { token: agent.secret });
    expect(ownerEventsNamedWeb(before.json.events ?? [])).toEqual([]);

    expect((await call(harness.base, `/api/boxes/${agentBoxId}/stop`, { method: "POST" })).status).toBe(200);
    const current = await call(harness.base, `/api/boxes/${agentBoxId}`, { token: agent.secret });
    const rebuilt = await call(harness.base, `/api/boxes/${agentBoxId}/rebuild`, {
      token: agent.secret,
      body: { confirm: true, profile: "strict" },
      headers: { "if-match": String(current.json.box?.revision ?? 1) },
    });
    expect(rebuilt.status).toBe(200);
    expect(rebuilt.json.box?.id).not.toBe(agentBoxId);

    const after = await call(harness.base, "/api/events?limit=100", { token: agent.secret });
    expect(ownerEventsNamedWeb(after.json.events ?? [])).toEqual(["box.action"]);
  });
});

describe("moving a box to another host", () => {
  test("only the owner or a credential granted every host and box may move a box", async () => {
    const operator = mint(harness.app, { name: "mover-operator", preset: "operator" });
    const admin = mint(harness.app, { name: "mover-admin", preset: "admin" });
    const created = await createBox(operator.secret, "moving-box");
    const id = created.json.box?.id ?? "";
    const headers = { "if-match": String(created.json.box?.revision ?? 1) };
    const body = { host: "lab", confirm: true };

    const byOperator = await call(harness.base, `/api/boxes/${id}/move`, { token: operator.secret, body, headers });
    expect(refused(byOperator)).toEqual({ status: 403, key: "move_owner_only" });

    const byAdmin = await call(harness.base, `/api/boxes/${id}/move`, { token: admin.secret, body, headers });
    expect(refused(byAdmin)).toEqual({ status: 404, key: "host_not_found" });
  });
});
