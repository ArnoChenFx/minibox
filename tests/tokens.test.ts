import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { App } from "../src/app";
import type { HostMetrics } from "../src/host/metrics";
import { AppError } from "../src/lib/errors";
import { sha256 } from "../src/lib/hash";
import { OPERATIONS } from "../src/operations/registry";
import { startServer } from "../src/server";
import { authorizeOperation } from "../src/tokens/authorize";
import { canExec, compileToken, fileAccess, type TokenGrants } from "../src/tokens/model";
import { TokenStore } from "../src/tokens/store";
import { createTestApp, rejectionOf, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

const GB = 1024 ** 3;
const OWNER = { type: "owner" as const, id: "owner", name: "owner" };

interface TokenRecord {
  id: string;
  prefix: string;
  preset: string | null;
  scopes: string[];
  audit: string;
  quotas: { maxTtlSec: number | null; maxBoxes: number | null; rateLimit: number | null };
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  createdBy: string;
}

interface Running {
  app: App;
  runtime: FakeRuntime;
  base: string;
  stop: () => void;
}

let restoreLogs: () => void;
let running: Running | undefined;

beforeEach(() => {
  restoreLogs = silenceLogs();
});

afterEach(() => {
  running?.stop();
  running = undefined;
  restoreLogs();
});

function start(): Running {
  const { app, runtime } = createTestApp({ labelPrefix: "mbtest" });
  const keys = app.hosts.get().keys;
  runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  app.monitor.snapshot = async () => ({ cpu: { cores: 64 }, memory: { total: 64 * GB } }) as unknown as HostMetrics;
  const server = startServer(app);
  const started: Running = {
    app,
    runtime,
    base: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true);
      app.throttle.stop();
      app.sessions.stop();
      app.tokens.stop();
      app.events.close();
    },
  };
  running = started;
  return started;
}

const ownerHeaders = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${TEST_KEY}`,
  ...extra,
});

async function call(
  base: string,
  path: string,
  init: { method?: string; body?: unknown; token?: string; authed?: boolean } = {},
) {
  const headers = new Headers();
  if (init.authed !== false) headers.set("authorization", `Bearer ${init.token ?? TEST_KEY}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json = (await res.json()) as {
    token?: string;
    record?: TokenRecord;
    tokens?: TokenRecord[];
    box?: { id: string; name: string; ttlSec: number | null; createdBy: string };
    boxes?: { name: string; createdBy: string }[];
    snapshots?: { ref: string; source: string | null }[];
    deletedBoxes?: string[];
    events?: { op: string; principal: { id: string }; target?: { name: string } }[];
    error?: { code: string; key?: string; status?: number };
  };
  return { status: res.status, json };
}

function grantsOf(draft: ReturnType<typeof compileToken>): TokenGrants {
  return {
    scopes: draft.scopes,
    boxes: draft.boxes,
    volumes: draft.volumes,
    hosts: draft.hosts,
    quotas: draft.quotas,
    audit: draft.audit,
  };
}

