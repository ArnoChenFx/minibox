/** Local preview mounted at the same /minibox/ prefix as GitHub Pages. */
import { resolve, sep } from "node:path";

const directory = resolve(import.meta.dir, "../dist/site");
const port = Number(process.env.SITE_PORT ?? 4173);
const prefix = "/minibox/";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/minibox") return Response.redirect(new URL(prefix, url).href, 302);
    if (!url.pathname.startsWith(prefix)) return new Response("Not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
    let relative: string;
    try {
      relative = decodeURIComponent(url.pathname.slice(prefix.length)) || "index.html";
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    const path = resolve(directory, relative);
    if (!path.startsWith(`${directory}${sep}`)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : file, { headers: { "Content-Type": file.type } });
  },
});
console.log(`Homepage preview: ${server.url}minibox/`);
