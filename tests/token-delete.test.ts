import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HostMetrics } from "../src/host/metrics";
import { startServer } from "../src/server";
import { compileToken } from "../src/tokens/model";
import { TokenStore } from "../src/tokens/store";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";

const GB = 1024 ** 3;

interface Body {
  token?: string | { id: string; name: string };
  record: { id: string };
  tokens?: { id: string }[];
  deleted?: { id: string; name: string }[];
  error?: { key?: string; params?: Record<string, string> };
  events: {
    op: string;
    target?: { kind: string; id?: string; name: string };
    detail?: { count: number; deleted: { id: string; name: string }[] };
  }[];
}
const DAY_MS = 86_400_000;

interface Handle {
  store: TokenStore;
  file: string;
  clock: { now: number };
  done: () => void;
}

function openStore(): Handle {
  const dir = mkdtempSync(join(tmpdir(), "minibox-token-delete-"));
  const file = join(dir, "tokens.json");
  const clock = { now: Date.parse("2026-01-01T00:00:00Z") };
  const store = new TokenStore({ file, now: () => clock.now });
  return {
    store,
    file,
    clock,
    done: () => {
      store.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function mint(handle: Handle, name: string, expiresInSec: number | null = null) {
  const draft = { ...compileToken({ name, preset: "readonly" }), expiresInSec };
  return handle.store.create(draft, "owner").record;
}

const storedIds = (file: string) =>
  (JSON.parse(readFileSync(file, "utf8")) as { tokens: { id: string }[] }).tokens.map((token) => token.id);

describe("TokenStore.remove", () => {
  test("a revoked token's record is deleted and stays deleted after a restart", () => {
    const handle = openStore();
    try {
      const keep = mint(handle, "keep");
      const gone = mint(handle, "gone");
      handle.store.revoke(gone.id);
      const result = handle.store.remove(gone.id);
      expect(result).toMatchObject({ status: "removed", token: { id: gone.id, name: "gone" } });
      expect(handle.store.list().map((token) => token.id)).toEqual([keep.id]);
      expect(storedIds(handle.file)).toEqual([keep.id]);
      const reopened = new TokenStore({ file: handle.file, now: () => handle.clock.now });
      try {
        expect(reopened.list().map((token) => token.id)).toEqual([keep.id]);
      } finally {
        reopened.stop();
      }
    } finally {
      handle.done();
    }
  });

  test("an expired token can be deleted, before and after the sweep noticed", () => {
    const handle = openStore();
    try {
      const swept = mint(handle, "swept", DAY_MS / 1000);
      const unswept = mint(handle, "unswept", DAY_MS / 1000);
      handle.clock.now += 2 * DAY_MS;
      handle.store.sweep();
      expect(handle.store.remove(swept.id).status).toBe("removed");
      expect(handle.store.remove(unswept.id).status).toBe("removed");
      expect(handle.store.list()).toEqual([]);
    } finally {
      handle.done();
    }
  });

  test("a live token is refused and keeps working, and an unknown id is missing", () => {
    const handle = openStore();
    try {
      const draft = compileToken({ name: "live", preset: "readonly" });
      const { secret, record } = handle.store.create(draft, "owner");
      expect(handle.store.remove(record.id)).toMatchObject({ status: "live", token: { id: record.id, name: "live" } });
      expect(handle.store.list()).toHaveLength(1);
      expect(handle.store.authenticate(secret, "127.0.0.1")).not.toBeNull();
      expect(handle.store.remove("tok_unknown")).toEqual({ status: "missing" });
    } finally {
      handle.done();
    }
  });
});

describe("TokenStore.prune", () => {
  test("deletes every revoked and expired token, and never a live one", () => {
    const handle = openStore();
    try {
      const live = mint(handle, "live");
      const soon = mint(handle, "soon", DAY_MS / 1000);
      const revoked = mint(handle, "revoked");
      handle.store.revoke(revoked.id);
      handle.clock.now += 2 * DAY_MS;
      const removed = handle.store.prune();
      expect(removed.map((token) => token.name).toSorted()).toEqual(["revoked", "soon"]);
      expect(removed.map((token) => token.id)).not.toContain(live.id);
      expect(handle.store.list().map((token) => token.id)).toEqual([live.id]);
      expect(storedIds(handle.file)).toEqual([live.id]);
      expect(soon.id).not.toBe(live.id);
      expect(handle.store.prune()).toEqual([]);
    } finally {
      handle.done();
    }
  });
});

describe("token deletion over HTTP", () => {
  let stop: (() => void) | undefined;
  const restoreLogs = silenceLogs();
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  function start() {
    const { app, runtime } = createTestApp({ labelPrefix: "mbtest" });
    const keys = app.hosts.get().keys;
    runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    app.monitor.snapshot = async () => ({ cpu: { cores: 64 }, memory: { total: 64 * GB } }) as unknown as HostMetrics;
    const server = startServer(app);
    stop = () => {
      server.stop(true);
      app.throttle.stop();
      app.sessions.stop();
      app.tokens.stop();
      app.events.close();
      restoreLogs();
    };
    const base = `http://127.0.0.1:${server.port}`;
    const call = async (path: string, method: string, body?: unknown, token = TEST_KEY) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Body };
    };
    return { app, call };
  }

  test("a live token must be revoked first, then deleting it works once and the log keeps its name and id", async () => {
    const { call } = start();
    const created = await call("/api/tokens", "POST", { name: "ci", preset: "readonly" });
    const id = created.json.record.id as string;
    const secret = created.json.token as string;

    const refused = await call(`/api/tokens/${id}/record`, "DELETE");
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatchObject({ key: "token_delete_live", params: { name: "ci" } });
    expect((await call("/api/tokens", "GET")).json.tokens).toHaveLength(1);
    expect((await call("/api/boxes", "GET", undefined, secret)).status).toBe(200);

    expect((await call(`/api/tokens/${id}`, "DELETE")).status).toBe(200);
    const deleted = await call(`/api/tokens/${id}/record`, "DELETE");
    expect(deleted.status).toBe(200);
    expect(deleted.json.token).toMatchObject({ id, name: "ci" });
    expect((await call("/api/tokens", "GET")).json.tokens).toEqual([]);
    expect((await call(`/api/tokens/${id}/record`, "DELETE")).status).toBe(404);
    expect((await call("/api/boxes", "GET", undefined, secret)).status).toBe(401);

    const events = (await call("/api/events?limit=50", "GET")).json.events as {
      op: string;
      outcome?: string;
      target?: { kind: string; id?: string; name: string };
    }[];
    const wanted = events.filter((event) => event.op === "token.delete" && event.target?.id === id);
    expect(wanted.map((event) => event.target)).toContainEqual({ kind: "token", id, name: "ci" });
    expect(events.some((event) => event.op === "token.revoke" && event.target?.name === "ci")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  test("a token cannot delete or prune tokens, even with every scope", async () => {
    const { call } = start();
    const admin = await call("/api/tokens", "POST", { name: "admin", preset: "admin" });
    const other = await call("/api/tokens", "POST", { name: "other", preset: "readonly" });
    const secret = admin.json.token as string;
    await call(`/api/tokens/${other.json.record.id}`, "DELETE");
    const deleted = await call(`/api/tokens/${other.json.record.id}/record`, "DELETE", undefined, secret);
    expect(deleted.status).toBe(403);
    const pruned = await call("/api/tokens/prune", "POST", {}, secret);
    expect(pruned.status).toBe(403);
    expect((await call("/api/tokens", "GET")).json.tokens).toHaveLength(2);
  });

  test("prune deletes the ended tokens, leaves the live one, and records the names without a secret", async () => {
    const { call } = start();
    const keep = await call("/api/tokens", "POST", { name: "keep", preset: "readonly" });
    const a = await call("/api/tokens", "POST", { name: "old-a", preset: "readonly" });
    const b = await call("/api/tokens", "POST", { name: "old-b", preset: "readonly" });
    await call(`/api/tokens/${a.json.record.id}`, "DELETE");
    await call(`/api/tokens/${b.json.record.id}`, "DELETE");

    const pruned = await call("/api/tokens/prune", "POST", {});
    expect(pruned.status).toBe(200);
    expect((pruned.json.deleted as { name: string }[]).map((token) => token.name).toSorted()).toEqual([
      "old-a",
      "old-b",
    ]);
    const left = (await call("/api/tokens", "GET")).json.tokens as { id: string }[];
    expect(left.map((token) => token.id)).toEqual([keep.json.record.id]);

    const events = (await call("/api/events?limit=50", "GET")).json.events as {
      op: string;
      detail?: { count: number; deleted: { id: string; name: string }[] };
    }[];
    const event = events.find((item) => item.op === "token.prune");
    expect(event?.detail?.count).toBe(2);
    expect(event?.detail?.deleted.map((token) => token.name).toSorted()).toEqual(["old-a", "old-b"]);
    expect(JSON.stringify(event)).not.toContain(keep.json.token);
    expect((await call("/api/tokens/prune", "POST", {})).json.deleted).toEqual([]);
  });
});
