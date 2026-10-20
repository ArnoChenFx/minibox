import { join } from "path";
import { existsSync } from "fs";
import {
  loadOrCreateAccessKey,
  loadPortHost,
  isAuthorized,
  loginSetCookie,
  logoutClearCookie,
  ROOT,
} from "./auth";
import * as box from "./docker";

const accessKey = loadOrCreateAccessKey();
const { port, host } = loadPortHost();
const publicDir = join(ROOT, "public");

type WsData = {
  kind: "term";
  boxId: string;
  execId?: string;
  stream?: any;
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function err(e: any, fallback = 500) {
  const status = e?.status || e?.statusCode || fallback;
  const message = e?.json?.message || e?.message || String(e);
  return json({ error: message }, status >= 400 && status < 600 ? status : 500);
}

async function readBody(req: Request): Promise<any> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try {
      return await req.json();
    } catch {
      return {};
    }
  }
  return {};
}

function requireAuth(req: Request): Response | null {
  if (!isAuthorized(req, accessKey)) {
    return json({ error: "未授权" }, 401);
  }
  return null;
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

async function serveStatic(urlPath: string): Promise<Response> {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  rel = rel.replace(/\.\./g, "");
  const filePath = join(publicDir, rel);
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    return new Response("Not Found", { status: 404 });
  }
  const file = Bun.file(filePath);
  return new Response(file, { headers: { "content-type": contentType(filePath) } });
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method.toUpperCase();

  if (path === "/api/login" && method === "POST") {
    const body = await readBody(req);
    if (body.key !== accessKey) return json({ error: "密钥错误" }, 401);
    return json({ ok: true }, 200, { "set-cookie": loginSetCookie(accessKey) });
  }

  // Auth gate for everything else under /api
  const denied = requireAuth(req);
  if (denied && path !== "/api/login") return denied;

  if (path === "/api/logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": logoutClearCookie() });
  }

  if (path === "/api/me" && method === "GET") {
    return json({ ok: true, authenticated: true });
  }

  if (path === "/api/boxes" && method === "GET") {
    const boxes = await box.enrichBoxesWithResources(await box.listBoxes());
    // attach live stats for running ones (best-effort)
    const withStats = await Promise.all(
      boxes.map(async (b) => {
        if (b.state !== "running") return { ...b, stats: null };
        try {
          return { ...b, stats: await box.getStats(b.id) };
        } catch {
          return { ...b, stats: null };
        }
      })
    );
    return json({ boxes: withStats });
  }

  if (path === "/api/boxes" && method === "POST") {
    const body = await readBody(req);
    const created = await box.createBox({
      name: body.name,
      template: body.template || box.BASE_TEMPLATE_TAG,
      cpus: body.cpus != null ? Number(body.cpus) : 1,
      memoryMb: body.memoryMb != null ? Number(body.memoryMb) : 1024,
      fromImage: body.fromImage,
    });
    return json({ box: created }, 201);
  }

  const boxMatch = path.match(/^\/api\/boxes\/([^/]+)(?:\/(start|stop|restart|snapshot|logs|stats|resources))?$/);
  if (boxMatch) {
    const id = decodeURIComponent(boxMatch[1]);
    const action = boxMatch[2];

    if (!action && method === "GET") return json({ box: await box.inspectBox(id) });
    if (!action && method === "DELETE") {
      const delVol = url.searchParams.get("deleteVolume") === "true";
      return json(await box.deleteBox(id, delVol));
    }
    if (action === "start" && method === "POST") return json({ box: await box.startBox(id) });
    if (action === "stop" && method === "POST") return json({ box: await box.stopBox(id) });
    if (action === "restart" && method === "POST") return json({ box: await box.restartBox(id) });
    if (action === "snapshot" && method === "POST") {
      const body = await readBody(req);
      return json(await box.snapshotBox(id, body.name), 201);
    }
    if (action === "logs" && method === "GET") {
      const tail = Number(url.searchParams.get("tail") || 200);
      return json({ logs: await box.getLogs(id, tail) });
    }
    if (action === "stats" && method === "GET") return json({ stats: await box.getStats(id) });
    if (action === "resources" && method === "PATCH") {
      const body = await readBody(req);
      return json({
        box: await box.updateResources(id, {
          cpus: body.cpus != null ? Number(body.cpus) : undefined,
          memoryMb: body.memoryMb != null ? Number(body.memoryMb) : undefined,
        }),
      });
    }
  }

  if (path === "/api/snapshots" && method === "GET") {
    return json({ snapshots: await box.listSnapshots() });
  }

  const snapMatch = path.match(/^\/api\/snapshots\/(.+)$/);
  if (snapMatch) {
    const id = decodeURIComponent(snapMatch[1]);
    if (method === "DELETE") return json(await box.deleteImage(id));
    if (method === "POST" && url.searchParams.get("action") === "promote") {
      const body = await readBody(req);
      return json(await box.promoteSnapshot(id, body.name || "custom"));
    }
    // create box from snapshot: POST /api/snapshots/:id/create-box
  }

  const snapCreate = path.match(/^\/api\/snapshots\/(.+)\/create-box$/);
  if (snapCreate && method === "POST") {
    const id = decodeURIComponent(snapCreate[1]);
    const body = await readBody(req);
    const created = await box.createBox({
      name: body.name,
      template: `snapshot:${id}`,
      fromImage: id,
      cpus: body.cpus != null ? Number(body.cpus) : 1,
      memoryMb: body.memoryMb != null ? Number(body.memoryMb) : 1024,
    });
    return json({ box: created }, 201);
  }

  const snapPromote = path.match(/^\/api\/snapshots\/(.+)\/promote$/);
  if (snapPromote && method === "POST") {
    const id = decodeURIComponent(snapPromote[1]);
    const body = await readBody(req);
    return json(await box.promoteSnapshot(id, body.name));
  }

  if (path === "/api/templates" && method === "GET") {
    return json({ templates: await box.listTemplates(), baseTag: box.BASE_TEMPLATE_TAG });
  }

  if (path === "/api/templates/build" && method === "POST") {
    const result = await box.buildBaseTemplate();
    return json(result);
  }

  return json({ error: "未找到接口" }, 404);
}