describe("token store", () => {
  test("stores only the hash, shows the secret once, and survives a new process without the access key", () => {
    const dir = mkdtempSync(join(tmpdir(), "minibox-tokens-"));
    const file = join(dir, "tokens.json");
    let now = 1_700_000_000_000;
    const secrets: string[] = [];
    const store = new TokenStore({ file, now: () => now, secrets: { add: (secret) => secrets.push(secret) } });
    try {
      const created = store.create(compileToken({ name: "ci", preset: "readonly", expiresInSec: 60 }), "owner");
      expect(created.secret.startsWith("mbx_")).toBe(true);
      expect(created.record.prefix).toBe(created.secret.slice(0, 12));
      expect(secrets).toEqual([created.secret]);
      const text = readFileSync(file, "utf8");
      expect(text).not.toContain(created.secret);
      expect(text).toContain(sha256(created.secret));
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(store.list().some((item) => JSON.stringify(item).includes(created.secret))).toBe(false);

      const again = store.create(compileToken({ name: "ci", preset: "readonly" }), "owner");
      expect(again).toBeUndefined();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(409);
      expect((e as AppError).key).toBe("token_name_taken");
    }
    const live = store.list().filter((item) => item.revokedAt === null);
    expect(live).toHaveLength(1);
    const secret = secrets[0] ?? "";
    expect(store.authenticate(secret, "203.0.113.4")?.id).toBe(live[0]?.id);
    expect(store.list()[0]?.lastUsedIp).toBe("203.0.113.4");

    now += 61_000;
    expect(store.authenticate(secret, "203.0.113.4")).toBeNull();
    expect(store.list()[0]?.revokedAt).toBeNull();
    store.stop();

    const restored = new TokenStore({ file, now: () => now });
    try {
      expect(restored.authenticate(secret, "203.0.113.4")).toBeNull();
      expect(restored.list()).toHaveLength(1);
    } finally {
      restored.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("revoke is immediate and a second revoke is not found; expiry is not revocation", () => {
    const dir = mkdtempSync(join(tmpdir(), "minibox-tokens-"));
    const file = join(dir, "tokens.json");
    const store = new TokenStore({ file });
    try {
      const created = store.create(compileToken({ name: "once", preset: "operator" }), "owner");
      let ended = false;
      store.watch(created.record.id, () => {
        ended = true;
      });
      expect(store.revoke(created.record.id)?.revokedAt).toEqual(expect.any(String));
      expect(ended).toBe(true);
      expect(store.authenticate(created.secret, "127.0.0.1")).toBeNull();
      expect(store.revoke(created.record.id)).toBeNull();
      expect(readFileSync(file, "utf8")).not.toContain(created.secret);
    } finally {
      store.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a rate limit counts uses and answers 429 without hiding a revoked token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minibox-tokens-"));
    const store = new TokenStore({ file: join(dir, "tokens.json") });
    try {
      const created = store.create(
        compileToken({ name: "fast", scopes: ["box:read"], quotas: { rateLimit: 2, rateWindowSec: 60 } }),
        "owner",
      );
      expect(store.authenticate(created.secret, "127.0.0.1")?.name).toBe("fast");
      expect(store.authenticate(created.secret, "127.0.0.1")?.name).toBe("fast");
      const error = await rejectionOf(Promise.resolve().then(() => store.authenticate(created.secret, "127.0.0.1")));
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).status).toBe(429);
      expect(store.revoke(created.record.id)).not.toBeNull();
      expect(store.authenticate(created.secret, "127.0.0.1")).toBeNull();
    } finally {
      store.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("presets and file access", () => {
  test("presets compile to the documented scopes, and naming a volume adds volume:attach", () => {
    const readonly = compileToken({ name: "r", preset: "readonly" });
    expect(readonly.scopes).toEqual(["box:read", "files:read"]);
    expect(readonly.boxes).toEqual({ type: "created-by-me" });
    expect(readonly.volumes).toEqual({ type: "list", names: [] });
    expect(readonly.audit).toBe("scoped");

    const sandbox = compileToken({ name: "s", preset: "sandboxed-agent" });
    expect(sandbox.scopes).not.toContain("volume:attach");
    expect(sandbox.scopes).not.toContain("tool:install");
    expect(sandbox.quotas).toMatchObject({
      maxBoxes: 5,
      maxCpus: 8,
      maxMemoryMb: 16_384,
      maxTtlSec: 14_400,
      rateLimit: 60,
    });

    const named = compileToken({ name: "v", preset: "readonly", volumes: { type: "list", names: ["data"] } });
    expect(named.scopes).toContain("volume:attach");

    const admin = compileToken({ name: "a", preset: "admin" });
    expect(admin.audit).toBe("all");
    expect(admin.boxes).toEqual({ type: "all" });
    const narrowed = compileToken({ name: "a2", preset: "admin", scopes: ["box:read"] });
    expect(narrowed.audit).toBe("scoped");
  });

  test("exec implies read and write on every mount of a visible box; files:* applies only without exec", () => {
    const exec = grantsOf(compileToken({ name: "e", scopes: ["exec"] }));
    const reader = grantsOf(compileToken({ name: "f", scopes: ["files:read"] }));
    const mine = { boxId: "bx_1", name: "mine", createdBy: "tok_1", labels: {} };
    const execPrincipal = { type: "token" as const, id: "tok_1", grants: exec };
    expect(fileAccess(execPrincipal, mine)).toEqual({ read: true, write: true });
    expect(canExec(execPrincipal, mine)).toBe(true);
    expect(fileAccess(execPrincipal, { ...mine, createdBy: "owner" })).toEqual({ read: false, write: false });
    expect(canExec({ type: "token", id: "tok_1", grants: reader }, mine)).toBe(false);
    expect(fileAccess({ type: "token", id: "tok_1", grants: reader }, mine)).toEqual({ read: true, write: false });
    expect(fileAccess(OWNER, mine)).toEqual({ read: true, write: true });
  });
});

describe("HTTP tokens", () => {
  test("a created-by-me token cannot see or change boxes it did not create, and revoke is immediate", async () => {
    const { app, base } = start();
    const ownerBox = await call(base, "/api/boxes", { body: { name: "hidden", cpus: 1, memoryMb: 256 } });
    expect(ownerBox.status).toBe(201);

    const created = await call(base, "/api/tokens", { body: { name: "agent", preset: "sandboxed-agent" } });
    expect(created.status).toBe(201);
    const secret = created.json.token ?? "";
    const id = created.json.record?.id ?? "";
    expect(secret.startsWith("mbx_")).toBe(true);
    expect(readFileSync(join(app.cfg.dataDir, "tokens.json"), "utf8")).not.toContain(secret);

    const listed = await call(base, "/api/tokens");
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.json)).not.toContain(secret);
    expect(listed.json.tokens?.[0]?.prefix).toBe(secret.slice(0, 12));

    const hidden = await call(base, "/api/boxes", { token: secret });
    expect(hidden.status).toBe(200);
    expect(hidden.json.boxes).toEqual([]);
    const denied = await call(base, `/api/boxes/${ownerBox.json.box?.id}`, { token: secret });
    expect(denied.status).toBe(403);
    expect(denied.json.error?.key).toBe("box_out_of_scope");

    const own = await call(base, "/api/boxes", { token: secret, body: { name: "mine", cpus: 1, memoryMb: 256 } });
    expect(own.status).toBe(201);
    expect(own.json.box?.createdBy).toBe(id);
    expect(own.json.box?.ttlSec).toBe(14_400);
    const seen = await call(base, "/api/boxes", { token: secret });
    expect(seen.json.boxes?.map((box) => box.name)).toEqual(["mine"]);

    const overTtl = await call(base, "/api/boxes", {
      token: secret,
      body: { name: "long", cpus: 1, memoryMb: 256, ttlSec: 14_401 },
    });
    expect(overTtl.status).toBe(403);
    expect(overTtl.json.error?.key).toBe("quota_ttl");
    const clearTtl = await call(base, "/api/boxes", {
      token: secret,
      body: { name: "forever", cpus: 1, memoryMb: 256, ttlSec: null },
    });
    expect(clearTtl.status).toBe(403);
    expect(clearTtl.json.error?.key).toBe("quota_ttl");

    const minted = await call(base, "/api/tokens", { token: secret, body: { name: "child", preset: "admin" } });
    expect(minted.status).toBe(403);
    expect(minted.json.error?.key).toBe("operation_forbidden");

    const events = await call(base, "/api/events?limit=50", { token: secret });
    expect(events.status).toBe(200);
    const creates = (events.json.events ?? []).filter((event) => event.op === "box.create");
    expect(creates.some((event) => event.target?.name === "mine" && event.principal.id === id)).toBe(true);
    expect(creates.some((event) => event.target?.name === "hidden" && event.principal.id === "owner")).toBe(false);
    expect(JSON.stringify(events.json)).not.toContain(secret);

    const revoked = await call(base, `/api/tokens/${id}?deleteCreated=true`, { method: "DELETE" });
    expect(revoked.status).toBe(200);
    expect(revoked.json.deletedBoxes).toEqual(["mine"]);
    const revokedToken = revoked.json as { token?: TokenRecord };
    expect(revokedToken.token?.revokedAt).toEqual(expect.any(String));
    const after = await call(base, "/api/boxes", { token: secret });
    expect(after.status).toBe(401);
    const again = await call(base, `/api/tokens/${id}`, { method: "DELETE" });
    expect(again.status).toBe(404);
    const gone = await call(base, `/api/boxes/${own.json.box?.id}`);
    expect(gone.status).toBe(404);
  });

  test("quotas count the token's boxes, and a missing volume:attach cannot reuse a volume", async () => {
    const { runtime, base } = start();
    runtime.volumes.set("mbtest-ws-reuse", { name: "mbtest-ws-reuse", labels: {} });
    const created = await call(base, "/api/tokens", {
      body: {
        name: "tight",
        preset: "sandboxed-agent",
        quotas: { maxBoxes: 1, maxCpus: 2, maxMemoryMb: 512, rateLimit: null },
      },
    });
    const secret = created.json.token ?? "";
    const first = await call(base, "/api/boxes", { token: secret, body: { name: "one", cpus: 1.5, memoryMb: 256 } });
    expect(first.status).toBe(201);
    const second = await call(base, "/api/boxes", { token: secret, body: { name: "two", cpus: 1, memoryMb: 256 } });
    expect(second.status).toBe(403);
    expect(second.json.error?.key).toBe("quota_boxes");

    const wider = await call(base, "/api/tokens", {
      body: { name: "cpus", preset: "sandboxed-agent", quotas: { maxBoxes: null, maxCpus: 2, rateLimit: null } },
    });
    const cpuSecret = wider.json.token ?? "";
    expect(
      (await call(base, "/api/boxes", { token: cpuSecret, body: { name: "cpu-a", cpus: 1.5, memoryMb: 256 } })).status,
    ).toBe(201);
    const overCpu = await call(base, "/api/boxes", {
      token: cpuSecret,
      body: { name: "cpu-b", cpus: 1, memoryMb: 256 },
    });
    expect(overCpu.status).toBe(403);
    expect(overCpu.json.error?.key).toBe("quota_cpus");

    const reused = await call(base, "/api/boxes", { token: secret, body: { name: "reuse", cpus: 1, memoryMb: 256 } });
    expect(reused.status).toBe(403);
    expect(reused.json.error?.key).toBe("volume_not_granted");

    const attached = await call(base, "/api/tokens", {
      body: { name: "mount", preset: "operator", volumes: ["mbtest-ws-reuse"] },
    });
    expect(attached.json.record?.scopes).toContain("volume:attach");
    const ok = await call(base, "/api/boxes", {
      token: attached.json.token,
      body: { name: "reuse", cpus: 1, memoryMb: 256 },
    });
    expect(ok.status).toBe(201);

    const paced = await call(base, "/api/tokens", {
      body: { name: "paced", scopes: ["box:read"], quotas: { rateLimit: 2, rateWindowSec: 60 } },
    });
    const pace = paced.json.token ?? "";
    expect((await call(base, "/api/boxes", { token: pace })).status).toBe(200);
    expect((await call(base, "/api/boxes", { token: pace })).status).toBe(200);
    const limited = await call(base, "/api/boxes", { token: pace });
    expect(limited.status).toBe(429);
    expect(limited.json.error?.key).toBe("token_rate_limited");

    const elsewhere = await call(base, "/api/tokens", {
      body: { name: "remote", scopes: ["box:read"], hosts: ["other"] },
    });
    const remote = await call(base, "/api/boxes", { token: elsewhere.json.token });
    expect(remote.status).toBe(403);
    expect(remote.json.error?.key).toBe("host_not_granted");
  });

  test("an explicit mount is refused without volume:attach, and granted when the volume is named", async () => {
    const { app } = start();
    const update = OPERATIONS.find((op) => op.name === "box.update");
    if (!update) throw new Error("box.update missing");
    const denied = app.tokens.create(compileToken({ name: "plain", scopes: ["box:write"] }), "owner");
    const allowed = app.tokens.create(
      compileToken({ name: "vols", scopes: ["box:write"], volumes: { type: "list", names: ["foreign"] } }),
      "owner",
    );
    const principal = app.tokens.authenticate(denied.secret, "127.0.0.1");
    const granted = app.tokens.authenticate(allowed.secret, "127.0.0.1");
    if (!principal || !granted) throw new Error("token did not authenticate");
    const missing = await rejectionOf(
      authorizeOperation({
        principal,
        operation: update,
        phase: "access",
        host: app.hosts.get(),
        input: { mounts: [{ volume: "foreign" }], volumes: ["other"], volume: "third" },
      }),
    );
    expect(missing).toBeInstanceOf(AppError);
    expect((missing as AppError).key).toBe("volume_not_granted");
    expect(
      await authorizeOperation({
        principal: granted,
        operation: update,
        phase: "access",
        host: app.hosts.get(),
        input: { mounts: [{ volume: "foreign" }] },
      }),
    ).toBe(true);
  });

  test("ids and tags select boxes, and a snapshot of an unseen box cannot be forked or deleted", async () => {
    const { base } = start();
    const created = await call(base, "/api/boxes", { body: { name: "alpha", cpus: 1, memoryMb: 256 } });
    const id = created.json.box?.id ?? "";
    const tag = await fetch(`${base}/api/boxes/${id}`, {
      method: "PATCH",
      headers: ownerHeaders({ "content-type": "application/json", "if-match": "1" }),
      body: JSON.stringify({ labels: { env: "prod" } }),
    });
    expect(tag.status).toBe(200);

    const byId = await call(base, "/api/tokens", {
      body: { name: "ids", preset: "readonly", boxes: { ids: ["alpha"] } },
    });
    const seen = await call(base, "/api/boxes/alpha", { token: byId.json.token });
    expect(seen.status).toBe(200);
    const byTag = await call(base, "/api/tokens", {
      body: { name: "tags", preset: "readonly", boxes: { tags: ["env=prod"] } },
    });
    expect((await call(base, "/api/boxes", { token: byTag.json.token })).json.boxes?.map((box) => box.name)).toEqual([
      "alpha",
    ]);

    const snap = await call(base, `/api/boxes/${id}/snapshots`, { body: { name: "nightly" } });
    expect(snap.status).toBe(201);
    const ref = (snap.json as { snapshot?: { ref?: string } }).snapshot?.ref ?? "";
    const agent = await call(base, "/api/tokens", { body: { name: "forker", preset: "sandboxed-agent" } });
    const secret = agent.json.token ?? "";
    expect((await call(base, "/api/snapshots", { token: secret })).json.snapshots).toEqual([]);
    const fork = await call(base, `/api/snapshots/${encodeURIComponent(ref)}/boxes`, {
      token: secret,
      body: { name: "copy", cpus: 1, memoryMb: 256 },
    });
    expect(fork.status).toBe(403);
    expect(fork.json.error?.key).toBe("snapshot_out_of_scope");
    const removed = await call(base, `/api/snapshots/${encodeURIComponent(ref)}`, { method: "DELETE", token: secret });
    expect(removed.status).toBe(403);

    const broad = await call(base, "/api/tokens", { body: { name: "all", preset: "readonly", boxes: "*" } });
    expect((await call(base, "/api/boxes", { token: broad.json.token })).json.boxes?.map((box) => box.name)).toEqual([
      "alpha",
    ]);
  });

  test("the owner reads the whole event log and an admin token does too; a token without box:read cannot stream", async () => {
    const { base } = start();
    await call(base, "/api/boxes", { body: { name: "alpha", cpus: 1, memoryMb: 256 } });
    const admin = await call(base, "/api/tokens", { body: { name: "root", preset: "admin" } });
    const events = await call(base, "/api/events?op=box.create", { token: admin.json.token });
    expect(events.json.events?.some((event) => event.target?.name === "alpha")).toBe(true);
    const execOnly = await call(base, "/api/tokens", { body: { name: "shell", scopes: ["exec"] } });
    const stream = await fetch(`${base}/api/events/stream`, {
      headers: { authorization: `Bearer ${execOnly.json.token}` },
    });
    expect(stream.status).toBe(403);
    await stream.body?.cancel();
  });
});
