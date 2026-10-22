import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setLogLevel } from "../src/lib/logger";
import { MAX_SESSIONS, SessionStore, type SessionStoreOptions } from "../src/sessions";
import { memoizeScryptSync } from "./support/scrypt";

const KEY = "k".repeat(64);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const START = Date.parse("2026-10-20T08:00:00.000Z");
const meta = { userAgent: "Mozilla/5.0 (test)", ip: "192.0.2.10" };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

let dir: string;
let file: string;
let clock: number;
let opened: SessionStore[];
let logs: string[];

beforeEach(() => {
  memoizeScryptSync();
  dir = mkdtempSync(join(tmpdir(), "minibox-sessions-"));
  file = join(dir, "sessions.json");
  clock = START;
  opened = [];
  logs = [];
  const capture = (line: unknown) => {
    logs.push(String(line));
  };
  spyOn(console, "log").mockImplementation(capture);
  spyOn(console, "error").mockImplementation(capture);
  setLogLevel("info");
});

afterEach(() => {
  for (const store of opened) store.stop();
  mock.restore();
  setLogLevel("error");
  rmSync(dir, { recursive: true, force: true });
});

function open(overrides: Partial<SessionStoreOptions> = {}): SessionStore {
  const store = new SessionStore({
    file,
    accessKey: KEY,
    ttlMs: 30 * DAY,
    idleMs: null,
    now: () => clock,
    ...overrides,
  });
  opened.push(store);
  return store;
}

const storedFile = () => JSON.parse(readFileSync(file, "utf8")) as { sessions: Record<string, unknown>[] };