const server = Bun.serve<WsData>({
  hostname: host,
  port,
  async fetch(req, server) {
    const url = new URL(req.url);
    try {
      // WebSocket terminal upgrade
      if (url.pathname.match(/^\/api\/boxes\/[^/]+\/term$/) && req.headers.get("upgrade") === "websocket") {
        if (!isAuthorized(req, accessKey)) {
          return json({ error: "未授权" }, 401);
        }
        const m = url.pathname.match(/^\/api\/boxes\/([^/]+)\/term$/);
        const boxId = decodeURIComponent(m![1]);
        await box.inspectBox(boxId);
        const ok = server.upgrade(req, { data: { kind: "term", boxId } });
        if (!ok) return new Response("WebSocket upgrade failed", { status: 500 });
        return undefined as any;
      }

      if (url.pathname.startsWith("/api/")) {
        return await handleApi(req, url);
      }

      // Static: require auth except login page assets are behind auth too —
      // login page itself is the only public HTML; we serve index always but
      // API is gated. For stronger gate, require auth for static except /login paths.
      // Spec: ALL routes require access key. Serve a tiny login shell without auth.
      if (url.pathname === "/login.html" || url.pathname === "/login.css") {
        return serveStatic(url.pathname);
      }
      // Allow unauthenticated GET / to show login UI embedded in index (SPA checks /api/me)
      if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname.startsWith("/assets/")) {
        return serveStatic(url.pathname === "/" ? "/index.html" : url.pathname);
      }
      // CSS/JS for the SPA
      if (url.pathname === "/app.js" || url.pathname === "/style.css") {
        return serveStatic(url.pathname);
      }

      if (!isAuthorized(req, accessKey)) {
        return json({ error: "未授权" }, 401);
      }
      return serveStatic(url.pathname);
    } catch (e) {
      console.error(e);
      return err(e);
    }
  },
  websocket: {
    async open(ws) {
      if (ws.data.kind !== "term") return;
      try {
        const container = box.docker.getContainer(ws.data.boxId);
        const exec = await container.exec({
          Cmd: ["/bin/bash", "-l"],
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: true,
        });
        ws.data.execId = exec.id;
        const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
        ws.data.stream = stream;
        stream.on("data", (chunk: Buffer) => {
          try {
            ws.send(chunk);
          } catch {}
        });
        stream.on("end", () => {
          try {
            ws.close();
          } catch {}
        });
        stream.on("error", () => {
          try {
            ws.close();
          } catch {}
        });
      } catch (e: any) {
        ws.send(`\r\n[终端启动失败] ${e.message || e}\r\n`);
        ws.close();
      }
    },
    message(ws, message) {
      const stream = ws.data.stream;
      if (!stream) return;
      const buf = typeof message === "string" ? Buffer.from(message) : Buffer.from(message);
      // resize protocol: {"type":"resize","cols":n,"rows":n}
      if (buf[0] === 0x7b /* { */) {
        try {
          const msg = JSON.parse(buf.toString("utf8"));
          if (msg.type === "resize" && ws.data.execId) {
            box.docker.getExec(ws.data.execId).resize({ h: msg.rows, w: msg.cols }).catch(() => {});
            return;
          }
        } catch {
          // fall through as stdin
        }
      }
      stream.write(buf);
    },
    close(ws) {
      try {
        ws.data.stream?.end?.();
        ws.data.stream?.destroy?.();
      } catch {}
    },
  },
});

console.log(`[minibox] Bun ${Bun.version} listening on http://${host}:${port}`);
console.log(`[minibox] ACCESS_KEY stored in ${join(ROOT, ".env")}`);
console.log(`[minibox] key prefix: ${accessKey.slice(0, 8)}…`);

export { server, accessKey, port, host };
