import { afterAll, afterEach, expect, test } from "bun:test";

import type { TokenCreateInput } from "../src/tokens/model";
import { silenceLogs } from "./support/app";
import { call, finishedTask, type Harness, mint, refused, startHarness } from "./support/tokens";

const restore = silenceLogs();
afterAll(restore);
const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.stop();
});

const harness = () => {
  const h = startHarness();
  harnesses.push(h);
  return h;
};

async function makeBox(h: Harness, name: string, token?: string) {
  const reply = await call(h.base, "/api/boxes", { token, body: { name, cpus: 1, memoryMb: 256 } });
  expect(reply.status).toBe(201);
  const box = reply.json.box;
  if (!box) throw new Error("the create reply has no box");
  // Labels are set in place after the create, as the console does; tag-scoped tokens match on them.
  const current = await call(h.base, `/api/boxes/${box.boxId}`);
  const labelled = await call(h.base, `/api/boxes/${box.boxId}`, {
    method: "PATCH",
    headers: { "if-match": current.headers.get("etag") ?? "" },
    body: { labels: { team: "blue" } },
  });
  expect(labelled.status).toBe(200);
  return box;
}

/** The volumes this box owns, as the host records them. */
const ownedVolumes = (h: Harness, boxId: string) =>
  h.app.hosts
    .get()
    .volumes.list()
    .filter((volume) => volume.ownerBoxId === boxId);

const boxExists = async (h: Harness, boxId: string) => (await call(h.base, `/api/boxes/${boxId}`)).status === 200;

type Scoped = (boxId: string) => Omit<TokenCreateInput, "name">;
const SCOPED: Record<string, Scoped> = {
  "operator by id": (boxId) => ({ preset: "operator", boxes: { type: "ids", ids: [boxId] } }),
  "operator by tag": () => ({ preset: "operator", boxes: { type: "tags", tags: ["team=blue"] } }),
  "custom by id with trash:skip": (boxId) => ({
    scopes: ["box:read", "box:delete", "volume:write", "volume:delete", "trash:skip"],
    boxes: { type: "ids", ids: [boxId] },
  }),
  "custom by tag with trash:skip": () => ({
    scopes: ["box:read", "box:delete", "trash:skip"],
    boxes: { type: "tags", tags: ["team"] },
  }),
  "narrowed admin by id": (boxId) => ({ preset: "admin", boxes: { type: "ids", ids: [boxId] } }),
};

for (const [label, grants] of Object.entries(SCOPED)) {
  test(`a box-scoped token (${label}) cannot delete a box's volumes, and the box survives the refusal`, async () => {
    const h = harness();
    const box = await makeBox(h, "keep");
    const owned = ownedVolumes(h, box.boxId);
    expect(owned.length).toBeGreaterThan(0);
    const token = mint(h.app, { name: "scoped", ...grants(box.boxId) });
    const before = h.runtime.calls.length;
    for (const query of ["deleteVolume=true", "deleteVolume=true&skipTrash=true", "deleteVolume=1"]) {
      const reply = await call(h.base, `/api/boxes/${box.boxId}?${query}`, { token: token.secret, method: "DELETE" });
      expect(refused(reply)).toEqual({ status: 403, key: "storage_admin_required" });
    }
    expect(h.runtime.calls.slice(before).map((c) => c.op)).not.toContainAnyValues([
      "removeVolume",
      "removeContainer",
      "stopContainer",
    ]);
    expect(await boxExists(h, box.boxId)).toBe(true);
    expect(ownedVolumes(h, box.boxId).map((volume) => volume.id)).toEqual(owned.map((volume) => volume.id));
  });
}

test("a created-by-me token cannot delete the volumes of the box it created, but may delete the box alone", async () => {
  const h = harness();
  const token = mint(h.app, { name: "maker", preset: "operator" });
  const box = await makeBox(h, "mine", token.secret);
  const owned = ownedVolumes(h, box.boxId);
  expect(owned.length).toBeGreaterThan(0);
  const reply = await call(h.base, `/api/boxes/${box.boxId}?deleteVolume=true`, {
    token: token.secret,
    method: "DELETE",
  });
  expect(refused(reply)).toEqual({ status: 403, key: "storage_admin_required" });
  expect(await boxExists(h, box.boxId)).toBe(true);

  const kept = await call(h.base, `/api/boxes/${box.boxId}`, { token: token.secret, method: "DELETE" });
  expect(kept.status).toBe(200);
  expect(kept.json).toMatchObject({ volumeDeleted: false });
  expect(await boxExists(h, box.boxId)).toBe(false);
  expect(ownedVolumes(h, box.boxId).map((volume) => volume.id)).toEqual(owned.map((volume) => volume.id));
});

