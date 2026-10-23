import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import { COOKIE_NAME } from "../src/auth";
import type { HostMetrics } from "../src/host/metrics";
import { startServer } from "../src/server";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { idOf, opOf, SseReader, summaryOf } from "./support/sse";

const GB = 1024 ** 3;
const SITE = "https://evil.example";
const EVENT_PATHS = ["/api/events", "/api/events/stream"];

interface EventJson {
  seq: number;
  op: string;
  status: string;
  summary: string;
  run?: string;
  target?: { id?: string; name: string };
}

interface Page {
  events: EventJson[];
  nextCursor: number | null;
}

interface Running {
  readonly app: App;
  readonly base: string;
  readonly server: ReturnType<typeof startServer>;
  readonly streams: SseReader[];
}

let running: Running[] = [];
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
});

afterEach(async () => {
  for (const started of running) {
    for (const stream of started.streams) await stream.close();
    started.server.stop(true);
    started.app.throttle.stop();
    started.app.sessions.stop();
    started.app.tokens.stop();
    started.app.events.close();
  }
  running = [];
  restoreLogs();
});

/** A running app on an ephemeral port, with the base template and a host large enough for every box the tests make. */
function start(): Running {
  const { app, runtime } = createTestApp({ labelPrefix: "mbtest" });
  const keys = app.hosts.get().keys;
  runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  app.monitor.snapshot = async () => ({ cpu: { cores: 64 }, memory: { total: 64 * GB } }) as unknown as HostMetrics;
  const server = startServer(app);
  const started: Running = { app, base: `http://127.0.0.1:${server.port}`, server, streams: [] };
  running.push(started);
  return started;
}

const auth = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${TEST_KEY}`, ...extra });

async function createBox(base: string, name: string, run?: string) {
  const res = await fetch(`${base}/api/boxes`, {
    method: "POST",
    headers: auth({ "content-type": "application/json", ...(run === undefined ? {} : { "x-minibox-run": run }) }),
    body: JSON.stringify({ name, cpus: 0.5, memoryMb: 256 }),
  });
  const json = (await res.json()) as { box?: { id: string } };
  return { status: res.status, id: json.box?.id };
}

async function listEvents(base: string, query = ""): Promise<Page> {
  const res = await fetch(`${base}/api/events${query ? `?${query}` : ""}`, { headers: auth() });
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
}

async function openStream(server: Running, query = "", extra: Record<string, string> = {}): Promise<SseReader> {
  return openStreamWith(server, auth(extra), query);
}

async function openStreamWith(server: Running, headers: Record<string, string>, query = ""): Promise<SseReader> {
  const res = await fetch(`${server.base}/api/events/stream${query ? `?${query}` : ""}`, { headers });
  expect(res.status).toBe(200);
  if (!res.body) throw new Error("the stream has no body");
  const reader = new SseReader(res.body.getReader());
  server.streams.push(reader);
  return reader;
}

const cookieFor = (token: string) => ({ cookie: `${COOKIE_NAME}=${token}` });

/** Signs in with the access key and returns the session token that the sign-in cookie carries. */
async function signIn(base: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ key: TEST_KEY }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`)) ?? "";
  return cookie.slice(COOKIE_NAME.length + 1).split(";")[0] ?? "";
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("the condition was not met in time");
    await Bun.sleep(10);
  }
}

describe("access checks on the event log", () => {
  test("both reads refuse a request without an access key", async () => {
    const { base } = start();
    for (const path of EVENT_PATHS) {
      const res = await fetch(`${base}${path}`);
      expect([path, res.status]).toEqual([path, 401]);
      expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
    }
  });

  test("both reads refuse a request from another site, and accept one from this origin", async () => {
    const server = start();
    for (const path of EVENT_PATHS) {
      const refused = await fetch(`${server.base}${path}`, { headers: auth({ origin: SITE }) });
      expect([path, refused.status]).toEqual([path, 403]);
      expect(await refused.json()).toMatchObject({ error: { key: "origin_forbidden" } });

      const accepted = await fetch(`${server.base}${path}`, { headers: auth({ origin: server.base }) });
      expect([path, accepted.status]).toEqual([path, 200]);
      await accepted.body?.cancel();
    }
  });
});

