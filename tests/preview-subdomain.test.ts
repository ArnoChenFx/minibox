import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";

import type { App } from "../src/app";
import { COOKIE_NAME } from "../src/auth";
import { previewHostname } from "../src/preview/domain";
import { PREVIEW_COOKIE, TICKET_PARAM } from "../src/preview/grants";
import { PREVIEW_SUBDOMAIN_CSP } from "../src/preview/headers";
import type { PreviewProbe } from "../src/preview/selfcheck";
import { startServer } from "../src/server";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";
import { relayOnLoopback } from "./support/relay";

const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const BASE = "minibox-preview.test";
const WILDCARD_WORKS: PreviewProbe = {
  resolves: async () => true,
  get: async () => ({ ok: true, status: 404, marked: true }),
};

type Handler = Parameters<typeof createServer>[1];

interface BoxRef {
  id: string;
  boxId: string;
  name: string;
}

interface Bed {
  app: App;
  runtime: FakeRuntime;
  base: string;
  server: ReturnType<typeof startServer>;
  /** The console session cookie, as the browser sends it. */
  cookie: string;
  cleanups: (() => void)[];
  stop(): void;
}

async function bed(previewBaseDomain: string | null = BASE, probe: PreviewProbe = WILDCARD_WORKS): Promise<Bed> {
  const { app, runtime } = createTestApp({ previewBaseDomain }, undefined, {}, { previewProbe: probe });
  const keys = app.hosts.get().keys;
  runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  // The preview reaches the box through the exec relay, so route it to this machine's python3, where the test's
  // upstream on 127.0.0.1 stands in for the box's own service.
  relayOnLoopback(runtime);
  const server = startServer(app);
  const base = `http://127.0.0.1:${server.port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ key: TEST_KEY }),
  });
  expect(login.status).toBe(200);
  const cookie =
    login.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${COOKIE_NAME}=`))
      ?.split(";")[0] ?? "";
  const cleanups: (() => void)[] = [];
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

function consoleHeaders(on: Bed): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}`, origin: on.base };
}

async function startedBox(on: Bed, name: string): Promise<BoxRef> {
  const created = await fetch(`${on.base}/api/boxes`, {
    method: "POST",
    headers: consoleHeaders(on),
    body: JSON.stringify({ name, cpus: 1, memoryMb: 512 }),
  });
  expect(created.status).toBe(201);
  const { box } = (await created.json()) as { box: BoxRef };
  const started = await fetch(`${on.base}/api/boxes/${box.id}/start`, { method: "POST", headers: consoleHeaders(on) });
  expect(started.status).toBe(200);
  return box;
}

async function upstreamOn(on: Bed, handler: Handler): Promise<number> {
  const upstream = createServer(handler);
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  on.cleanups.push(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  return (upstream.address() as { port: number }).port;
}

/** A request to a preview host. The Host header is what the browser would have sent for that origin. */
function previewFetch(on: Bed, hostname: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", hostname);
  return fetch(`${on.base}${path}`, { redirect: "manual", ...init, headers });
}

/** The console opens a port the way the browser does, and returns the preview host and the ticket it redirects with. */
async function launch(on: Bed, box: BoxRef, port: number): Promise<{ hostname: string; ticket: string }> {
  const res = await fetch(`${on.base}/api/boxes/${box.boxId}/ports/${port}/preview`, {
    headers: { cookie: on.cookie },
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  return { hostname: location.hostname, ticket: location.searchParams.get(TICKET_PARAM) ?? "" };
}

/** The browser follows the redirect to the preview host, which trades the ticket for a grant cookie. */
async function exchange(on: Bed, hostname: string, ticket: string): Promise<string> {
  const res = await previewFetch(on, hostname, `/?${TICKET_PARAM}=${ticket}`);
  expect(res.status).toBe(302);
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${PREVIEW_COOKIE}=`)) ?? "";
  return setCookie.split(";")[0] ?? "";
}