describe("tokens", () => {
  test("each sign-in gets a random token of at least 32 bytes that is unrelated to the access key", () => {
    const store = open();
    const a = store.create(meta);
    const b = store.create(meta);

    expect(Buffer.from(a.token, "base64url").length).toBeGreaterThanOrEqual(32);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.token).not.toBe(KEY);
    expect(a.token).not.toContain(KEY);
    expect(a.token).not.toBe(b.token);
  });

  test("the file holds a hash of each token, never the token or the key", () => {
    const store = open();
    const { token, session } = store.create(meta);
    const text = readFileSync(file, "utf8");

    expect(text).not.toContain(token);
    expect(text).not.toContain(KEY);
    expect(storedFile().sessions).toEqual([
      {
        id: session.id,
        tokenHash: sha256(token),
        createdAt: new Date(START).toISOString(),
        expiresAt: new Date(START + 30 * DAY).toISOString(),
        lastSeenAt: new Date(START).toISOString(),
        userAgent: meta.userAgent,
        ip: meta.ip,
      },
    ]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("only the exact token resolves to its session", () => {
    const store = open();
    const { token, session } = store.create(meta);
    const neighbour = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    expect(store.touch(token)?.id).toBe(session.id);
    expect(store.touch(neighbour)).toBeNull();
    expect(store.touch("")).toBeNull();
  });

  test("session info never includes the token hash", () => {
    const store = open();
    const { token, session } = store.create(meta);

    expect(session).not.toHaveProperty("tokenHash");
    expect(store.touch(token)).not.toHaveProperty("tokenHash");
    expect(store.list()[0]).not.toHaveProperty("tokenHash");
  });

  test("client-supplied user agent and address are cleaned and capped", () => {
    const store = open();
    const { session } = store.create({ userAgent: `Agent\u0007\n${"x".repeat(1000)}`, ip: "1.2.3.4\u0000" });

    expect(session.userAgent).toMatch(/^Agent {2}x+$/);
    expect(session.userAgent.length).toBe(256);
    expect(session.ip).toBe("1.2.3.4");
  });
});

describe("revocation", () => {
  test("revoke ends one session at once, including after a restart", () => {
    const store = open();
    const a = store.create(meta);
    const b = store.create(meta);

    expect(store.revoke(a.session.id, "test")).toBe(true);
    expect(store.touch(a.token)).toBeNull();
    expect(store.touch(b.token)).not.toBeNull();
    expect(store.revoke(a.session.id, "test")).toBe(false);

    store.stop();
    expect(open().touch(a.token)).toBeNull();
    expect(open().touch(b.token)).not.toBeNull();
  });

  test("revokeOthers keeps the named session and reports how many it ended", () => {
    const store = open();
    const a = store.create(meta);
    const b = store.create(meta);
    const c = store.create(meta);

    expect(store.revokeOthers(b.session.id)).toBe(2);
    expect(store.touch(a.token)).toBeNull();
    expect(store.touch(b.token)).not.toBeNull();
    expect(store.touch(c.token)).toBeNull();
    expect(store.revokeOthers(null)).toBe(1);
    expect(store.list()).toEqual([]);
  });

  test("list shows live sessions, most recently used first", () => {
    const store = open();
    const older = store.create(meta);
    clock += HOUR;
    const newer = store.create(meta);
    clock += HOUR;
    store.touch(older.token);

    expect(store.list().map((session) => session.id)).toEqual([older.session.id, newer.session.id]);
  });
});

describe("access key changes", () => {
  test("a different access key ends every stored session", () => {
    const store = open();
    const { token } = store.create(meta);
    store.stop();

    const rotated = open({ accessKey: `rotated-${KEY}` });
    expect(rotated.touch(token)).toBeNull();
    expect(rotated.list()).toEqual([]);
    expect(storedFile().sessions).toEqual([]);
    rotated.stop();

    expect(open().touch(token)).toBeNull();
  });

  test("the same access key keeps sessions across a restart", () => {
    const store = open();
    const { token } = store.create(meta);
    store.stop();

    expect(open().touch(token)).not.toBeNull();
  });

  test("the key-change path logs a count, not the key", () => {
    const store = open();
    store.create(meta);
    store.stop();
    open({ accessKey: `rotated-${KEY}` });

    expect(logs.join("\n")).toContain("sessions.key_changed");
    expect(logs.join("\n")).not.toContain(KEY);
  });
});

describe("expiry", () => {
  test("a session ends at its absolute expiry, counted from sign-in", () => {
    const store = open({ ttlMs: 30 * DAY });
    const { token } = store.create(meta);

    clock = START + 30 * DAY - 1;
    expect(store.touch(token)).not.toBeNull();
    clock = START + 30 * DAY;
    expect(store.touch(token)).toBeNull();
    expect(store.list()).toEqual([]);
  });

  test("without sliding renewal, use does not extend a session", () => {
    const store = open({ ttlMs: 30 * DAY, idleMs: null });
    const { token } = store.create(meta);

    for (let day = 1; day <= 29; day++) {
      clock = START + day * DAY;
      expect(store.touch(token)).not.toBeNull();
    }
    clock = START + 30 * DAY;
    expect(store.touch(token)).toBeNull();
  });

  test("sliding renewal keeps an active session alive, but never past the absolute expiry", () => {
    const store = open({ ttlMs: 30 * DAY, idleMs: 7 * DAY });
    const { token } = store.create(meta);

    for (const day of [6, 12, 18, 24]) {
      clock = START + day * DAY;
      expect(store.touch(token)).not.toBeNull();
    }
    clock = START + 30 * DAY - HOUR;
    expect(store.touch(token)).not.toBeNull();
    clock = START + 30 * DAY;
    expect(store.touch(token)).toBeNull();
  });

  test("sliding renewal ends a session that goes unused for the idle window", () => {
    const store = open({ ttlMs: 30 * DAY, idleMs: 7 * DAY });
    const { token } = store.create(meta);

    clock = START + 7 * DAY - 1;
    expect(store.touch(token)).not.toBeNull();
    clock = START + 14 * DAY - 1;
    expect(store.touch(token)).toBeNull();
  });

  test("sweep drops expired sessions from disk", () => {
    const store = open({ ttlMs: DAY });
    store.create(meta);

    clock = START + 2 * DAY;
    expect(store.sweep()).toBe(1);
    expect(storedFile().sessions).toEqual([]);
  });

  test("sessions that expired while MiniBox was stopped are not restored", () => {
    const store = open({ ttlMs: DAY });
    const { token } = store.create(meta);
    store.stop();

    clock = START + 2 * DAY;
    expect(open({ ttlMs: DAY }).touch(token)).toBeNull();
  });
});

describe("persistence", () => {
  test("sessions and their last use survive a restart", () => {
    const store = open({ idleMs: 7 * DAY });
    const { token, session } = store.create(meta);
    clock = START + 2 * DAY;
    store.touch(token);
    store.stop();

    clock = START + 3 * DAY;
    const restarted = open({ idleMs: 7 * DAY });
    const [listed] = restarted.list();
    expect(listed).toEqual({
      id: session.id,
      createdAt: START,
      expiresAt: START + 30 * DAY,
      lastSeenAt: START + 2 * DAY,
      userAgent: meta.userAgent,
      ip: meta.ip,
    });
    expect(restarted.touch(token)?.id).toBe(session.id);
  });

  test("last use is written at most once a minute", () => {
    const store = open({ idleMs: 7 * DAY });
    const { token } = store.create(meta);
    const before = readFileSync(file, "utf8");

    clock = START + 30_000;
    store.touch(token);
    expect(readFileSync(file, "utf8")).toBe(before);

    clock = START + 61_000;
    store.touch(token);
    expect(readFileSync(file, "utf8")).not.toBe(before);
  });

  test("writes go through a temporary file, which is gone afterwards", () => {
    const store = open();
    store.create(meta);
    store.create(meta);

    expect(readdirSync(dir)).toEqual(["sessions.json"]);
  });

  test("an unreadable session file starts empty and is replaced by the next save", () => {
    writeFileSync(file, "{not json");
    const store = open();

    expect(store.list()).toEqual([]);
    expect(logs.join("\n")).toContain("sessions.unreadable");
    store.create(meta);
    expect(storedFile().sessions).toHaveLength(1);
  });

  test("a session file of another version is ignored", () => {
    writeFileSync(file, JSON.stringify({ version: 99, keyFingerprint: "", sessions: [] }));
    expect(open().list()).toEqual([]);
    expect(logs.join("\n")).toContain("sessions.unreadable");
  });

  test("entries that fail validation are skipped and the file is rewritten without them", () => {
    const store = open();
    const { token } = store.create(meta);
    store.stop();
    const stored = storedFile();
    stored.sessions.push({ id: "not-a-session" });
    writeFileSync(file, JSON.stringify(stored));

    const restarted = open();
    expect(restarted.touch(token)).not.toBeNull();
    expect(restarted.list()).toHaveLength(1);
    expect(storedFile().sessions).toHaveLength(1);
  });

  test("when the file cannot be written, sessions still work in memory and the failure is logged once", () => {
    const store = open({ file: join(dir, "missing", "sessions.json") });
    const { token } = store.create(meta);
    store.create(meta);

    expect(store.touch(token)).not.toBeNull();
    expect(logs.filter((line) => line.includes("sessions.persist_failed"))).toHaveLength(1);
    expect(logs.join("\n")).not.toContain(token);
  });
});

describe("capacity", () => {
  test(`keeps at most ${MAX_SESSIONS} sessions and ends the least recently used`, () => {
    const store = open();
    const first = store.create(meta);
    const second = store.create(meta);
    for (let i = 2; i < MAX_SESSIONS; i++) store.create(meta);
    expect(store.list()).toHaveLength(MAX_SESSIONS);

    clock += HOUR;
    store.touch(first.token);
    clock += HOUR;
    store.create(meta);

    expect(store.list()).toHaveLength(MAX_SESSIONS);
    expect(store.touch(first.token)).not.toBeNull();
    expect(store.touch(second.token)).toBeNull();
    expect(logs.join("\n")).toContain("session.evicted");
  });
});

describe("activity over a terminal connection", () => {
  test("touchId renews a live session by id and ignores unknown ids", () => {
    const store = open({ idleMs: DAY });
    const { session } = store.create(meta);

    clock = START + 20 * HOUR;
    expect(store.touchId(session.id)?.lastSeenAt).toBe(START + 20 * HOUR);
    clock = START + 40 * HOUR;
    expect(store.touchId(session.id)).not.toBeNull();
    clock = START + 70 * HOUR;
    expect(store.touchId(session.id)).toBeNull();
    expect(store.touchId("0".repeat(32))).toBeNull();
  });
});

describe("watch", () => {
  test("calls the listener once when the session is revoked", () => {
    const store = open();
    const { session } = store.create(meta);
    const listener = mock(() => {});
    store.watch(session.id, listener);

    store.revoke(session.id, "test");
    store.revoke(session.id, "test");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("calls the listener when the session expires, on the next sweep", () => {
    const store = open({ ttlMs: DAY });
    const { session } = store.create(meta);
    const listener = mock(() => {});
    store.watch(session.id, listener);

    clock = START + DAY;
    expect(listener).not.toHaveBeenCalled();
    store.sweep();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("calls the listener when the session is evicted", () => {
    const store = open();
    const oldest = store.create(meta);
    const listener = mock(() => {});
    store.watch(oldest.session.id, listener);
    for (let i = 1; i <= MAX_SESSIONS; i++) store.create(meta);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("calls straight away for a session that is already over, and a stopped watch is never called", () => {
    const store = open();
    const { session } = store.create(meta);
    const late = mock(() => {});
    store.watch(session.id, late);
    store.revoke(session.id, "test");
    store.watch(session.id, late);
    expect(late).toHaveBeenCalledTimes(2);

    const live = store.create(meta).session;
    const stopped = mock(() => {});
    const stop = store.watch(live.id, stopped);
    stop();
    store.revoke(live.id, "test");
    expect(stopped).not.toHaveBeenCalled();
  });

  test("a listener that throws does not stop the others", () => {
    const store = open();
    const { session } = store.create(meta);
    const after = mock(() => {});
    store.watch(session.id, () => {
      throw new Error("boom");
    });
    store.watch(session.id, after);

    store.revoke(session.id, "test");
    expect(after).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toContain("session.listener_failed");
  });
});
