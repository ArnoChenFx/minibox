import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileToken, mayManageStorage } from "../src/tokens/model";
import { TokenStore } from "../src/tokens/store";
import { silenceLogs } from "./support/app";
import { SseReader } from "./support/sse";
import { call, type Harness, mint, principalOf, startHarness } from "./support/tokens";

let h: Harness;
let restoreLogs: () => void;
beforeEach(() => {
  restoreLogs = silenceLogs();
  h = startHarness();
});
afterEach(() => {
  h.stop();
  restoreLogs();
});

const update = (id: string, body: unknown, token?: string) =>
  call(h.base, `/api/tokens/${id}`, { method: "PUT", body, token });

describe("editing agent token permissions", () => {
  test("the same secret loses exec immediately, keeps box ownership and can gain it back", async () => {
    const agent = mint(h.app, { name: "worker", preset: "operator", expiresInSec: 3600 });
    const created = await call(h.base, "/api/boxes", {
      token: agent.secret,
      body: { name: "owned", cpus: 1, memoryMb: 256 },
    });
    expect(created.status).toBe(201);
    const id = created.json.box?.boxId ?? "";
    const before = h.app.tokens.list()[0]!;
    const reply = await update(agent.id, { preset: "readonly" });
    expect(reply.status).toBe(200);
    expect(reply.json.record).toMatchObject({
      id: agent.id,
      name: before.name,
      scopes: compileToken({ name: "", preset: "readonly" }).scopes,
    });
    expect(JSON.stringify(reply.json)).not.toContain(agent.secret);
    expect(JSON.stringify(reply.json)).not.toContain("tokenHash");
    expect(h.app.tokens.list()[0]).toMatchObject({
      prefix: before.prefix,
      expiresAt: before.expiresAt,
      createdAt: before.createdAt,
      createdBy: before.createdBy,
    });
    expect((await call(h.base, `/api/boxes/${id}`, { token: agent.secret })).status).toBe(200);
    expect(
      (await call(h.base, `/api/boxes/${id}/exec`, { token: agent.secret, body: { argv: ["true"] } })).status,
    ).toBe(403);
    expect((await update(agent.id, { preset: "operator" })).status).toBe(200);
    expect(principalOf(h.app, agent.secret).grants.scopes).toContain("exec");
  });

  test("resource grants resolve box names and quotas can be explicitly removed", async () => {
    const created = await call(h.base, "/api/boxes", { body: { name: "grant-target", cpus: 1, memoryMb: 256 } });
    const id = created.json.box?.boxId ?? "";
    const agent = mint(h.app, { name: "restricted", preset: "sandboxed-agent" });
    const reply = await update(agent.id, {
      preset: "sandboxed-agent",
      scopes: ["box:read"],
      boxes: { ids: ["grant-target"] },
      volumes: ["vol_named"],
      hosts: ["local", "lab"],
      quotas: { maxBoxes: 2, maxCpus: null, maxTtlSec: null, rateLimit: null, rateWindowSec: null },
    });
    expect(reply.status).toBe(200);
    expect(principalOf(h.app, agent.secret).grants).toMatchObject({
      boxes: { type: "ids", ids: [id] },
      volumes: { type: "list", ids: ["vol_named"] },
      hosts: { type: "list", ids: ["local", "lab"] },
      scopes: ["box:read", "volume:attach"],
      quotas: { maxBoxes: 2, maxCpus: null, maxTtlSec: null, rateLimit: null },
    });
    expect((await call(h.base, `/api/boxes/${id}`, { token: agent.secret })).status).toBe(200);
    expect(
      (await update(agent.id, { scopes: ["box:read"], boxes: { tags: ["env=prod"] }, volumes: "*", hosts: "*" }))
        .status,
    ).toBe(200);
    expect(principalOf(h.app, agent.secret).grants).toMatchObject({
      boxes: { type: "tags", tags: ["env=prod"] },
      volumes: { type: "all" },
      hosts: { type: "all" },
    });
    expect((await call(h.base, `/api/boxes/${id}`, { token: agent.secret })).status).toBe(403);
  });

  test("narrowing admin removes storage authority; only an explicit full admin grant restores it", async () => {
    const admin = mint(h.app, { name: "admin", preset: "admin" });
    expect(mayManageStorage(principalOf(h.app, admin.secret))).toBe(true);
    expect(
      (await update(admin.id, { preset: "admin", scopes: ["box:read", "volume:delete"], boxes: "*", hosts: "*" }))
        .status,
    ).toBe(200);
    expect(mayManageStorage(principalOf(h.app, admin.secret))).toBe(false);
    expect((await call(h.base, "/api/pools", { token: admin.secret })).status).toBe(403);
    expect((await update(admin.id, { preset: "admin", boxes: "created-by-me" })).status).toBe(200);
    expect(mayManageStorage(principalOf(h.app, admin.secret))).toBe(false);
    expect((await update(admin.id, { preset: "admin" })).status).toBe(200);
    expect(mayManageStorage(principalOf(h.app, admin.secret))).toBe(true);
  });

  test("invalid updates are atomic, and agent tokens cannot edit even their own permissions", async () => {
    const admin = mint(h.app, { name: "admin", preset: "admin" });
    const before = h.app.tokens.list()[0];
    for (const body of [
      {},
      { scopes: [] },
      { scopes: ["unknown"] },
      { preset: "admin", hosts: [] },
      { preset: "readonly", boxes: { ids: ["does-not-exist"] } },
      { preset: "readonly", quotas: { maxBoxes: -1 } },
    ]) {
      expect((await update(admin.id, body)).status).toBe(400);
      expect(h.app.tokens.list()[0]).toEqual(before);
    }
    expect((await update(admin.id, { preset: "admin" }, admin.secret)).status).toBe(403);
    expect((await update("tok_missing", { preset: "admin" })).status).toBe(404);
    h.app.tokens.revoke(admin.id);
    expect((await update(admin.id, { preset: "admin" })).status).toBe(404);
    expect(h.app.tokens.authenticate(admin.secret, "127.0.0.1")).toBeNull();
  });

  test("a permission change closes an event stream and the same secret can reconnect", async () => {
    const agent = mint(h.app, { name: "streamer", preset: "operator" });
    const response = await fetch(`${h.base}/api/events/stream`, {
      headers: { authorization: `Bearer ${agent.secret}` },
    });
    expect(response.status).toBe(200);
    const stream = new SseReader(response.body!.getReader());
    try {
      await stream.until((frame) => frame.event === "sync");
      expect((await update(agent.id, { preset: "readonly" })).status).toBe(200);
      await stream.untilEnd();
      expect((await call(h.base, "/api/boxes", { token: agent.secret })).status).toBe(200);
    } finally {
      await stream.close();
    }
  });

  test("a connection authenticated before the update cannot register with stale permissions afterwards", () => {
    const agent = mint(h.app, { name: "racing", preset: "operator" });
    const stale = principalOf(h.app, agent.secret);
    h.app.tokens.update(agent.id, compileToken({ name: "", preset: "readonly" }));
    let staleClosed = false;
    h.app.tokens.watchPrincipal(stale, () => {
      staleClosed = true;
    });
    expect(staleClosed).toBe(true);
    let freshClosed = false;
    const stop = h.app.tokens.watchPrincipal(principalOf(h.app, agent.secret), () => {
      freshClosed = true;
    });
    expect(freshClosed).toBe(false);
    h.app.tokens.update(agent.id, compileToken({ name: "", preset: "operator" }));
    expect(freshClosed).toBe(true);
    stop();
  });

  test("updated grants survive a restart, preserve rate usage, notify watchers once and never revive expired tokens", () => {
    const dir = mkdtempSync(join(tmpdir(), "minibox-token-update-"));
    const file = join(dir, "tokens.json");
    let now = Date.now();
    const store = new TokenStore({ file, now: () => now });
    try {
      const { record, secret } = store.create(
        compileToken({ name: "persisted", preset: "admin", expiresInSec: 60 }),
        "owner",
      );
      let ended = 0;
      store.watch(record.id, () => {
        ended++;
      });
      const policy = compileToken({ name: "ignored", scopes: ["box:read"], quotas: { rateLimit: 1 } });
      expect(store.update(record.id, policy)?.id).toBe(record.id);
      expect(ended).toBe(1);
      expect(store.authenticate(secret, "local")?.grants.scopes).toEqual(["box:read"]);
      store.update(record.id, policy);
      expect(() => store.authenticate(secret, "local")).toThrow();
      expect(ended).toBe(1);
      const restored = new TokenStore({ file, now: () => now });
      try {
        expect(restored.authenticate(secret, "local")?.grants).toMatchObject({ scopes: ["box:read"], audit: "scoped" });
        expect(restored.list()[0]).toMatchObject({
          name: record.name,
          prefix: record.prefix,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
        });
      } finally {
        restored.stop();
      }
      expect(readFileSync(file, "utf8")).not.toContain(secret);
      now += 61_000;
      expect(store.update(record.id, policy)).toBeNull();
      expect(store.authenticate(secret, "local")).toBeNull();
    } finally {
      store.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