describe("GET /api/events", () => {
  test("refuses malformed filters and paging with a 400 that names the problem", async () => {
    const { base } = start();
    const queries = [
      "limit=0",
      "limit=201",
      "limit=ten",
      "since=yesterday",
      "cursor=abc",
      "cursor=0",
      "status=bogus",
      "reads=none",
      `box=${"x".repeat(201)}`,
    ];
    for (const query of queries) {
      const res = await fetch(`${base}/api/events?${query}`, { headers: auth() });
      expect([query, res.status]).toEqual([query, 400]);
      expect(await res.json()).toMatchObject({ error: { code: "validation_failed" } });
    }
  });

  test("pages run newest first, and each cursor reads the page before it, with every event seen once", async () => {
    const { base } = start();
    for (const name of ["one", "two", "three", "four", "five"]) await createBox(base, name);

    const seen: number[] = [];
    let cursor: number | null | undefined;
    let pages = 0;
    do {
      const query = new URLSearchParams({ op: "box.create", limit: "2" });
      if (cursor) query.set("cursor", String(cursor));
      const page = await listEvents(base, query.toString());
      seen.push(...page.events.map((event) => event.seq));
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual(seen.toSorted((a, b) => b - a));
  });

  test("filters narrow by operation, outcome, box, principal, run and time", async () => {
    const { base } = start();
    const alpha = await createBox(base, "alpha", "run-a");
    await createBox(base, "beta", "run-b");
    const duplicate = await createBox(base, "alpha", "run-a");
    expect(duplicate.status).toBe(409);

    const names = async (query: string) => (await listEvents(base, query)).events.map((event) => event.summary);
    expect(await names("op=box.create")).toHaveLength(3);
    expect(await names("status=error")).toEqual(["Create and start a box: alpha"]);
    expect(await names("run=run-a")).toHaveLength(2);
    expect(await names("run=run-b")).toEqual(["Create and start a box: beta"]);
    expect(await names("box=alpha")).toHaveLength(2);
    expect((await listEvents(base, `box=${alpha.id}`)).events.some((event) => event.target?.id === alpha.id)).toBe(
      true,
    );
    expect(await names("principal=owner&op=box.create")).toHaveLength(3);
    expect(await names("principal=nobody")).toEqual([]);
    expect(await names("op=box.*&status=error")).toEqual(["Create and start a box: alpha"]);
    const ops = async (query: string) => (await listEvents(base, query)).events.map((event) => event.op);
    expect(await ops("op=events.list")).not.toHaveLength(0);
    expect(await ops("op=events.list&reads=failed")).toEqual([]);
    expect(await ops("reads=failed")).not.toContain("events.list");

    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect(await names(`since=${future}`)).toEqual([]);
    expect(await names("since=2000-01-01T00:00:00Z&op=box.create")).toHaveLength(3);
  });

  test("reading the list is itself recorded as an events.list event", async () => {
    const { app, base } = start();
    await listEvents(base);
    const [event] = app.events.list({ op: "events.list" }, { limit: 1 }).events;
    expect(event).toMatchObject({ op: "events.list", status: "ok", kind: "read", tier: "activity", source: "rest" });
  });

  test("X-Minibox-Run groups the events of one client session", async () => {
    const { base } = start();
    await createBox(base, "grouped", "session-1");
    await createBox(base, "other");
    const page = await listEvents(base, "run=session-1");
    expect(page.events.map((event) => [event.summary, event.run])).toEqual([
      ["Create and start a box: grouped", "session-1"],
    ]);
  });
});

describe("GET /api/events/stream", () => {
  test("answers with an event stream that starts with a retry hint", async () => {
    const { base } = start();
    const res = await fetch(`${base}/api/events/stream`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = res.body;
    if (!body) throw new Error("the stream has no body");
    const sse = new SseReader(body.getReader());
    expect((await sse.next()).retry).toBe(3000);
    await sse.close();
  });

  test("pushes a box created after the stream opened, with its event id as the SSE id", async () => {
    const server = start();
    const sse = await openStream(server);
    expect((await sse.next()).retry).toBe(3000);
    await createBox(server.base, "live-one");

    const frame = await sse.until((f) => opOf(f) === "box.create");
    const data = frame.data as EventJson;
    expect(data).toMatchObject({ op: "box.create", status: "ok", target: { kind: "box", name: "live-one" } });
    expect(idOf(frame)).toBe(data.seq);
  });

  test("a reconnecting client resumes after its Last-Event-ID, with no gap and no repeat", async () => {
    const server = start();
    const first = await openStream(server);
    await first.next();
    await createBox(server.base, "resume-one");
    const one = await first.until((f) => summaryOf(f) === "Create and start a box: resume-one");
    await first.close();

    await createBox(server.base, "resume-two");
    await createBox(server.base, "resume-three");
    const second = await openStream(server, "", { "last-event-id": String(idOf(one)) });
    expect((await second.next()).retry).toBe(3000);
    const two = await second.next();
    const three = await second.next();
    expect(summaryOf(two)).toBe("Create and start a box: resume-two");
    expect(summaryOf(three)).toBe("Create and start a box: resume-three");
    expect(idOf(two)).toBeGreaterThan(idOf(one));
    expect(idOf(three)).toBeGreaterThan(idOf(two));

    await createBox(server.base, "resume-four");
    const four = await second.until((f) => opOf(f) === "box.create");
    expect(summaryOf(four)).toBe("Create and start a box: resume-four");
  });

  test("a Last-Event-ID that is not a sequence number is refused with a 400", async () => {
    const { base } = start();
    for (const value of ["abc", "0", "-1", "1.5"]) {
      const res = await fetch(`${base}/api/events/stream`, { headers: auth({ "last-event-id": value }) });
      expect([value, res.status]).toEqual([value, 400]);
      expect(await res.json()).toMatchObject({ error: { key: "last_event_id_invalid" } });
    }
  });

  test("applies the same filters as the list, so only matching events are pushed", async () => {
    const server = start();
    const deletes = await openStream(server, "op=box.delete");
    const made = await createBox(server.base, "filtered");
    await fetch(`${server.base}/api/boxes/${made.id}`, { method: "DELETE", headers: auth() });

    expect((await deletes.next()).retry).toBe(3000);
    expect(opOf(await deletes.next())).toBe("box.delete");
  });

  test("disconnecting releases the bus subscription", async () => {
    const server = start();
    const baseline = server.app.bus.listenerCount("event");
    const sse = await openStream(server);
    await sse.next();
    expect(server.app.bus.listenerCount("event")).toBe(baseline + 1);

    await sse.close();
    await waitFor(() => server.app.bus.listenerCount("event") === baseline);
  });

  test("a stream opened with a browser session ends when that session signs out", async () => {
    const server = start();
    const token = await signIn(server.base);
    const sse = await openStreamWith(server, cookieFor(token));
    expect((await sse.next()).retry).toBe(3000);

    const logout = await fetch(`${server.base}/api/auth/logout`, {
      method: "POST",
      headers: { origin: server.base, "content-type": "application/json", ...cookieFor(token) },
      body: "{}",
    });
    expect(logout.status).toBe(200);
    await sse.untilEnd();
  });

  test("revoking one session ends its stream and leaves another session's stream receiving events", async () => {
    const server = start();
    const { token, session } = server.app.sessions.create({ userAgent: "test", ip: "127.0.0.1" });
    const kept = await signIn(server.base);
    const revoked = await openStreamWith(server, cookieFor(token));
    const live = await openStreamWith(server, cookieFor(kept));
    await revoked.next();
    await live.next();

    const res = await fetch(`${server.base}/api/auth/sessions/${session.id}`, { method: "DELETE", headers: auth() });
    expect(res.status).toBe(200);
    await revoked.untilEnd();

    await createBox(server.base, "after-revoke");
    const frame = await live.until((f) => opOf(f) === "box.create");
    expect(summaryOf(frame)).toBe("Create and start a box: after-revoke");
  });
});