async function openPreview(on: Bed, box: BoxRef, port: number): Promise<{ hostname: string; grant: string }> {
  const { hostname, ticket } = await launch(on, box, port);
  return { hostname, grant: await exchange(on, hostname, ticket) };
}

describe("subdomain preview launcher", () => {
  test("the launcher redirects a signed-in browser to a one-time ticket on the box's preview host", async () => {
    const on = await bed();
    try {
      const port = await upstreamOn(on, (_req, res) => res.end("unused"));
      const box = await startedBox(on, "web");

      const res = await fetch(`${on.base}/api/boxes/${box.boxId}/ports/${port}/preview`, {
        headers: { cookie: on.cookie },
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location") ?? "");
      expect(location.protocol).toBe("https:");
      expect(location.hostname).toBe(previewHostname(port, "web", BASE));
      expect(location.pathname).toBe("/");
      expect(location.searchParams.get(TICKET_PARAM)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    } finally {
      on.stop();
    }
  });

  test("the launcher names a box whose name is not a DNS label by its stable id", async () => {
    const on = await bed();
    try {
      const port = await upstreamOn(on, (_req, res) => res.end("unused"));
      const box = await startedBox(on, "My_App");
      const { hostname } = await launch(on, box, port);
      expect(hostname).toBe(previewHostname(port, box.boxId.replace("_", "-"), BASE));
    } finally {
      on.stop();
    }
  });

  test("anonymous and Bearer-only requests are refused: the launcher reads the session cookie only", async () => {
    const on = await bed();
    try {
      const port = await upstreamOn(on, (_req, res) => res.end("unused"));
      const box = await startedBox(on, "web");
      const path = `/api/boxes/${box.boxId}/ports/${port}/preview`;

      const anonymous = await fetch(`${on.base}${path}`, { redirect: "manual" });
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toMatchObject({ error: { key: "preview_unauthorized" } });

      const bearer = await fetch(`${on.base}${path}`, {
        headers: { authorization: `Bearer ${TEST_KEY}` },
        redirect: "manual",
      });
      expect(bearer.status).toBe(401);
      expect(await bearer.json()).toMatchObject({ error: { key: "preview_unauthorized" } });
    } finally {
      on.stop();
    }
  });

  test("a stopped box is refused with 409, and no ticket is issued", async () => {
    const on = await bed();
    try {
      const port = await upstreamOn(on, (_req, res) => res.end("unused"));
      const box = await startedBox(on, "web");
      await fetch(`${on.base}/api/boxes/${box.id}/stop`, { method: "POST", headers: consoleHeaders(on) });

      const res = await fetch(`${on.base}/api/boxes/${box.boxId}/ports/${port}/preview`, {
        headers: { cookie: on.cookie },
        redirect: "manual",
      });
      expect(res.status).toBe(409);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.json()).toMatchObject({ error: { key: "preview_box_stopped" } });
    } finally {
      on.stop();
    }
  });

  test("without PREVIEW_BASE_DOMAIN the launcher is off, and the self-check reports path mode", async () => {
    const on = await bed(null);
    try {
      const box = await startedBox(on, "web");
      const res = await fetch(`${on.base}/api/boxes/${box.boxId}/ports/3000/preview`, {
        headers: { cookie: on.cookie },
        redirect: "manual",
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { key: "preview_subdomain_off" } });

      const setup = await fetch(`${on.base}/api/preview/setup`, { headers: { cookie: on.cookie } });
      expect(await setup.json()).toEqual({ mode: "path", baseDomain: null, checks: [] });
    } finally {
      on.stop();
    }
  });

  test("port.expose and port.list return the launcher path in subdomain mode", async () => {
    const on = await bed();
    try {
      const box = await startedBox(on, "portbox");
      const expose = await fetch(`${on.base}/api/boxes/${box.id}/ports`, {
        method: "POST",
        headers: consoleHeaders(on),
        body: JSON.stringify({ port: 5173 }),
      });
      expect(expose.status).toBe(200);
      expect(await expose.json()).toMatchObject({
        port: { port: 5173, source: "manual", url: `/api/boxes/${box.boxId}/ports/5173/preview` },
      });

      const list = await fetch(`${on.base}/api/boxes/${box.id}/ports`, { headers: consoleHeaders(on) });
      const listed = (await list.json()) as { ports: { port: number; source: string; url: string }[] };
      expect(listed.ports).toContainEqual({
        port: 5173,
        source: "manual",
        url: `/api/boxes/${box.boxId}/ports/5173/preview`,
      });
    } finally {
      on.stop();
    }
  });
});

describe("subdomain preview grants", () => {
  test("a ticket is exchanged once for a host-only grant cookie, and then it is spent", async () => {
    const on = await bed();
    try {
      const port = await upstreamOn(on, (_req, res) => res.end("unused"));
      const box = await startedBox(on, "web");
      const { hostname, ticket } = await launch(on, box, port);

      const first = await previewFetch(on, hostname, `/?${TICKET_PARAM}=${ticket}`);
      expect(first.status).toBe(302);
      expect(first.headers.get("location")).toBe("/");
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(first.headers.getSetCookie()).toEqual([
        expect.stringMatching(
          new RegExp(`^${PREVIEW_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800$`),
        ),
      ]);

      const replay = await previewFetch(on, hostname, `/?${TICKET_PARAM}=${ticket}`);
      expect(replay.status).toBe(401);
      expect(await replay.json()).toMatchObject({ error: { key: "preview_grant_required" } });
    } finally {
      on.stop();
    }
  });

  test("a ticket presented for another preview is refused and stays unspent for the right one", async () => {
    const on = await bed();
    try {
      const port = await upstreamOn(on, (_req, res) => res.end("unused"));
      const other = await upstreamOn(on, (_req, res) => res.end("unused"));
      const box = await startedBox(on, "web");
      const { hostname, ticket } = await launch(on, box, port);

      const wrong = await previewFetch(on, previewHostname(other, "web", BASE), `/?${TICKET_PARAM}=${ticket}`);
      expect(wrong.status).toBe(401);

      const right = await previewFetch(on, hostname, `/?${TICKET_PARAM}=${ticket}`);
      expect(right.status).toBe(302);
    } finally {
      on.stop();
    }
  });

  test("a grant opens the preview under its own origin: the box gets its own cookies, and none of MiniBox's", async () => {
    const on = await bed();
    try {
      const seenCookies: (string | undefined)[] = [];
      const port = await upstreamOn(on, (req, res) => {
        seenCookies.push(req.headers.cookie);
        res.writeHead(200, {
          "content-type": "text/plain",
          "set-cookie": "sid=1; Path=/; Domain=minibox-preview.test",
        });
        res.end("hello-from-box");
      });
      const box = await startedBox(on, "web");
      const { hostname, grant } = await openPreview(on, box, port);

      const res = await previewFetch(on, hostname, "/hello", {
        headers: { cookie: `${grant}; ${on.cookie}; app=1` },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello-from-box");
      expect(res.headers.get("content-security-policy")).toBe(PREVIEW_SUBDOMAIN_CSP);
      expect(res.headers.getSetCookie()).toEqual(["sid=1; Path=/"]);
      expect(seenCookies).toEqual(["app=1"]);
      expect(on.app.pulse.lastAt(box.boxId)).not.toBeNull();
    } finally {
      on.stop();
    }
  });

  test("the console's session cookie alone does not open a preview, and the box is never reached", async () => {
    const on = await bed();
    try {
      let hits = 0;
      const port = await upstreamOn(on, (_req, res) => {
        hits += 1;
        res.end("unused");
      });
      const box = await startedBox(on, "web");
      const { hostname } = await launch(on, box, port);

      const res = await previewFetch(on, hostname, "/", { headers: { cookie: on.cookie } });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: { key: "preview_grant_required" } });
      expect(hits).toBe(0);
    } finally {
      on.stop();
    }
  });

  test("a grant opens only the preview it was issued for", async () => {
    const on = await bed();
    try {
      const port = await upstreamOn(on, (_req, res) => res.end("unused"));
      const box = await startedBox(on, "web");
      const other = await startedBox(on, "api");
      const { grant } = await openPreview(on, box, port);

      const sameBoxOtherPort = await previewFetch(on, previewHostname(port + 1, "web", BASE), "/", {
        headers: { cookie: grant },
      });
      expect(sameBoxOtherPort.status).toBe(401);

      const otherBox = await previewFetch(on, previewHostname(port, other.name, BASE), "/", {
        headers: { cookie: grant },
      });
      expect(otherBox.status).toBe(401);
    } finally {
      on.stop();
    }
  });

  test("a box that is renamed or deleted loses its grant", async () => {
    const on = await bed();
    try {
      const port = await upstreamOn(on, (_req, res) => res.end("unused"));
      const renamed = await startedBox(on, "before");
      const { hostname, grant } = await openPreview(on, renamed, port);
      const current = await fetch(`${on.base}/api/boxes/${renamed.id}`, { headers: consoleHeaders(on) });
      const rename = await fetch(`${on.base}/api/boxes/${renamed.id}`, {
        method: "PATCH",
        headers: { ...consoleHeaders(on), "if-match": current.headers.get("etag") ?? "" },
        body: JSON.stringify({ name: "after" }),
      });
      expect(rename.status).toBe(200);
      const afterRename = await previewFetch(on, hostname, "/", { headers: { cookie: grant } });
      expect(afterRename.status).toBe(401);

      const deleted = await startedBox(on, "gone");
      const gone = await openPreview(on, deleted, port);
      const remove = await fetch(`${on.base}/api/boxes/${deleted.id}`, {
        method: "DELETE",
        headers: consoleHeaders(on),
      });
      expect(remove.status).toBe(200);
      const afterDelete = await previewFetch(on, gone.hostname, "/", { headers: { cookie: gone.grant } });
      expect(afterDelete.status).toBe(401);
    } finally {
      on.stop();
    }
  });

  test("signing out ends the grant", async () => {
    const on = await bed();
    try {
      const port = await upstreamOn(on, (_req, res) => res.end("unused"));
      const box = await startedBox(on, "web");
      const { hostname, grant } = await openPreview(on, box, port);
      const [session] = on.app.sessions.list();
      if (!session) throw new Error("expected a live console session");
      expect(on.app.sessions.revoke(session.id, "test")).toBe(true);

      const res = await previewFetch(on, hostname, "/", { headers: { cookie: grant } });
      expect(res.status).toBe(401);
    } finally {
      on.stop();
    }
  });
});

describe("subdomain preview routing", () => {
  test("everything on a preview host reaches the box, including /api paths and any content type", async () => {
    const on = await bed();
    try {
      const seen: { method: string; url: string | undefined; type: string | null; body: string }[] = [];
      const port = await upstreamOn(on, (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          seen.push({
            method: req.method ?? "",
            url: req.url,
            type: req.headers["content-type"] ?? null,
            body: Buffer.concat(chunks).toString("utf8"),
          });
          res.writeHead(201, { "content-type": "application/json" });
          res.end('{"ok":true}');
        });
      });
      const box = await startedBox(on, "web");
      const { hostname, grant } = await openPreview(on, box, port);

      const res = await previewFetch(on, hostname, "/api/notes", {
        method: "POST",
        headers: { cookie: grant, "content-type": "text/plain" },
        body: "hi",
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ ok: true });
      expect(seen).toEqual([{ method: "POST", url: "/api/notes", type: "text/plain", body: "hi" }]);
    } finally {
      on.stop();
    }
  });

  test("a write from another origin is refused before the box sees it, but the preview's own origin passes", async () => {
    const on = await bed();
    try {
      let hits = 0;
      const port = await upstreamOn(on, (_req, res) => {
        hits += 1;
        res.end("ok");
      });
      const box = await startedBox(on, "web");
      const other = await startedBox(on, "api");
      const { hostname, grant } = await openPreview(on, box, port);

      const evil = await previewFetch(on, hostname, "/submit", {
        method: "POST",
        headers: { cookie: grant, origin: "https://evil.example", "content-type": "text/plain" },
        body: "x",
      });
      expect(evil.status).toBe(403);
      expect(await evil.json()).toMatchObject({ error: { key: "origin_forbidden" } });

      const sibling = await previewFetch(on, hostname, "/submit", {
        method: "POST",
        headers: { cookie: grant, origin: `https://${previewHostname(port, other.name, BASE)}` },
        body: "x",
      });
      expect(sibling.status).toBe(403);
      expect(hits).toBe(0);

      const own = await previewFetch(on, hostname, "/submit", {
        method: "POST",
        headers: { cookie: grant, origin: `https://${hostname}` },
        body: "x",
      });
      expect(own.status).toBe(200);
      expect(hits).toBe(1);
    } finally {
      on.stop();
    }
  });

  test("/box/ paths are not served in subdomain mode", async () => {
    const on = await bed();
    try {
      const port = await upstreamOn(on, (_req, res) => res.end("unused"));
      await startedBox(on, "web");
      const res = await fetch(`${on.base}/box/web/${port}/`, { headers: { cookie: on.cookie } });
      expect(res.status).toBe(404);
    } finally {
      on.stop();
    }
  });

  test("a malformed preview host, or the base domain itself, is a 404 that carries MiniBox's marker", async () => {
    const on = await bed();
    try {
      for (const host of [BASE, `abc-web.${BASE}`, `0-web.${BASE}`, `70000-web.${BASE}`, `3000-.${BASE}`]) {
        const res = await previewFetch(on, host, "/");
        expect(res.status).toBe(404);
        expect(res.headers.get("x-minibox-preview")).toBe("1");
        expect(await res.json()).toMatchObject({ error: { key: "preview_host_unknown" } });
      }
    } finally {
      on.stop();
    }
  });

  test("a socket that reaches the box carries the box's own cookies only", async () => {
    const on = await bed();
    let upgradeCookie: string | null | undefined;
    const echo = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, server) {
        upgradeCookie = req.headers.get("cookie");
        if (server.upgrade(req)) return undefined;
        return new Response("not a websocket", { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send("ready");
        },
        message(ws, message) {
          ws.send(message);
        },
      },
    });
    on.cleanups.push(() => echo.stop(true));
    try {
      const box = await startedBox(on, "socket");
      const { hostname, grant } = await openPreview(on, box, portOf(echo));

      const socket = new WebSocket(`ws://127.0.0.1:${on.server.port}/chat`, {
        headers: { host: hostname, cookie: `${grant}; ${on.cookie}; app=1`, origin: `http://${hostname}` },
      } as unknown as string[]);
      const received = messages(socket);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error("preview socket failed to open")));
      });
      expect(await received()).toBe("ready");
      expect(upgradeCookie).toBe("app=1");

      socket.send("ping");
      expect(await received()).toBe("ping");
      socket.close();
    } finally {
      on.stop();
    }
  });

  test("a socket on a preview host needs a grant, and is refused without one", async () => {
    const on = await bed();
    const echo = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("not a websocket", { status: 400 });
      },
      websocket: { message() {} },
    });
    on.cleanups.push(() => echo.stop(true));
    try {
      await startedBox(on, "socket");
      const hostname = previewHostname(portOf(echo), "socket", BASE);
      const socket = new WebSocket(`ws://127.0.0.1:${on.server.port}/chat`, {
        headers: { host: hostname, cookie: on.cookie, origin: `http://${hostname}` },
      } as unknown as string[]);
      const outcome = new Promise<string>((resolve) => {
        socket.addEventListener("open", () => resolve("open"));
        socket.addEventListener("error", () => resolve("error"));
      });
      expect(await outcome).toBe("error");
    } finally {
      on.stop();
    }
  });

  test("ending the console sign-in closes an open preview socket with 1008", async () => {
    const on = await bed();
    const echo = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("not a websocket", { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send("ready");
        },
        message() {},
      },
    });
    on.cleanups.push(() => echo.stop(true));
    try {
      const box = await startedBox(on, "socket");
      const { hostname, grant } = await openPreview(on, box, portOf(echo));
      const socket = new WebSocket(`ws://127.0.0.1:${on.server.port}/chat`, {
        headers: { host: hostname, cookie: grant, origin: `http://${hostname}` },
      } as unknown as string[]);
      const received = messages(socket);
      const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve));
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error("preview socket failed to open")));
      });
      expect(await received()).toBe("ready");

      const [session] = on.app.sessions.list();
      if (!session) throw new Error("expected a live console session");
      on.app.sessions.revoke(session.id, "test");

      const event = await closed;
      expect(event.code).toBe(1008);
      expect(event.reason).toBe("session ended");
    } finally {
      on.stop();
    }
  });
});

