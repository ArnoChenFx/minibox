import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { App } from "../src/app";
import type { HostMetrics } from "../src/host/metrics";
import { AppError } from "../src/lib/errors";
import { sha256 } from "../src/lib/hash";
import { startServer } from "../src/server";
import {
  canExec,
  compileToken,
  fileAccess,
  presetPolicy,
  requiredScopes,
  resolveBoxRefs,
  scopeAllowed,
  type TokenGrants,
} from "../src/tokens/model";
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

async function finishedTask(base: string, taskId: string) {
  for (;;) {
    const view = await fetch(`${base}/api/tasks/${taskId}`, { headers: ownerHeaders() });
    const json = (await view.json()) as { status: string; result?: { snapshot?: { ref?: string } } };
    if (json.status !== "running") return json;
    await Bun.sleep(5);
  }
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
    volume?: { id: string };
    taskId?: string;
    result?: { snapshot?: { ref?: string } };
    record?: TokenRecord;
    tokens?: TokenRecord[];
    box?: { id: string; boxId: string; name: string; ttlSec: number | null; createdBy: string };
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

  test("a token stored before the checkpoint limit existed loads, with no limit on its checkpoints", () => {
    const dir = mkdtempSync(join(tmpdir(), "minibox-tokens-"));
    const file = join(dir, "tokens.json");
    const store = new TokenStore({ file });
    try {
      store.create(compileToken({ name: "older", preset: "operator" }), "owner");
      store.stop();
      const stored = JSON.parse(readFileSync(file, "utf8")) as { tokens: { quotas: Record<string, unknown> }[] };
      for (const entry of stored.tokens) delete entry.quotas.maxCheckpoints;
      writeFileSync(file, JSON.stringify(stored));

      const restored = new TokenStore({ file });
      try {
        expect(restored.list()).toHaveLength(1);
        expect(restored.list()[0]?.quotas.maxCheckpoints).toBeNull();
      } finally {
        restored.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stored operator or admin token loses the volume:delete its preset no longer grants", () => {
    const dir = mkdtempSync(join(tmpdir(), "minibox-tokens-"));
    const file = join(dir, "tokens.json");
    const store = new TokenStore({ file });
    try {
      store.create(compileToken({ name: "op", preset: "operator" }), "owner");
      store.create(compileToken({ name: "adm", preset: "admin" }), "owner");
      store.create(compileToken({ name: "vol", preset: "operator", volumes: { type: "all" } }), "owner");
      store.stop();
      // The shape an older build wrote: the preset's scopes as they were, volume:delete included.
      const stored = JSON.parse(readFileSync(file, "utf8")) as { tokens: { name: string; scopes: string[] }[] };
      for (const entry of stored.tokens) entry.scopes.push("volume:delete");
      writeFileSync(file, JSON.stringify(stored));

      const restored = new TokenStore({ file });
      try {
        const scopes = (name: string) => restored.list().find((item) => item.name === name)?.scopes ?? [];
        expect(scopes("op")).not.toContain("volume:delete");
        expect(scopes("adm")).not.toContain("volume:delete");
        expect(scopes("vol")).not.toContain("volume:delete");
        // The trim keeps the rest of the preset, and the volume:attach the volume grant added.
        expect(scopes("op").toSorted()).toEqual([...presetPolicy("operator").scopes].toSorted());
        expect(scopes("adm").toSorted()).toEqual([...presetPolicy("admin").scopes].toSorted());
        expect(scopes("vol")).toContain("volume:attach");
        // The file is rewritten without it, so the next start reads a token that is already clean.
        restored.stop();
        const again = JSON.parse(readFileSync(file, "utf8")) as { tokens: { scopes: string[] }[] };
        expect(again.tokens.some((entry) => entry.scopes.includes("volume:delete"))).toBe(false);
      } finally {
        restored.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an owner's own token keeps volume:delete: no preset, or a preset the owner adjusted by hand", () => {
    const dir = mkdtempSync(join(tmpdir(), "minibox-tokens-"));
    const file = join(dir, "tokens.json");
    const store = new TokenStore({ file });
    try {
      // Named by hand, with no preset: the one way an owner grants a scope no preset holds.
      const own = store.create(compileToken({ name: "own", scopes: ["volume:read", "volume:delete"] }), "owner");
      // A preset the owner then adjusted: not exactly the preset, so it is the owner's own list.
      const edited = store.create(
        compileToken({ name: "edited", preset: "operator", scopes: ["volume:write", "volume:delete"] }),
        "owner",
      );
      store.stop();

      const restored = new TokenStore({ file });
      try {
        const scopes = (name: string) => restored.list().find((item) => item.name === name)?.scopes ?? [];
        expect(scopes("own")).toEqual(["volume:read", "volume:delete"]);
        expect(scopes("edited")).toEqual(["volume:write", "volume:delete"]);
        // It still works: the scope reaches the batch delete for both tokens.
        const principal = restored.authenticate(own.secret, "127.0.0.1");
        expect(principal?.grants?.scopes).toContain("volume:delete");
        expect(scopeAllowed(principal?.grants as TokenGrants, "volume:delete")).toBe(true);
        expect(
          scopeAllowed(restored.authenticate(edited.secret, "127.0.0.1")?.grants as TokenGrants, "volume:delete"),
        ).toBe(true);
      } finally {
        restored.stop();
      }
    } finally {
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
    expect(readonly.volumes).toEqual({ type: "list", ids: [] });
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

    const named = compileToken({ name: "v", preset: "readonly", volumes: { type: "list", ids: ["vol_data"] } });
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
    const mine = { boxId: "bx_1", name: "mine", createdBy: "tok_1", labels: {}, hostId: "local" };
    const execPrincipal = { type: "token" as const, id: "tok_1", grants: exec };
    expect(fileAccess(execPrincipal, mine)).toEqual({ read: true, write: true });
    expect(canExec(execPrincipal, mine)).toBe(true);
    expect(fileAccess(execPrincipal, { ...mine, createdBy: "owner" })).toEqual({ read: false, write: false });
    expect(canExec({ type: "token", id: "tok_1", grants: reader }, mine)).toBe(false);
    expect(fileAccess({ type: "token", id: "tok_1", grants: reader }, mine)).toEqual({ read: true, write: false });
    expect(fileAccess(OWNER, mine)).toEqual({ read: true, write: true });
  });

  test("box:exec, box:session and exec all need the exec scope, and files:* accept exec as well", () => {
    const execOnly = grantsOf(compileToken({ name: "e", scopes: ["exec"] }));
    const readOnly = grantsOf(compileToken({ name: "r", scopes: ["box:read"] }));
    for (const scope of ["box:exec", "box:session", "exec"]) {
      expect(requiredScopes(scope)).toEqual(["exec"]);
      expect(scopeAllowed(execOnly, scope)).toBe(true);
      expect(scopeAllowed(readOnly, scope)).toBe(false);
    }
    expect(requiredScopes("files:read")).toEqual(["files:read", "exec"]);
    expect(requiredScopes("files:write")).toEqual(["files:write", "exec"]);
  });

  test("tool install/upgrade/uninstall/reconcile need tool:install, not box:write (B3)", () => {
    expect(requiredScopes("tool:install")).toEqual(["tool:install"]);
    const sandbox = grantsOf(compileToken({ name: "s", preset: "sandboxed-agent" }));
    const boxWrite = grantsOf(compileToken({ name: "w", scopes: ["box:write"] }));
    const installer = grantsOf(compileToken({ name: "t", scopes: ["tool:install"] }));
    expect(scopeAllowed(sandbox, "tool:install")).toBe(false);
    expect(scopeAllowed(boxWrite, "tool:install")).toBe(false);
    expect(scopeAllowed(installer, "tool:install")).toBe(true);
  });

  test("box:ssh is its own scope: operator and admin hold it, readonly, sandboxed-agent and exec do not", () => {
    expect(requiredScopes("box:ssh")).toEqual(["box:ssh"]);
    expect(compileToken({ name: "o", preset: "operator" }).scopes).toContain("box:ssh");
    expect(compileToken({ name: "a", preset: "admin" }).scopes).toContain("box:ssh");
    expect(compileToken({ name: "s", preset: "sandboxed-agent" }).scopes).not.toContain("box:ssh");
    expect(compileToken({ name: "r", preset: "readonly" }).scopes).not.toContain("box:ssh");
    const sandbox = grantsOf(compileToken({ name: "s", preset: "sandboxed-agent" }));
    const execOnly = grantsOf(compileToken({ name: "e", scopes: ["exec"] }));
    const sshOnly = grantsOf(compileToken({ name: "h", scopes: ["box:ssh"] }));
    expect(scopeAllowed(sandbox, "box:ssh")).toBe(false);
    expect(scopeAllowed(execOnly, "box:ssh")).toBe(false);
    expect(scopeAllowed(sshOnly, "box:ssh")).toBe(true);
    expect(scopeAllowed(sshOnly, "exec")).toBe(false);
  });

  test("volume:delete is its own scope that no preset holds, volume:write is not enough, and pruning is the owner's alone", () => {
    expect(requiredScopes("volume:delete")).toEqual(["volume:delete"]);
    expect(requiredScopes("volume:prune")).toBe("owner");
    expect(compileToken({ name: "o", preset: "operator" }).scopes).not.toContain("volume:delete");
    expect(compileToken({ name: "a", preset: "admin" }).scopes).not.toContain("volume:delete");
    expect(compileToken({ name: "s", preset: "sandboxed-agent" }).scopes).not.toContain("volume:delete");
    expect(compileToken({ name: "r", preset: "readonly" }).scopes).not.toContain("volume:delete");
    const sandbox = grantsOf(compileToken({ name: "s", preset: "sandboxed-agent" }));
    const writer = grantsOf(compileToken({ name: "w", scopes: ["volume:write"] }));
    const deleter = grantsOf(compileToken({ name: "d", scopes: ["volume:delete"] }));
    expect(scopeAllowed(sandbox, "volume:delete")).toBe(false);
    expect(scopeAllowed(writer, "volume:delete")).toBe(false);
    expect(scopeAllowed(deleter, "volume:delete")).toBe(true);
  });

  test("an operation scope that no token scope covers is owner-only, including one the registry does not know", () => {
    for (const scope of ["pool:admin", "pool:read", "token:manage", "template:build", "task:write", "made:up"]) {
      expect(requiredScopes(scope)).toBe("owner");
    }
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
    expect(clearTtl.status).toBe(201);
    expect(clearTtl.json.box?.ttlSec).toBe(14_400);

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
    expect([...(revoked.json.deletedBoxes ?? [])].toSorted()).toEqual(["forever", "mine"]);
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
    const shared = await call(base, "/api/volumes", { body: { name: "shared", confirm: true } });
    expect(shared.status).toBe(201);
    const sharedId = shared.json.volume?.id ?? "";
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
    expect(reused.json.error?.key).toBe("volume_attach_forbidden");

    const attached = await call(base, "/api/tokens", {
      body: { name: "mount", preset: "operator", volumes: [sharedId] },
    });
    expect(attached.json.record?.scopes).toContain("volume:attach");
    const ok = await call(base, "/api/boxes", {
      token: attached.json.token,
      body: { name: "reuse", cpus: 1, memoryMb: 256, mounts: [{ volume: sharedId, path: "/data", mode: "ro" }] },
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
    const { base } = start();
    const made = await call(base, "/api/volumes", { body: { name: "notes", confirm: true } });
    expect(made.status).toBe(201);
    const volumeId = made.json.volume?.id ?? "";
    const plain = await call(base, "/api/tokens", { body: { name: "plain", scopes: ["box:write"] } });
    const named = await call(base, "/api/tokens", {
      body: { name: "named", scopes: ["box:write"], volumes: [volumeId] },
    });
    const mount = { volume: volumeId, path: "/data", mode: "ro" };

    const denied = await call(base, "/api/boxes", {
      token: plain.json.token,
      body: { name: "plain-box", cpus: 1, memoryMb: 256, mounts: [mount] },
    });
    expect(denied.status).toBe(403);
    expect(denied.json.error?.key).toBe("volume_attach_forbidden");

    const granted = await call(base, "/api/boxes", {
      token: named.json.token,
      body: { name: "named-box", cpus: 1, memoryMb: 256, mounts: [mount] },
    });
    expect(granted.status).toBe(201);
    expect(granted.json.box?.createdBy).toBe(named.json.record?.id);
  });

  test("a box grant by name or container id is stored as the stable id, and an unknown reference is refused", async () => {
    const { base, app } = start();
    const alpha = await call(base, "/api/boxes", { body: { name: "alpha", cpus: 1, memoryMb: 256 } });
    await call(base, "/api/boxes", { body: { name: "beta", cpus: 1, memoryMb: 256 } });
    const boxId = alpha.json.box?.boxId ?? "";
    const containerId = alpha.json.box?.id ?? "";

    const byName = await call(base, "/api/tokens", {
      body: { name: "by-name", preset: "operator", boxes: { ids: ["alpha"] } },
    });
    expect(byName.status).toBe(201);
    expect(app.tokens.list().find((token) => token.name === "by-name")?.boxes).toEqual({ type: "ids", ids: [boxId] });
    expect((await call(base, "/api/boxes", { token: byName.json.token })).json.boxes?.map((box) => box.name)).toEqual([
      "alpha",
    ]);
    expect((await call(base, "/api/boxes/alpha", { token: byName.json.token })).status).toBe(200);
    expect((await call(base, "/api/boxes/beta", { token: byName.json.token })).status).toBe(403);

    const mixed = await call(base, "/api/tokens", {
      body: { name: "mixed", preset: "operator", boxes: { ids: ["alpha", containerId, boxId] } },
    });
    expect(mixed.status).toBe(201);
    expect(app.tokens.list().find((token) => token.name === "mixed")?.boxes).toEqual({ type: "ids", ids: [boxId] });

    const missing = await call(base, "/api/tokens", {
      body: { name: "missing", preset: "operator", boxes: { ids: ["no-such-box"] } },
    });
    expect(missing.status).toBe(400);
    expect(missing.json.error?.key).toBe("token_box_unresolved");
    expect(app.tokens.list().some((token) => token.name === "missing")).toBe(false);

    const ahead = await call(base, "/api/tokens", {
      body: { name: "ahead", preset: "operator", boxes: { ids: ["bx_zzzzzzzzzz"] } },
    });
    expect(ahead.status).toBe(201);
    expect(app.tokens.list().find((token) => token.name === "ahead")?.boxes).toEqual({
      type: "ids",
      ids: ["bx_zzzzzzzzzz"],
    });
  });

  test("ids and tags select boxes, and a snapshot of an unseen box cannot be forked or deleted", async () => {
    const { base } = start();
    const created = await call(base, "/api/boxes", { body: { name: "alpha", cpus: 1, memoryMb: 256 } });
    const id = created.json.box?.id ?? "";
    const boxId = created.json.box?.boxId ?? "";
    const tag = await fetch(`${base}/api/boxes/${id}`, {
      method: "PATCH",
      headers: ownerHeaders({ "content-type": "application/json", "if-match": "1" }),
      body: JSON.stringify({ labels: { env: "prod" } }),
    });
    expect(tag.status).toBe(200);

    const byId = await call(base, "/api/tokens", {
      body: { name: "ids", preset: "readonly", boxes: { ids: [boxId] } },
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
    expect(snap.status).toBe(202);
    const ref = (await finishedTask(base, snap.json.taskId ?? "")).result?.snapshot?.ref ?? "";
    expect(ref).not.toBe("");
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

const view = (boxId: string, name: string, containerId: string) => ({
  boxId,
  containerId,
  name,
  createdBy: "owner",
  labels: {},
  hostId: "local",
  createdAt: undefined,
});

describe("resolveBoxRefs", () => {
  const views = [
    view("bx_aaaaaaaaaa", "alpha", "c1"),
    view("bx_bbbbbbbbbb", "beta", "c2"),
    view("bx_cccccccccc", "beta", "c3"),
  ];

  test("ids, container ids and unique names resolve to stable ids, once each", () => {
    expect(resolveBoxRefs(["alpha", "c1", "bx_aaaaaaaaaa", "c2"], views)).toEqual(["bx_aaaaaaaaaa", "bx_bbbbbbbbbb"]);
  });

  test("a name two boxes share, or a reference that is neither a box nor a stable id, is refused", () => {
    expect(() => resolveBoxRefs(["beta"], views)).toThrow(AppError);
    expect(() => resolveBoxRefs(["nope"], views)).toThrow(AppError);
    expect(resolveBoxRefs(["bx_zzzzzzzzzz"], views)).toEqual(["bx_zzzzzzzzzz"]);
  });
});