test("the refusal reaches MCP delete_box the same way", async () => {
  const h = harness();
  const box = await makeBox(h, "mcp-box");
  const token = mint(h.app, { name: "mcp", preset: "operator", boxes: { type: "ids", ids: [box.boxId] } });
  const rpc = async (method: string, params: unknown, session?: string) =>
    fetch(`${h.base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.secret}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  const opened = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
  const session = opened.headers.get("mcp-session-id") ?? "";
  const reply = (await (
    await rpc("tools/call", { name: "delete_box", arguments: { id: box.boxId, deleteVolume: true } }, session)
  ).json()) as { result: { isError: boolean; structuredContent: { key: string } } };
  expect(reply.result.isError).toBe(true);
  expect(reply.result.structuredContent.key).toBe("storage_admin_required");
  expect(await boxExists(h, box.boxId)).toBe(true);
});

test("the owner and an unmodified admin token still delete a box together with its volumes", async () => {
  const h = harness();
  const admin = mint(h.app, { name: "admin", preset: "admin" });
  for (const token of [undefined, admin.secret]) {
    const box = await makeBox(h, token ? "by-admin" : "by-owner");
    expect(ownedVolumes(h, box.boxId).length).toBeGreaterThan(0);
    const reply = await call(h.base, `/api/boxes/${box.boxId}?deleteVolume=true`, { token, method: "DELETE" });
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ volumeDeleted: true });
    expect(await boxExists(h, box.boxId)).toBe(false);
    expect(ownedVolumes(h, box.boxId)).toHaveLength(0);
  }
});

for (const [label, grants] of [
  ["ids", (boxId: string): Omit<TokenCreateInput, "name"> => ({ boxes: { type: "ids", ids: [boxId] } })],
  ["tags", (): Omit<TokenCreateInput, "name"> => ({ boxes: { type: "tags", tags: ["team=blue"] } })],
] as const) {
  test(`a box-scoped token by ${label} keeps SSH, exec, files, ports, checkpoints and plain box deletion`, async () => {
    const h = harness();
    const box = await makeBox(h, "work");
    const token = mint(h.app, { name: "worker", preset: "operator", ...grants(box.boxId) });
    const as = { token: token.secret };

    const ssh = await fetch(`${h.base}/api/ssh/${box.name}`, { headers: { authorization: `Bearer ${token.secret}` } });
    expect(ssh.status).toBe(204);

    const exec = await call(h.base, `/api/boxes/${box.boxId}/exec`, {
      ...as,
      body: { argv: ["echo", "hi"], background: true },
    });
    expect(exec.status).toBe(200);

    const workspace = ownedVolumes(h, box.boxId).find((volume) => volume.role === "workspace");
    if (!workspace) throw new Error("the box has no workspace volume");
    const files = await call(h.base, `/api/volumes/${workspace.id}/files?path=/`, as);
    expect(files.status).toBe(200);

    const exposed = await call(h.base, `/api/boxes/${box.boxId}/ports`, { ...as, body: { port: 5173 } });
    expect(exposed.status).toBe(200);
    expect((await call(h.base, `/api/boxes/${box.boxId}/ports`, as)).status).toBe(200);

    const started = await call(h.base, `/api/boxes/${box.boxId}/checkpoints`, { ...as, method: "POST", body: {} });
    expect(started.status).toBe(202);
    expect((await finishedTask(h.base, started.json.taskId ?? "")).status).toBe("succeeded");

    const deleted = await call(h.base, `/api/boxes/${box.boxId}`, { ...as, method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(deleted.json).toMatchObject({ volumeDeleted: false });
    expect(await boxExists(h, box.boxId)).toBe(false);
    expect(ownedVolumes(h, box.boxId).some((volume) => volume.id === workspace.id)).toBe(true);
  });
}
