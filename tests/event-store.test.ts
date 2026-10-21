import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRedactor, REDACTED } from "../src/events/redact";
import { DETAIL_MAX_BYTES, EventStore, tierOf } from "../src/events/store";
import type { EventInput } from "../src/events/types";
import { ulid } from "../src/events/ulid";

const SECRET = "access-key-0123456789-secret";
const NOW = 1_750_000_000_000;
const MINUTE = 60_000;
const DAY = 86_400_000;

function input(overrides: Partial<EventInput> = {}): EventInput {
  return {
    id: ulid(),
    ts: NOW,
    durationMs: 3,
    status: "ok",
    op: "box.create",
    kind: "write",
    principal: { type: "owner", id: "owner", name: "owner" },
    source: "rest",
    hostId: "local",
    summary: "Create and start a box: alpha",
    target: { kind: "box", id: "c0ffee", name: "alpha" },
    ...overrides,
  };
}

const denied = () => read({ status: "denied", error: { code: "forbidden", status: 403 } });

const read = (overrides: Partial<EventInput> = {}) =>
  input({
    kind: "read",
    op: "box.get",
    summary: "Get one box",
    target: { kind: "box", id: "c0ffee", name: "alpha" },
    ...overrides,
  });

describe("EventStore", () => {
  let dir: string;
  let store: EventStore | undefined;

  const open = (path = ":memory:") => {
    store = new EventStore(path, createRedactor({ knownSecrets: [SECRET] }));
    return store;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "minibox-events-"));
  });

  afterEach(() => {
    store?.close();
    store = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  test("an appended event comes back with its cursor, tier and count", () => {
    const s = open();
    const { event, merged } = s.append(input());
    expect(merged).toBe(false);
    expect(event).toMatchObject({ seq: 1, op: "box.create", tier: "audit", count: 1, target: { name: "alpha" } });
    expect(s.list({}, { limit: 10 })).toEqual({ events: [event], nextCursor: null });
    expect(s.head()).toBe(1);
  });

  test("the head is 0 for an empty store", () => {
    expect(open().head()).toBe(0);
  });

  test("pages run newest first, and every event appears on exactly one page", () => {
    const s = open();
    for (let i = 0; i < 25; i++) s.append(input({ summary: `event ${i}` }));
    const seen: number[] = [];
    let before: number | undefined;
    for (;;) {
      const page = s.list({}, { before, limit: 10 });
      seen.push(...page.events.map((e) => e.seq));
      if (page.nextCursor === null) break;
      before = page.nextCursor;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen).toEqual(seen.toSorted((a, b) => b - a));
  });

  test("filters narrow by box id or name, principal, operation, status, run and time", () => {
    const s = open();
    const a = s.append(input({ target: { kind: "box", id: "c1", name: "alpha" }, run: "r1" })).event;
    const b = s.append(
      input({
        op: "box.action",
        status: "error",
        ts: NOW + 1,
        target: { kind: "box", id: "c2", name: "beta" },
        error: { code: "not_found", status: 404 },
      }),
    ).event;
    const c = s.append(
      input({
        op: "snapshot.create",
        ts: NOW + 2,
        principal: { type: "owner", id: "other", name: "other" },
        target: { kind: "snapshot", name: "alpha" },
      }),
    ).event;
    const d = s.append(input({ run: "r2", target: undefined, op: "template.build", ts: NOW + 3 })).event;
    const ids = (filter: Parameters<EventStore["list"]>[0]) =>
      s
        .list(filter, { limit: 50 })
        .events.map((e) => e.seq)
        .toSorted((x, y) => x - y);

    expect(ids({ box: "alpha" })).toEqual([a.seq]);
    expect(ids({ box: "c2" })).toEqual([b.seq]);
    expect(ids({ principal: "other" })).toEqual([c.seq]);
    expect(ids({ op: "box.action" })).toEqual([b.seq]);
    expect(ids({ status: "error" })).toEqual([b.seq]);
    expect(ids({ run: "r1" })).toEqual([a.seq]);
    expect(ids({ since: NOW + 1 })).toEqual([b.seq, c.seq, d.seq]);
    expect(ids({ box: "alpha", op: "box.create", since: NOW })).toEqual([a.seq]);
  });

  test("after() returns the events beyond a cursor, oldest first, for resuming a stream", () => {
    const s = open();
    const first = s.append(input()).event;
    const second = s.append(input({ status: "error", error: { code: "x", status: 500 } })).event;
    const third = s.append(input({ principal: { type: "owner", id: "other", name: "other" } })).event;
    expect(s.after(first.seq, {}, 10).map((e) => e.seq)).toEqual([second.seq, third.seq]);
    expect(s.after(first.seq, { status: "error" }, 10).map((e) => e.seq)).toEqual([second.seq]);
    expect(s.after(third.seq, {}, 10)).toEqual([]);
    expect(s.after(0, {}, 1).map((e) => e.seq)).toEqual([first.seq]);
  });

  test("reads of one principal, operation and target share one row per minute", () => {
    const s = open();
    const first = s.append(read({ ts: NOW }));
    const second = s.append(read({ ts: NOW + 1_000 }));
    expect(first.merged).toBe(false);
    expect(second.merged).toBe(true);
    expect(second.event.seq).toBe(first.event.seq);
    expect(second.event.count).toBe(2);
    expect(first.event.tier).toBe("activity");

    const nextMinute = s.append(read({ ts: NOW + MINUTE }));
    const otherPrincipal = s.append(read({ ts: NOW + 2_000, principal: { type: "owner", id: "other", name: "o" } }));
    expect(nextMinute.merged).toBe(false);
    expect(otherPrincipal.merged).toBe(false);
    expect(s.list({}, { limit: 10 }).events.map((e) => e.count)).toEqual([1, 1, 2]);
  });

  test("exec events stay on the activity tier and are not merged", () => {
    const s = open();
    const finish = () => input({ op: "exec.finish", kind: "write", status: "ok", summary: "Exec finished: alpha" });
    expect(tierOf(finish())).toBe("activity");
    expect(tierOf(input({ op: "exec.start", kind: "write", status: "started" }))).toBe("activity");
    expect(tierOf(input({ op: "exec.run", status: "denied" }))).toBe("audit");
    expect(s.append(finish()).merged).toBe(false);
    expect(s.append(finish()).merged).toBe(false);
    expect(s.list({ op: "exec.finish" }, { limit: 10 }).events).toHaveLength(2);
    expect(s.append(read()).merged).toBe(false);
    expect(s.append(read()).merged).toBe(true);
  });

  test("session sends, terminal and container events are activity and never merged", () => {
    const s = open();
    const activity = [
      "session.start",
      "session.send",
      "session.close",
      "terminal.open",
      "terminal.close",
      "container.oom",
    ];
    for (const op of activity) {
      expect({ op, tier: tierOf(input({ op, kind: "write", status: "ok" })) }).toEqual({ op, tier: "activity" });
    }
    expect(tierOf(input({ op: "session.takeover", kind: "write", status: "ok" }))).toBe("audit");
    expect(tierOf(input({ op: "session.release", kind: "write", status: "ok" }))).toBe("audit");
    expect(tierOf(input({ op: "session.send", kind: "write", status: "denied" }))).toBe("audit");
    expect(s.append(input({ op: "session.send", kind: "write", status: "ok" })).merged).toBe(false);
    expect(s.append(input({ op: "session.send", kind: "write", status: "ok" })).merged).toBe(false);
  });

  test("denied operations and changes are audited one by one, never merged", () => {
    const s = open();
    expect(tierOf(denied())).toBe("audit");
    expect(s.append(denied()).merged).toBe(false);
    expect(s.append(denied()).merged).toBe(false);
    expect(s.append(input()).merged).toBe(false);
    expect(s.append(input()).merged).toBe(false);
    const events = s.list({}, { limit: 10 }).events;
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.tier === "audit" && e.count === 1)).toBe(true);
  });

  test("a detail larger than the cap is stored as a note with its size", () => {
    const s = open();
    const { event } = s.append(input({ detail: { blob: "x".repeat(DETAIL_MAX_BYTES * 2) } }));
    expect(event.detail).toMatchObject({ truncated: true });
    expect((event.detail as { bytes: number }).bytes).toBeGreaterThan(DETAIL_MAX_BYTES);
  });

  test("secrets never reach the database file, its WAL, or what is read back", () => {
    const path = join(dir, "events.db");
    const s = open(path);
    s.append(
      input({
        summary: `created with ${SECRET}`,
        principal: { type: "owner", id: "owner", name: `owner ${SECRET}` },
        run: "run-1",
        detail: {
          password: "hunter2",
          note: `token ${SECRET} and sk-abcdefghijklmnop0123 and Bearer abcdefghijkl12`,
          env: { DATABASE_URL: "postgres://u:p@h/db" },
        },
      }),
    );
    const walBefore = readFileSync(`${path}-wal`, "latin1");
    s.close();
    store = undefined;
    const persisted = readdirSync(dir)
      .filter((name) => name.startsWith("events.db"))
      .map((name) => readFileSync(join(dir, name), "latin1"))
      .join("\n");
    for (const text of [persisted, walBefore]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("sk-abcdefghijklmnop0123");
      expect(text).not.toContain("abcdefghijkl12");
      expect(text).not.toContain("postgres://u:p@h/db");
      expect(text).toContain(REDACTED);
    }
    const reopened = open(path);
    const [event] = reopened.list({}, { limit: 1 }).events;
    expect(event).toMatchObject({
      summary: `created with ${REDACTED}`,
      principal: { name: `owner ${REDACTED}` },
      detail: { password: REDACTED, env: ["DATABASE_URL"] },
    });
  });

  test("a file database runs in WAL mode and keeps its events across a restart, without migrating twice", () => {
    const path = join(dir, "events.db");
    const first = open(path);
    expect(first.append(input()).event.seq).toBe(1);
    first.close();
    store = undefined;

    const raw = new Database(path, { readonly: true });
    expect(raw.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(1);
    raw.close();

    const again = open(path);
    expect(again.list({}, { limit: 10 }).events).toHaveLength(1);
    expect(again.append(input()).event.seq).toBe(2);
    expect(again.head()).toBe(2);
    const probe = new Database(path, { readonly: true });
    expect(probe.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    probe.close();
    expect(existsSync(path)).toBe(true);
  });

  test("pruning removes each tier once its own window has passed, and keeps the rest", () => {
    const s = open();
    const oldAudit = s.append(input({ ts: NOW - 400 * DAY })).event;
    const recentAudit = s.append(input({ ts: NOW - 100 * DAY })).event;
    const oldRead = s.append(read({ ts: NOW - 40 * DAY })).event;
    const recentRead = s.append(read({ op: "box.list", ts: NOW - 5 * DAY })).event;

    expect(s.prune(NOW, { auditMs: 365 * DAY, activityMs: 30 * DAY })).toBe(2);
    const kept = s
      .list({}, { limit: 10 })
      .events.map((e) => e.seq)
      .toSorted((a, b) => a - b);
    expect(kept).toEqual([recentAudit.seq, recentRead.seq].toSorted((a, b) => a - b));
    expect(kept).not.toContain(oldAudit.seq);
    expect(kept).not.toContain(oldRead.seq);
  });
});
