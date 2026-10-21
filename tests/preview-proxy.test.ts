import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";

import { COOKIE_NAME } from "../src/auth";
import { PREVIEW_CSP } from "../src/preview/headers";
import { startServer } from "../src/server";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";

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

      const originalInspect = runtime.inspectContainer.bind(runtime);
      runtime.inspectContainer = async (id, opts) => {
        const info = await originalInspect(id, opts);
        return { ...info, ipAddress: "127.0.0.1" };
      };

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
