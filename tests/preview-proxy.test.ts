import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";

import type { App } from "../src/app";
import { COOKIE_NAME } from "../src/auth";
import type { StoredEvent } from "../src/events/store";
import { PREVIEW_CSP } from "../src/preview/headers";
import { startServer } from "../src/server";
import { getBox, sleepBox } from "../src/services/boxes";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";
import { relayOnLoopback } from "./support/relay";

const restoreLogs = silenceLogs();
afterAll(restoreLogs);

async function signIn(base: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ key: TEST_KEY }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`)) ?? "";
  return decodeURIComponent(cookie.slice(COOKIE_NAME.length + 1).split(";")[0] ?? "");
}

describe("preview proxy", () => {
  test("rejects anonymous preview requests", async () => {
    const { app, runtime } = createTestApp();
    const keys = app.hosts.get().keys;
    runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    const server = startServer(app);
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const res = await fetch(`${base}/box/missing/3000/`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { key?: string } };
      expect(body.error.key).toBe("preview_unauthorized");
    } finally {
      server.stop(true);
      app.throttle.stop();
      app.sessions.stop();
      app.tokens.stop();
      app.events.close();
    }
  });

  test("signed-in user reaches upstream through /box/<name>/<port>/", async () => {
    let sawCookie: string | null = "unset";
    const upstream = createServer((req, res) => {
      sawCookie = req.headers.cookie ?? null;
      if (req.url === "/hello") {
        res.writeHead(200, { "content-type": "text/plain", "set-cookie": "evil=1; Path=/" });
        res.end("hello-from-box");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;

    const { app, runtime } = createTestApp();
    const host = app.hosts.get();
    const keys = host.keys;
    runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    // The preview reaches the box through the exec relay, so route it to this machine's python3, where the
    // test's upstream on 127.0.0.1 stands in for the box's own service.
    relayOnLoopback(runtime);

    const server = startServer(app);
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const create = await fetch(`${base}/api/boxes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TEST_KEY}`,
          origin: base,
        },
        body: JSON.stringify({ name: "prevdemo", cpus: 1, memoryMb: 512 }),
      });
      expect(create.status).toBe(201);
      const { box } = (await create.json()) as { box: { id: string; name: string; boxId: string } };

      const start = await fetch(`${base}/api/boxes/${box.id}/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${TEST_KEY}`, origin: base },
      });
      expect(start.status).toBe(200);

      const token = await signIn(base);
      const res = await fetch(`${base}/box/prevdemo/${upstreamPort}/hello`, {
        headers: { cookie: `${COOKIE_NAME}=${encodeURIComponent(token)}` },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello-from-box");
      expect(res.headers.get("content-security-policy")).toBe(PREVIEW_CSP);
      expect(res.headers.getSetCookie().some((c) => c.startsWith("evil="))).toBe(false);
      expect(sawCookie).toBeNull();
      expect(app.pulse.lastAt(box.boxId)).not.toBeNull();
    } finally {
      server.stop(true);
      upstream.close();
      app.throttle.stop();
      app.sessions.stop();
      app.tokens.stop();
      app.events.close();
    }
  });

  test("port.expose and port.list remember manual ports", async () => {
    const { app, runtime } = createTestApp();
    const keys = app.hosts.get().keys;
    runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    const server = startServer(app);
    const base = `http://127.0.0.1:${server.port}`;
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${TEST_KEY}`,
      origin: base,
    };
    try {
      const create = await fetch(`${base}/api/boxes`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "portbox", cpus: 1, memoryMb: 512 }),
      });
      expect(create.status).toBe(201);
      const { box } = (await create.json()) as { box: { id: string } };

      const expose = await fetch(`${base}/api/boxes/${box.id}/ports`, {
        method: "POST",
        headers,
        body: JSON.stringify({ port: 5173 }),
      });
      expect(expose.status).toBe(200);
      const exposed = (await expose.json()) as { port: { port: number; source: string; url: string } };
      expect(exposed.port).toEqual({ port: 5173, source: "manual", url: "/box/portbox/5173/" });

      const list = await fetch(`${base}/api/boxes/${box.id}/ports`, { headers });
      expect(list.status).toBe(200);
      const listed = (await list.json()) as { ports: { port: number }[] };
      expect(listed.ports.some((p) => p.port === 5173)).toBe(true);

      const del = await fetch(`${base}/api/boxes/${box.id}/ports/5173`, { method: "DELETE", headers });
      expect(del.status).toBe(200);
    } finally {
      server.stop(true);
      app.throttle.stop();
      app.sessions.stop();
      app.tokens.stop();
      app.events.close();
    }
  });
});

type Handler = Parameters<typeof createServer>[1];

interface Bed {
  app: App;
  runtime: FakeRuntime;
  base: string;
  server: ReturnType<typeof startServer>;
  cookie: string;
  /** Upstream servers and open responses the test made, closed by `stop`. */
  cleanups: (() => void)[];
  stop(): void;
}

/** A server with the preview relay routed to this machine, and a signed-in console cookie. */
async function bed(): Promise<Bed> {
  const { app, runtime } = createTestApp();
  const keys = app.hosts.get().keys;
  runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  const server = startServer(app);
  const base = `http://127.0.0.1:${server.port}`;
  // The preview reaches the box through the exec relay, so route it to this machine's python3, where the test's
  // upstream on 127.0.0.1 stands in for the box's own service.
  relayOnLoopback(runtime);
  const cleanups: (() => void)[] = [];
  const cookie = `${COOKIE_NAME}=${encodeURIComponent(await signIn(base))}`;
  return {
    app,
    runtime,
    base,
    server,
    cookie,
    cleanups,
    stop: () => {
      for (const cleanup of cleanups) cleanup();
      server.stop(true);
      app.throttle.stop();
      app.sessions.stop();
      app.tokens.stop();
      app.events.close();
    },
  };
}

