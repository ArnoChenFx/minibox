import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listEntries } from "../src/backup/layout";
import { backupDirRefusal } from "../src/data-dir";
import { BackupService } from "../src/services/backup";
import { createDeclaredTemplate, editRecipe, readRecipe, templateAndRecipe } from "../src/services/template-builds";
import { editTemplate } from "../src/services/templates";
import { compileToken } from "../src/tokens/model";
import { TokenStore } from "../src/tokens/store";
import { commandText, initOf } from "../web/js/lib/template-edit.js";
import { createTestApp, silenceLogs } from "./support/app";
import { call, mint, principalOf, startHarness, type Harness } from "./support/tokens";

const restore = silenceLogs();
const roots: string[] = [];
const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.stop();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
process.on("exit", restore);
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "mb-286-"));
  roots.push(root);
  return root;
};
const source = { kind: "dockerfile" as const, text: "FROM alpine:3.20\nRUN true\n" };

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

test("saved legacy tokens get the new storage restriction after reloading", () => {
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

test("a corrupt backup record cannot roll back a completed archive or hide healthy records", async () => {
  const data = join(temp(), "data");
  const backups = join(data, "backups");
  mkdirSync(backups, { recursive: true });
  mkdirSync(join(backups, "bk_aaaaaaaaaaaaaaaa.json"));
  writeFileSync(join(data, "sample.json"), "{}");
  const service = new BackupService({ dataDir: data, databases: [], keep: 2 });
  const record = await service.create("probe-passphrase", "owner");
  expect(service.whole(record.id)?.id).toBe(record.id);
  expect(service.list().map((r) => r.id)).toContain(record.id);
  expect(readdirSync(backups)).toContain(`${record.id}.mbbak`);
});

test("real paths exclude backup aliases and refuse an alias for the data directory", async () => {
  const root = temp();
  const data = join(root, "data");
  const archives = join(data, "archives");
  mkdirSync(archives, { recursive: true });
  writeFileSync(join(archives, "old.mbbak"), "old");
  const alias = join(root, "backup-link");
  symlinkSync(archives, alias, "dir");
  expect((await listEntries(data, { exclude: [alias] })).map((e) => e.rel)).not.toContain("archives/old.mbbak");
  const dataAlias = join(root, "data-link");
  symlinkSync(data, dataAlias, "dir");
  expect(backupDirRefusal(dataAlias, data)).not.toBeNull();
  expect(backupDirRefusal(join(alias, "new"), data)).toBeNull();
});

test("custom shared backup folders retain their mode; archives stay private", async () => {
  const root = temp();
  const dir = join(root, "shared");
  mkdirSync(dir);
  chmodSync(dir, 0o750);
  const service = new BackupService({ dataDir: join(root, "data"), backupDir: dir, databases: [] });
  const record = await service.create("probe-passphrase", "owner");
  expect(statSync(dir).mode & 0o777).toBe(0o750);
  expect(statSync(service.store.pathFor(record.id)).mode & 0o777).toBe(0o600);
});

for (const [stalePatch, currentPatch] of [
  [{ source: { ...source, text: "FROM alpine:3.21\n" } }, { description: "New description" }],
  [{ source: { ...source, text: "FROM alpine:3.21\n" } }, { init: { forwardPorts: [8080] } }],
  [{ init: { forwardPorts: [3000] } }, { source: { ...source, text: "FROM alpine:3.21\n" } }],
] as const)
  test(`a stale ${Object.keys(stalePatch)[0]} edit cannot replace a newer ${Object.keys(currentPatch)[0]} after authorization I/O`, async () => {
    const { app, runtime } = createTestApp({ labelPrefix: "mbtest" });
    const host = app.hosts.get();
    const maker = mint(app, { name: "maker", preset: "operator" });
    await createDeclaredTemplate(host, { name: "tool", source, createdBy: maker.id }, { log: () => {} });
    const inspect = runtime.inspectImage.bind(runtime);
    let count = 0;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    runtime.inspectImage = async (ref) => {
      if (++count === 4) {
        entered.resolve();
        await release.promise;
      }
      return inspect(ref);
    };
    const ctx = {
      host,
      principal: principalOf(app, maker.secret),
      source: "rest" as const,
      events: app.events,
      tokens: app.tokens,
      execs: app.execs,
      terminals: app.terminals,
    };
    const stale = app.operations.run("template.edit", ctx, { ref: "mbtest-template:tool", ...stalePatch });
    await entered.promise;
    await app.operations.run("template.edit", ctx, { ref: "mbtest-template:tool", ...currentPatch });
    release.resolve();
    await expect(stale).rejects.toMatchObject({ status: 409, key: "template_busy" });
    expect((await templateAndRecipe(host, "mbtest-template:tool"))[0].recipe).toMatchObject(currentPatch);
  });

test("full template form clears each field while an unchanged argv remains safe", async () => {
  const { app } = createTestApp({ labelPrefix: "mbtest" });
  const host = app.hosts.get();
  await createDeclaredTemplate(host, { name: "tool", source, createdBy: "owner" }, { log: () => {} });
  let [declared, image] = await templateAndRecipe(host, "mbtest-template:tool");
  editRecipe(host, declared, { init: { postCreate: ["/bin/sh", "-c", "echo OLD"], forwardPorts: [3000] } });
  [declared, image] = await templateAndRecipe(host, "mbtest-template:tool");
  await editTemplate(host, declared, image, { init: initOf("", [3000]) });
  expect(readRecipe(host, "tool")?.init).toEqual({ forwardPorts: [3000] });
  [declared, image] = await templateAndRecipe(host, "mbtest-template:tool");
  await editTemplate(host, declared, image, { init: initOf("echo NEW", []) });
  expect(readRecipe(host, "tool")?.init).toEqual({ postCreate: ["/bin/sh", "-c", "echo NEW"] });
  const args = ["printf", "%s|", "$REVIEW_LITERAL", "", "a'b", "a b", "$(echo BAD)", "`echo BAD`", ";"];
  const rendered = commandText(args);
  const command = initOf(rendered, [])!.postCreate!;
  const child = Bun.spawn(command, { stdout: "pipe", env: { ...process.env, REVIEW_LITERAL: "expanded" } });
  expect(await new Response(child.stdout).text()).toBe(
    args
      .slice(2)
      .map((arg) => `${arg}|`)
      .join(""),
  );
  expect(await child.exited).toBe(0);
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

test("invisible recipe references do not disclose whether a source exists", async () => {
  const h = startHarness();
  harnesses.push(h);
  const host = h.app.hosts.get();
  h.runtime.seedImage("mbtest-template:foreign", {
    [host.keys.template]: "true",
    [host.keys.templateName]: "foreign",
    [host.keys.createdBy]: "tok_other",
  });
  const reader = mint(h.app, { name: "reader", preset: "readonly" });
  const rpc = (method: string, params: unknown, session?: string) =>
    fetch(`${h.base}/mcp?toolsets=tools`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${reader.secret}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  const initialized = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
  const session = initialized.headers.get("mcp-session-id") ?? "";
  for (const ref of ["mbtest-template:foreign", "mbtest-template:absent"]) {
    const result = await call(h.base, `/api/templates/${encodeURIComponent(ref)}/recipe`, { token: reader.secret });
    expect(result.status).toBe(403);
    expect(result.json.error?.key).toBe("template_out_of_scope");
    const mcp = (await (
      await rpc("tools/call", { name: "get_template_source", arguments: { ref } }, session)
    ).json()) as {
      result: { isError: boolean; structuredContent: { code: string; key: string } };
    };
    expect(mcp.result.isError).toBe(true);
    expect(mcp.result.structuredContent).toMatchObject({ code: "forbidden", key: "template_out_of_scope" });
  }
});

test("cold Docker inspection bounds concurrent requests and preserves container order", async () => {
  const { containerMethods } = await import("../src/docker/containers");
  const ids = Array.from({ length: 120 }, (_, i) => `container-${i}`);
  let active = 0;
  let peak = 0;
  const methods = containerMethods({
    changes: 0,
    inspected: new Map(),
    docker: {
      listContainers: async () => ids.map((Id) => ({ Id, State: "running" })),
      getContainer: (id: string) => ({
        inspect: async () => {
          peak = Math.max(peak, ++active);
          await Bun.sleep(1);
          active--;
          return {
            Id: id,
            Name: `/${id}`,
            Created: "2026-10-29T00:00:00Z",
            Config: { Image: "alpine:3.20", Labels: {} },
            State: { Status: "running", Running: true, StartedAt: "2026-10-29T00:00:00Z" },
            HostConfig: {},
            NetworkSettings: { Networks: {} },
          };
        },
      }),
    },
  } as unknown as Parameters<typeof containerMethods>[0]);
  expect((await methods.listContainers({ labels: {} })).map((c) => c.id)).toEqual(ids);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(12);
});

test("an alias inside DATA_DIR cannot archive the default backups folder", async () => {
  const data = join(temp(), "data");
  const backups = join(data, "backups");
  mkdirSync(backups, { recursive: true });
  writeFileSync(join(backups, "old.mbbak"), "old archive");
  symlinkSync(backups, join(data, "archive-alias"), "dir");
  const lines: string[] = [];
  const service = new BackupService({ dataDir: data, databases: [] });
  await service.create("probe-passphrase", "owner", (line) => lines.push(line));
  expect(lines.some((line) => line.includes("archive-alias") || line.includes("old.mbbak"))).toBe(false);
});
