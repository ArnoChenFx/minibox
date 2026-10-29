import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileToken } from "../src/tokens/model";
import { TokenStore } from "../src/tokens/store";
import { silenceLogs } from "./support/app";
import { call, mint, startHarness, type Harness } from "./support/tokens";
const restore = silenceLogs();
afterAll(restore);
const harnesses: Harness[] = [];
const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "minibox-storage-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const h of harnesses.splice(0)) h.stop();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

test("storage administration is checked for existing and custom tokens before any side effect", async () => {
  const h = startHarness();
  harnesses.push(h);
  const tokens = [
    mint(h.app, { name: "operator", preset: "operator" }),
    mint(h.app, { name: "sandbox", preset: "sandboxed-agent" }),
    mint(h.app, {
      name: "pretend-admin",
      scopes: ["box:write", "volume:write", "volume:delete", "secret:use"],
      boxes: { type: "all" },
      hosts: { type: "all" },
    }),
    mint(h.app, { name: "narrowed-admin", preset: "admin", boxes: { type: "created-by-me" } }),
  ];
  const before = h.runtime.calls.length;
  for (const token of tokens) {
    for (const [path, body] of [
      ["/api/volumes", { name: "forbidden", pool: "local", confirm: true }],
      ["/api/volumes/delete", { ids: ["vol_missing"], confirm: true }],
      ["/api/boxes", { name: "forbidden", mounts: [{ role: "workspace", pool: "local" }] }],
    ] as const) {
      const response = await call(h.base, path, { token: token.secret, body });
      expect(response.status).toBe(403);
      expect(["storage_admin_required", "operation_forbidden"]).toContain(response.json.error?.key ?? "");
    }
    expect(
      (await call(h.base, "/api/volumes/missing?confirm=true", { token: token.secret, method: "DELETE" })).status,
    ).toBe(403);
  }
  expect(
    h.runtime.calls.slice(before).some((c) => ["createVolume", "removeVolume", "createContainer"].includes(c.op)),
  ).toBe(false);
  expect(h.app.hosts.get().volumes.list()).toHaveLength(0);
  // Independent management is refused, while a normal box still receives its own default volumes.
  expect((await call(h.base, "/api/boxes", { token: tokens[0]!.secret, body: { name: "ordinary" } })).status).toBe(201);
});

test("an authenticated admin can use pools and create/delete its volume, without gaining token management", async () => {
  const h = startHarness();
  harnesses.push(h);
  const admin = mint(h.app, { name: "admin", preset: "admin" });
  expect((await call(h.base, "/api/pools", { token: admin.secret })).status).toBe(200);
  const created = await call(h.base, "/api/volumes", { token: admin.secret, body: { name: "notes", confirm: true } });
  expect(created.status).toBe(201);
  const deleted = await call(h.base, `/api/volumes/${created.json.volume?.id}?confirm=true`, {
    token: admin.secret,
    method: "DELETE",
  });
  expect(deleted.status).toBe(200);
  expect((await call(h.base, "/api/tokens", { token: admin.secret })).status).toBe(403);
});

test("admin pool selection ignores an unrelated legacy workspace, while default provisioning still checks ownership", async () => {
  const h = startHarness();
  harnesses.push(h);
  const host = h.app.hosts.get();
  h.runtime.volumes.set("mbtest-ws-legacy", {
    name: "mbtest-ws-legacy",
    labels: { [host.keys.box]: "true", [host.keys.name]: "legacy" },
  });
  const admin = mint(h.app, { name: "admin", preset: "admin" });
  const selected = await call(h.base, "/api/boxes", {
    token: admin.secret,
    body: { name: "legacy", mounts: [{ role: "workspace", pool: "local" }] },
  });
  expect(selected.status).toBe(201);
  expect(host.specs.list().find((box) => box.name === "legacy")?.mounts[0]?.volume).not.toBe("mbtest-ws-legacy");
  h.runtime.volumes.set("mbtest-ws-default", {
    name: "mbtest-ws-default",
    labels: { [host.keys.box]: "true", [host.keys.name]: "default" },
  });
  const operator = mint(h.app, { name: "operator", preset: "operator" });
  expect((await call(h.base, "/api/boxes", { token: operator.secret, body: { name: "default" } })).status).toBe(403);
  expect(h.runtime.containers.size).toBe(1);
});

test("reloaded tokens derive storage administration from their saved policies", () => {
  const file = join(temp(), "tokens.json");
  const store = new TokenStore({ file });
  const old = store.create(compileToken({ name: "operator", preset: "operator" }), "owner");
  const admin = store.create(compileToken({ name: "admin", preset: "admin" }), "owner");
  store.stop();
  const reloaded = new TokenStore({ file });
  try {
    expect(reloaded.authenticate(old.secret, "127.0.0.1")?.grants.storageAdmin).not.toBe(true);
    expect(reloaded.authenticate(admin.secret, "127.0.0.1")?.grants.storageAdmin).toBe(true);
  } finally {
    reloaded.stop();
  }
});

test("MCP discovery hides storage administration, and MCP/CLI calls enforce the same identity gate", async () => {
  const h = startHarness();
  harnesses.push(h);
  const token = mint(h.app, { name: "custom", scopes: ["volume:write", "volume:delete"] });
  const rpc = async (method: string, params: unknown, session?: string) =>
    fetch(`${h.base}/mcp?toolsets=storage`, {
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
  const listed = (await (await rpc("tools/list", {}, session)).json()) as { result: { tools: { name: string }[] } };
  expect(listed.result.tools.map((tool) => tool.name)).not.toContain("create_volume");
  const refused = (await (
    await rpc("tools/call", { name: "create_volume", arguments: { name: "not-created", confirm: true } }, session)
  ).json()) as { result: { isError: boolean; structuredContent: { key: string } } };
  expect(refused.result.isError).toBe(true);
  expect(refused.result.structuredContent.key).toBe("storage_admin_required");
  const { runCli } = await import("../src/cli");
  const errors: string[] = [];
  const code = await runCli(
    ["volume", "delete", "missing", "--yes"],
    { MINIBOX_URL: h.base, MINIBOX_ACCESS_KEY: token.secret },
    {
      stdout: () => {},
      stdoutBytes: () => {},
      stderr: (text) => errors.push(text),
      stdinBytes: async function* () {},
    },
  );
  expect(code).toBe(1);
  expect(errors.join("")).toContain("admin");
  expect(h.app.hosts.get().volumes.list()).toHaveLength(0);
});