async function makeBox(on: Bed, name: string): Promise<{ id: string; boxId: string }> {
  const res = await fetch(`${on.base}/api/boxes`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}`, origin: on.base },
    body: JSON.stringify({ name, cpus: 1, memoryMb: 512 }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { box: { id: string; boxId: string } }).box;
}

async function upstreamOn(on: Bed, handler: Handler): Promise<number> {
  const upstream = createServer(handler);
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  on.cleanups.push(() => upstream.close());
  return (upstream.address() as { port: number }).port;
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

describe("preview keeps a box awake (#12)", () => {
  test("a preview wakes an idle-sleeping box, serves it, and audits the wake under the console", async () => {
    const on = await bed();
    try {
      const port = await upstreamOn(on, (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("hello-from-box");
      });
      const box = await makeBox(on, "sleepy");
      expect(await sleepBox(on.app.hosts.get(), box.id, "idle")).toBe(true);
      const starts = on.runtime.callsTo("startContainer").length;
      const published: StoredEvent[] = [];
      on.app.bus.subscribe("event", (event) => published.push(event));

      const res = await fetch(`${on.base}/box/sleepy/${port}/hello`, { headers: { cookie: on.cookie } });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello-from-box");
      expect(on.runtime.callsTo("startContainer")).toHaveLength(starts + 1);
      expect(await getBox(on.app.hosts.get(), box.id)).toMatchObject({ running: true, sleeping: false });
      expect(on.app.pulse.isHeld(box.boxId)).toBe(false);
      expect(published.find((event) => event.op === "box.wake")).toMatchObject({
        source: "ui",
        detail: { from: "idle" },
      });
    } finally {
      on.stop();
    }
  });

  test("a preview for a box a person stopped is refused with 409, and the box stays stopped", async () => {
    const on = await bed();
    try {
      const port = await upstreamOn(on, (_req, res) => res.end("unreachable"));
      const box = await makeBox(on, "manual");
      await fetch(`${on.base}/api/boxes/${box.id}/stop`, {
        method: "POST",
        headers: { authorization: `Bearer ${TEST_KEY}`, origin: on.base },
      });
      const starts = on.runtime.callsTo("startContainer").length;

      const res = await fetch(`${on.base}/box/manual/${port}/`, { headers: { cookie: on.cookie } });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { key: "preview_box_stopped" } });
      expect(on.runtime.callsTo("startContainer")).toHaveLength(starts);
      expect(on.app.pulse.isHeld(box.boxId)).toBe(false);
    } finally {
      on.stop();
    }
  });

  test("an upstream that drops the connection is a 502, and the box is not left held", async () => {
    const on = await bed();
    try {
      const port = await upstreamOn(on, (req) => req.socket.destroy());
      const box = await makeBox(on, "dropped");

      const res = await fetch(`${on.base}/box/dropped/${port}/`, { headers: { cookie: on.cookie } });
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: { key: "preview_upstream_failed" } });
      expect(on.app.pulse.isHeld(box.boxId)).toBe(false);
    } finally {
      on.stop();
    }
  });

  test("a streaming response holds the box until it has been read to the end", async () => {
    const on = await bed();
    try {
      const port = await upstreamOn(on, (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("first ");
        setTimeout(() => res.end("second"), 100);
      });
      const box = await makeBox(on, "streamer");

      const res = await fetch(`${on.base}/box/streamer/${port}/`, { headers: { cookie: on.cookie } });
      const reader = res.body?.getReader();
      if (!reader) throw new Error("the preview response has no body");
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("first ");
      expect(on.app.pulse.isHeld(box.boxId)).toBe(true);

      let rest = "";
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        rest += new TextDecoder().decode(next.value);
      }
      expect(rest).toBe("second");
      expect(on.app.pulse.isHeld(box.boxId)).toBe(false);
    } finally {
      on.stop();
    }
  });

  test("a client that stops reading a streaming response releases the box", async () => {
    const on = await bed();
    try {
      const port = await upstreamOn(on, (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("first");
        on.cleanups.push(() => res.end());
      });
      const box = await makeBox(on, "cancelled");

      const res = await fetch(`${on.base}/box/cancelled/${port}/`, { headers: { cookie: on.cookie } });
      const reader = res.body?.getReader();
      if (!reader) throw new Error("the preview response has no body");
      await reader.read();
      expect(on.app.pulse.isHeld(box.boxId)).toBe(true);

      await reader.cancel();
      await waitFor(() => !on.app.pulse.isHeld(box.boxId), "the box to be released");
    } finally {
      on.stop();
    }
  });

  test("a preview WebSocket holds the box until the socket closes", async () => {
    const on = await bed();
    const echo = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("not a websocket", { status: 400 });
      },
      websocket: {
        message(ws, message) {
          ws.send(message);
        },
      },
    });
    try {
      const box = await makeBox(on, "socket");
      const socket = new WebSocket(`ws://127.0.0.1:${on.server.port}/box/socket/${echo.port}/chat`, {
        headers: { cookie: on.cookie },
      });
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error("preview socket failed to open")));
      });
      expect(on.app.pulse.isHeld(box.boxId)).toBe(true);

      const echoed = new Promise<unknown>((resolve) => socket.addEventListener("message", (e) => resolve(e.data)));
      // The upstream attaches after the socket opens, and a message that arrives before it is dropped, so resend.
      // A socket that is still connecting throws InvalidStateError from send, and a throw inside a timer ends the test
      // before its finally block runs, which leaks the log sink the test installed.
      const poke = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send("ping");
      }, 20);
      try {
        expect(await echoed).toBe("ping");
      } finally {
        clearInterval(poke);
      }

      const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve()));
      socket.close();
      await closed;
      await waitFor(() => !on.app.pulse.isHeld(box.boxId), "the box to be released");
    } finally {
      echo.stop(true);
      on.stop();
    }
  });
});
