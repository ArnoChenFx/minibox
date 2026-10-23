import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AGENTS_MD_SNIPPET } from "../src/mcp/instructions";
import type { OperationContext, Principal } from "../src/operations/types";
import { startServer } from "../src/server";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";

const OWNER: Principal = { type: "owner", id: "owner", name: "owner" };
const ROOT = join(import.meta.dir, "..");

function setup() {
  const { app, runtime } = createTestApp({ labelPrefix: "mbtest", mcpAllowOwnerKey: true });
  const keys = app.hosts.get().keys;
  runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  const ctx: OperationContext = {
    host: app.hosts.get(),
    principal: OWNER,
    source: "rest",
    events: app.events,
    tokens: app.tokens,
    execs: app.execs,
  };
  const server = startServer(app);
  return {
    app,
    runtime,
    ctx,
    base: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true);
      app.throttle.stop();
    },
  };
}

function rpc(id: number, method: string, params: unknown = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function post(
  base: string,
  body: string,
  headers: Record<string, string> = {},
  path = "/mcp",
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TEST_KEY}`,
      "content-type": "application/json",
      accept: "application/json",
      ...headers,
    },
    body,
  });
}

interface ToolReply {
  result: { isError?: boolean; structuredContent: Record<string, unknown> };
}

async function openSession(base: string, toolsets: string): Promise<string> {
  const init = await post(
    base,
    rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {} }),
    {},
    `/mcp?toolsets=${toolsets}`,
  );
  return init.headers.get("mcp-session-id") ?? "";
}

async function callTool(base: string, session: string, name: string, args: unknown): Promise<ToolReply> {
  const res = await post(base, rpc(2, "tools/call", { name, arguments: args }), { "mcp-session-id": session });
  return (await res.json()) as ToolReply;
}

describe("MCP", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("the agent snippet is the one in the agents guide", () => {
    expect(readFileSync(join(ROOT, "docs", "user-guide", "agents.md"), "utf8")).toContain(AGENTS_MD_SNIPPET);
  });

  test("requires a bearer token and refuses GET", async () => {
    const env = setup();
    try {
      const open = await fetch(`${env.base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rpc(1, "ping"),
      });
      expect(open.status).toBe(401);
      expect(await open.json()).toMatchObject({
        error: { code: "unauthorized", retryable: false, hint: expect.any(String) },
      });
      const cookie = await fetch(`${env.base}/mcp`, {
        method: "POST",
        headers: { cookie: "session=not-a-bearer", "content-type": "application/json" },
        body: rpc(1, "ping"),
      });
      expect(cookie.status).toBe(401);

      const get = await fetch(`${env.base}/mcp`, { headers: { authorization: `Bearer ${TEST_KEY}` } });
      expect(get.status).toBe(405);
      expect(get.headers.get("allow")).toBe("POST, DELETE");

      const removed = await fetch(`${env.base}/mcp`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${TEST_KEY}` },
      });
      expect(removed.status).toBe(204);
    } finally {
      env.stop();
    }
  });

  test("initialize, tools/list and tools/call exec", async () => {
    const env = setup();
    try {
      const created = (await env.app.operations.run("box.create", env.ctx, {
        name: "alpha",
        cpus: 1,
        memoryMb: 256,
      })) as {
        box: { id: string };
      };
      env.runtime.execScript = { stdout: "ok\n", stderr: "", code: 0 };

      const init = await post(
        env.base,
        rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {} }),
        {},
        "/mcp?toolsets=core",
      );
      expect(init.status).toBe(200);
      const session = init.headers.get("mcp-session-id");
      expect(session).toMatch(/^mcp[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(init.headers.get("mcp-protocol-version")).toBe("2025-03-26");
      const initBody = (await init.json()) as { result: { protocolVersion: string; instructions: string } };
      expect(initBody.result.protocolVersion).toBe("2025-03-26");
      expect(initBody.result.instructions).toContain(AGENTS_MD_SNIPPET);
      expect(initBody.result.instructions).not.toContain("design catalog");
      expect(initBody.result.instructions).toContain(
        "Taking, listing, forking and rolling back checkpoints have no MCP tools",
      );

      const listed = await post(env.base, rpc(2, "tools/list"), { "mcp-session-id": session ?? "" });
      const tools = ((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools.map(
        (tool) => tool.name,
      );
      expect(tools).toEqual([
        "list_boxes",
        "get_box",
        "create_box",
        "delete_box",
        "box_action",
        "update_box",
        "get_startup_command",
        "set_startup_command",
        "delete_startup_command",
        "run_startup_command",
        "exec",
        "exec_get",
        "exec_kill",
        "read_file",
        "write_file",
        "list_files",
        "copy_files",
        "upload_files",
      ]);
      expect(tools).not.toContain("rebuild_box");
      expect(tools).not.toContain("get_activity");

      const call = await post(
        env.base,
        rpc(3, "tools/call", { name: "exec", arguments: { id: created.box.id, argv: ["true"] } }),
        { "mcp-session-id": session ?? "" },
      );
      expect(call.status).toBe(200);
      const payload = (await call.json()) as {
        result: { isError?: boolean; structuredContent: { exitCode: number; stdout: string } };
      };
      expect(payload.result.isError).toBeUndefined();
      expect(payload.result.structuredContent).toMatchObject({ exitCode: 0, stdout: "ok\n" });
      const recorded = env.app.events.list({ op: "exec.run" }, { limit: 5 }).events;
      expect(recorded.some((event) => event.source === "mcp" && event.run === session)).toBe(true);
    } finally {
      env.stop();
    }
  });

  test("rejects batches, bad toolsets, and tools outside the selected set", async () => {
    const env = setup();
    try {
      const batch = await post(env.base, JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]));
      expect(batch.status).toBe(400);
      expect(await batch.json()).toMatchObject({ error: { code: -32600 } });

      const broken = await post(env.base, "{");
      expect(broken.status).toBe(400);
      expect(await broken.json()).toMatchObject({ error: { code: -32700 } });

      const note = await post(env.base, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
      expect(note.status).toBe(202);
      expect(await note.text()).toBe("");

      const badSet = await post(env.base, rpc(1, "tools/list"), {}, "/mcp?toolsets=nope");
      expect(badSet.status).toBe(400);
      expect(await badSet.json()).toMatchObject({ error: { code: "validation_failed", retryable: false } });

      const storage = await post(env.base, rpc(1, "tools/list"), {}, "/mcp?toolsets=storage");
      expect(
        ((await storage.json()) as { result: { tools: { name: string }[] } }).result.tools
          .map((t) => t.name)
          .toSorted(),
      ).toEqual([
        "add_target",
        "attach_volume",
        "check_target",
        "clear_checkpoint_schedule",
        "copy_checkpoint",
        "create_backup",
        "create_volume",
        "delete_backup",
        "delete_volume",
        "detach_volume",
        "export_checkpoint",
        "get_checkpoint_schedule",
        "get_volume",
        "import_checkpoint",
        "list_backups",
        "list_pools",
        "list_target_objects",
        "list_targets",
        "list_trash",
        "list_volumes",
        "measure_volume",
        "pull_from_target",
        "purge_trash",
        "push_to_target",
        "remove_target",
        "replace_pools",
        "restore_trash",
        "set_checkpoint_schedule",
        "set_volume_limits",
        "test_target",
      ]);

      const rebuild = await post(env.base, rpc(1, "tools/list"), {}, "/mcp?toolsets=rebuild");
      expect(
        ((await rebuild.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name),
      ).toEqual(["rebuild_box"]);

      const notRebuild = await post(
        env.base,
        rpc(6, "tools/call", { name: "rebuild_box", arguments: { id: "missing", confirm: true } }),
        {},
        "/mcp?toolsets=core",
      );
      const notRebuildBody = (await notRebuild.json()) as {
        result: { isError: boolean; structuredContent: { message: string; hint: string } };
      };
      expect(notRebuildBody.result.isError).toBe(true);
      expect(notRebuildBody.result.structuredContent.message).toContain("rebuild toolset");
      expect(notRebuildBody.result.structuredContent.hint).toContain("rebuild");

      const hidden = await post(
        env.base,
        rpc(4, "tools/call", { name: "exec", arguments: { id: "missing", argv: ["true"] } }),
        {},
        "/mcp?toolsets=meta",
      );
      const hiddenBody = (await hidden.json()) as { result: { isError: boolean; structuredContent: { hint: string } } };
      expect(hidden.status).toBe(200);
      expect(hiddenBody.result.isError).toBe(true);
      expect(hiddenBody.result.structuredContent.hint).toContain("core");

      const unknown = await post(env.base, rpc(5, "tools/call", { name: "get_activity", arguments: {} }));
      expect(unknown.status).toBe(200);
      expect(await unknown.json()).toMatchObject({ error: { code: -32602 } });

      const plain = await fetch(`${env.base}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_KEY}`,
          "content-type": "text/plain",
          accept: "application/json",
        },
        body: rpc(1, "ping"),
      });
      expect(plain.status).toBe(415);
    } finally {
      env.stop();
    }
  });

  describe("storage toolset", () => {
    test("the storage toolset is not served by default, and its writes are refused until confirm is true", async () => {
      const env = setup();
      try {
        const listed = await post(env.base, rpc(1, "tools/list"));
        const names = ((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools.map(
          (tool) => tool.name,
        );
        expect(names).not.toContain("create_volume");

        const off = await callTool(env.base, await openSession(env.base, "core"), "create_volume", { name: "notes" });
        expect(off.result).toMatchObject({
          isError: true,
          structuredContent: { code: "validation_failed", message: expect.stringContaining("storage toolset") },
        });

        const session = await openSession(env.base, "core,storage");
        const refused = await callTool(env.base, session, "create_volume", { name: "notes" });
        expect(refused.result).toMatchObject({
          isError: true,
          structuredContent: {
            code: "confirmation_required",
            retryable: false,
            details: { preview: { action: "create_volume", name: "notes", pool: "local", ownership: "independent" } },
          },
        });
        expect(env.app.hosts.get().volumes.list()).toEqual([]);

        const created = await callTool(env.base, session, "create_volume", { name: "notes", confirm: true });
        expect(created.result.isError).toBeUndefined();
        expect(created.result.structuredContent).toMatchObject({ volume: { name: "notes", ownership: "independent" } });
      } finally {
        env.stop();
      }
    });

    test("attach_volume over MCP rebuilds the box, so it needs confirm and an expected revision", async () => {
      const env = setup();
      try {
        const box = (await env.app.operations.run("box.create", env.ctx, {
          name: "alpha",
          cpus: 1,
          memoryMb: 256,
        })) as {
          box: { id: string; boxId: string };
        };
        const notes = (await env.app.operations.run("volume.create", env.ctx, { name: "notes", confirm: true })) as {
          volume: { id: string };
        };
        const session = await openSession(env.base, "core,storage");
        const attach = { id: notes.volume.id, box: box.box.id, path: "/srv/notes", mode: "ro", expectedRevision: "1" };
        const before = env.app.hosts.get().specs.read(box.box.boxId)?.mounts;

        const preview = await callTool(env.base, session, "attach_volume", attach);
        expect(preview.result).toMatchObject({
          isError: true,
          structuredContent: {
            code: "confirmation_required",
            details: { preview: { containerName: { from: "mbtest-alpha", to: `mbtest-${box.box.boxId}` } } },
          },
        });
        expect(env.app.hosts.get().specs.read(box.box.boxId)?.mounts).toEqual(before);
        expect(env.runtime.containers.get(box.box.id)?.name).toBe("mbtest-alpha");

        const applied = await callTool(env.base, session, "attach_volume", { ...attach, confirm: true });
        expect(applied.result.isError).toBeUndefined();
        expect(applied.result.structuredContent).toMatchObject({
          box: {
            boxId: box.box.boxId,
            revision: 2,
            containerName: `mbtest-${box.box.boxId}`,
            mounts: expect.arrayContaining([expect.objectContaining({ path: "/srv/notes", mode: "ro" })]),
          },
        });
        expect(env.runtime.containers.get(box.box.id)).toBeUndefined();
      } finally {
        env.stop();
      }
    });

    test("update_box refuses the MiniBox data volume, so no mount is added", async () => {
      const env = setup();
      try {
        const box = (await env.app.operations.run("box.create", env.ctx, {
          name: "alpha",
          cpus: 1,
          memoryMb: 256,
        })) as {
          box: { id: string; boxId: string };
        };
        const session = await openSession(env.base, "core");
        const before = env.app.hosts.get().specs.read(box.box.boxId)?.mounts;
        const refused = await callTool(env.base, session, "update_box", {
          id: box.box.id,
          mounts: [...(before ?? []), { volume: "minibox-data", path: "/data", mode: "ro" }],
          expectedRevision: "1",
        });
        expect(refused.result).toMatchObject({
          isError: true,
          structuredContent: { code: "forbidden", message: expect.stringContaining("minibox-data") },
        });
        expect(env.app.hosts.get().specs.read(box.box.boxId)?.mounts).toEqual(before);
        expect(env.runtime.containers.get(box.box.id)?.name).toBe("mbtest-alpha");
      } finally {
        env.stop();
      }
    });
  });
});