describe("subdomain preview host edge cases", () => {
  test("a preview name with a trailing dot is refused, and never served the console", async () => {
    const on = await bed();
    try {
      for (const hostname of [`5173-demo.${BASE}.`, `${BASE}.`]) {
        const res = await previewFetch(on, hostname, "/login", { headers: { cookie: on.cookie } });
        expect(res.status).toBe(404);
        expect(res.headers.get("x-minibox-preview")).toBe("1");
      }
    } finally {
      on.stop();
    }
  });

  test("spending a ticket on a path with leading slashes redirects on the same host", async () => {
    const on = await bed();
    try {
      const box = await startedBox(on, "demo");
      const { hostname, ticket } = await launch(on, box, 5173);
      const res = await previewFetch(on, hostname, `//evil.example/x?${TICKET_PARAM}=${ticket}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/evil.example/x");
    } finally {
      on.stop();
    }
  });
});

describe("preview self-check endpoint", () => {
  test("the owner gets each check, and a wildcard that does not resolve is reported", async () => {
    const on = await bed(BASE, { resolves: async () => false, get: WILDCARD_WORKS.get });
    try {
      const res = await fetch(`${on.base}/api/preview/setup`, { headers: { cookie: on.cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        mode: string;
        baseDomain: string;
        checks: { id: string; status: string }[];
      };
      expect(body.mode).toBe("subdomain");
      expect(body.baseDomain).toBe(BASE);
      expect(body.checks.map((c) => c.id)).toEqual(["console", "same_site", "dns", "https"]);
      expect(body.checks.find((c) => c.id === "dns")?.status).toBe("error");
    } finally {
      on.stop();
    }
  });

  test("the self-check is refused to anonymous callers", async () => {
    const on = await bed();
    try {
      const res = await fetch(`${on.base}/api/preview/setup`);
      expect(res.status).toBe(401);
    } finally {
      on.stop();
    }
  });
});

function portOf(server: { port?: number }): number {
  if (server.port === undefined) throw new Error("the test server is not listening");
  return server.port;
}

/** Received messages, in order. A message that arrives before anyone asks is kept until it is asked for. */
function messages(socket: WebSocket): () => Promise<string> {
  const queued: string[] = [];
  const waiting: ((text: string) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const text = String(event.data);
    const next = waiting.shift();
    if (next) next(text);
    else queued.push(text);
  });
  return () => {
    const first = queued.shift();
    if (first !== undefined) return Promise.resolve(first);
    return new Promise((resolve) => waiting.push(resolve));
  };
}
