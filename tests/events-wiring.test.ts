import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../src/app";
import type { StoredEvent } from "../src/events/store";
import type { OperationContext, Principal } from "../src/operations/types";
import { createTestApp, rejectionOf, silenceLogs, TEST_KEY, testConfig } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";

const OWNER: Principal = { type: "owner", id: "owner", name: "owner" };
const DAY = 24 * 60 * 60 * 1000;
const SNAPSHOT_REF = "mbtest-snap:nightly";

let restoreLogs: () => void;
beforeEach(() => {
  restoreLogs = silenceLogs();
});
afterEach(() => restoreLogs());

function setup(overrides: Parameters<typeof createTestApp>[0] = {}, hooks: Parameters<typeof createTestApp>[2] = {}) {
  const { app, runtime } = createTestApp({ labelPrefix: "mbtest", ...overrides }, undefined, hooks);
  const keys = app.hosts.get().keys;
  runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  runtime.seedImage(SNAPSHOT_REF, { [keys.snapshot]: "true" });
  const ctx: OperationContext = { host: app.hosts.get(), principal: OWNER, source: "rest" };
  return { app, runtime, ctx };
}

describe("registry operations reach the event store", () => {
  test("an execution is stored with its caller, source, target and summary, and published on the bus", async () => {
    const { app, ctx } = setup();
    const published: StoredEvent[] = [];
    app.bus.subscribe("event", (event) => published.push(event));

    await app.operations.run("box.create", ctx, { name: "alpha", cpus: 1, memoryMb: 256 });

    const { events } = app.events.list({}, { limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      op: "box.create",
      kind: "write",
      status: "ok",
      tier: "audit",
      source: "rest",
      hostId: "local",
      principal: OWNER,
      summary: "Create and start a box: alpha",
      target: { kind: "box", name: "alpha" },
      detail: { name: "alpha", cpus: 1, memoryMb: 256 },
    });
    expect(published).toEqual(events);
  });

  test("a read merged into an earlier row of the same minute is stored once and not published again", async () => {
    const { app, ctx } = setup();
    const published: StoredEvent[] = [];
    app.bus.subscribe("event", (event) => published.push(event));

    for (let i = 0; i < 3; i++) await app.operations.run("box.list", ctx, {});

    const { events } = app.events.list({ op: "box.list" }, { limit: 10 });
    expect(events.reduce((total, event) => total + event.count, 0)).toBe(3);
    expect(events.every((event) => event.tier === "activity")).toBe(true);
    expect(published).toHaveLength(events.length);
  });

  test("a refused execution is stored as denied and never reaches the engine", async () => {
    const { app, runtime, ctx } = setup({}, { authorize: () => false });
    await rejectionOf(app.operations.run("box.create", ctx, { name: "alpha", cpus: 1, memoryMb: 256 }));

    const { events } = app.events.list({ status: "denied" }, { limit: 10 });
    expect(events.map((event) => [event.op, event.tier])).toEqual([["box.create", "audit"]]);
    expect(runtime.calls).toEqual([]);
  });

  test("the access key never reaches the stored detail", async () => {
    const { app, ctx } = setup();
    await app.operations.run("template.promote", ctx, {
      ref: SNAPSHOT_REF,
      name: "silver",
      description: `copied with key ${TEST_KEY}`,
    });

    const [event] = app.events.list({ op: "template.promote" }, { limit: 1 }).events;
    expect(event?.detail).toEqual({ ref: SNAPSHOT_REF, name: "silver", description: "copied with key ***" });
    expect(JSON.stringify(app.events.list({}, { limit: 50 }).events)).not.toContain(TEST_KEY);
  });

  test("an operation still succeeds when the event store is unavailable", async () => {
    const { app, ctx } = setup();
    app.events.close();
    expect(await app.operations.run("box.list", ctx, {})).toEqual({ boxes: [] });
  });
});

describe("the event store on disk", () => {
  test("the database is created in DATA_DIR and holds no copy of the access key", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "minibox-events-"));
    try {
      const app = createApp(testConfig({ dataDir, accessKey: TEST_KEY }), "0.0.0-test", {
        runtime: new FakeRuntime(),
      });
      const ctx: OperationContext = { host: app.hosts.get(), principal: OWNER, source: "rest" };
      await app.operations.run("box.list", ctx, {});
      app.events.append({
        id: "01TESTTESTTESTTESTTESTTEST",
        ts: Date.now(),
        durationMs: 0,
        status: "ok",
        op: "box.create",
        kind: "write",
        principal: OWNER,
        source: "rest",
        hostId: "local",
        summary: `leaked ${TEST_KEY}`,
        detail: { header: `Bearer ${TEST_KEY}` },
      });
      expect(app.events.list({}, { limit: 10 }).events.map((event) => event.op)).toEqual(["box.create", "box.list"]);
      app.events.close();

      expect(existsSync(join(dataDir, "events.db"))).toBe(true);
      const files = readdirSync(dataDir).filter((name) => name.startsWith("events.db"));
      expect(files).toContain("events.db");
      for (const name of files) {
        expect(readFileSync(join(dataDir, name)).includes(TEST_KEY)).toBe(false);
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("retention", () => {
  test("pruning removes each tier once its configured window has passed", async () => {
    const { app, ctx } = setup({ eventRetentionActivityDays: 1, eventRetentionAuditDays: 2 });
    await app.operations.run("box.list", ctx, {});
    await app.operations.run("box.create", ctx, { name: "alpha", cpus: 1, memoryMb: 256 });

    app.retention.run(Date.now() + 1.5 * DAY);
    expect(app.events.list({}, { limit: 10 }).events.map((event) => event.op)).toEqual(["box.create"]);

    app.retention.run(Date.now() + 2.5 * DAY);
    expect(app.events.list({}, { limit: 10 }).events).toEqual([]);
  });
});
