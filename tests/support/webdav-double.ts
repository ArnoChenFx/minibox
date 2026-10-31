export type XmlStyle = "d" | "D" | "default";

export interface WebdavDoubleOptions {
  readonly user: string;
  readonly password: string;
  /** A path the collection sits under, such as `remote.php/dav/files/u`, the way Nextcloud serves one. */
  readonly prefix?: string;
  /** The namespace prefix the multistatus body uses. A real server picks one of them. */
  readonly style?: XmlStyle;
  /** Whether the collection itself exists. False makes every request answer 404. */
  readonly root?: boolean;
  /** Answers every request with 200 and an HTML body, the way a web server that is not WebDAV does. */
  readonly html?: boolean;
  /** Writes hrefs as absolute URLs instead of absolute paths. */
  readonly absoluteHref?: boolean;
  /** Writes hrefs with spaces and other characters left as they are, instead of percent-encoded. */
  readonly rawHref?: boolean;
  /** Splits each response's properties over a propstat that fails and one that succeeds. */
  readonly splitProps?: boolean;
  /** File paths whose response leaves out `getcontentlength`, so a client has to ask with HEAD. */
  readonly hideSize?: readonly string[];
  /** A HEAD that answers with no length at all, the way a server that does not report a size answers. */
  readonly hideHeadSize?: boolean;
  /** An href added to every listing, to see whether a client drops one that is not in the folder. */
  readonly strayHref?: string;
}

export interface WebdavDouble {
  /** The address of the collection: the base URL of the server, with the prefix. */
  readonly url: string;
  readonly user: string;
  readonly password: string;
  /** Files by path relative to the collection, such as `packages/pk_….mbckpt`. */
  readonly files: Map<string, Uint8Array>;
  /** Collections that exist, by path relative to the collection. The collection itself is `""`. */
  readonly collections: Set<string>;
  /** Every request as `METHOD path`, in order. */
  readonly requests: string[];
  /** The headers of every request, in order. A test asserts what a PUT sent, such as a content length. */
  readonly requestHeaders: Record<string, string>[];
  /** Makes the next `times` requests that match fail with `status`. */
  failNext(match: (method: string, path: string) => boolean, status: number, times?: number): void;
  /** Makes the next `times` requests that match answer `status` with a `Location` header. */
  redirectNext(
    match: (method: string, path: string) => boolean,
    location: string,
    status?: number,
    times?: number,
  ): void;
  stop(): void;
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  207: "Multi-Status",
  301: "Moved Permanently",
  302: "Found",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
};

interface Rule {
  readonly match: (method: string, path: string) => boolean;
  readonly status: number;
  readonly location: string | null;
  left: number;
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function segmentsOf(path: string): string[] {
  return path
    .split("/")
    .filter((part) => part !== "")
    .map(safeDecode);
}

/** The XML prefix and namespace attribute one of the styles a server may use. */
function prefixOf(style: XmlStyle): { p: string; xmlns: string } {
  if (style === "default") return { p: "", xmlns: `xmlns="DAV:"` };
  return { p: `${style}:`, xmlns: `xmlns:${style}="DAV:"` };
}

/**
 * A WebDAV server on 127.0.0.1 that keeps its files in memory and checks HTTP Basic credentials on every request. It
 * answers the six methods a target uses: PROPFIND at depth 0 and 1, MKCOL, GET, PUT, DELETE and HEAD. Only loopback http
 * is served, since the target refuses plain http anywhere else.
 */
function statusResponse(status: number): Response {
  const text = STATUS_TEXT[status] ?? "";
  return new Response(status === 204 || status === 401 ? null : text, {
    status,
    headers: status === 401 ? { "www-authenticate": 'Basic realm="dav"' } : undefined,
  });
}

export function startWebdavDouble(options: WebdavDoubleOptions): WebdavDouble {
  const style = options.style ?? "d";
  const { p, xmlns } = prefixOf(style);
  const prefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
  const rootPath = prefix === "" ? "" : `/${prefix}`;
  const files = new Map<string, Uint8Array>();
  const collections = new Set<string>();
  const requests: string[] = [];
  const requestHeaders: Record<string, string>[] = [];
  const rules: Rule[] = [];
  const hidden = new Set(options.hideSize ?? []);
  const expected = `Basic ${base64(`${options.user}:${options.password}`)}`;
  let origin = "";

  if (options.root !== false) collections.add("");

  /** The path of a resource relative to the collection, or null when the request is outside it. */
  const relativeOf = (pathname: string): string | null => {
    if (rootPath !== "" && pathname !== rootPath && !pathname.startsWith(`${rootPath}/`)) return null;
    const rest = pathname.slice(rootPath.length);
    return segmentsOf(rest).join("/");
  };

  const hrefOf = (relative: string, collection: boolean): string => {
    const segments = relative === "" ? [] : relative.split("/");
    const encoded = options.rawHref === true ? segments : segments.map((part) => encodeURIComponent(part));
    const path = `${rootPath}/${encoded.join("/")}`;
    const href = options.absoluteHref === true ? `${origin}${path}` : path;
    return collection && !href.endsWith("/") ? `${href}/` : href;
  };

  const propsOf = (relative: string, collection: boolean): string => {
    const type = collection ? `<${p}resourcetype><${p}collection/></${p}resourcetype>` : `<${p}resourcetype/>`;
    if (collection) return type;
    const stored = files.get(relative);
    const bytes = stored?.byteLength ?? 0;
    const length = hidden.has(relative) ? "" : `<${p}getcontentlength>${bytes}</${p}getcontentlength>`;
    const modified = `<${p}getlastmodified>${new Date(0).toUTCString()}</${p}getlastmodified>`;
    return `${type}${length}${modified}`;
  };

  const responseOf = (relative: string, collection: boolean): string => {
    const href = `<${p}href>${escapeXml(hrefOf(relative, collection))}</${p}href>`;
    const good = `<${p}propstat><${p}prop>${propsOf(relative, collection)}</${p}prop><${p}status>HTTP/1.1 200 OK</${p}status></${p}propstat>`;
    if (options.splitProps !== true) return `<${p}response>${href}${good}</${p}response>`;
    // A property refused in one propstat and reported in another. Only the one that succeeded counts.
    const refused = `<${p}propstat><${p}prop><${p}getcontentlength/><${p}resourcetype><${p}collection/></${p}resourcetype></${p}prop><${p}status>HTTP/1.1 404 Not Found</${p}status></${p}propstat>`;
    return `<${p}response>${href}${refused}${good}</${p}response>`;
  };

  const childrenOf = (relative: string): string[] => {
    const under = relative === "" ? "" : `${relative}/`;
    const depth = relative === "" ? 1 : relative.split("/").length + 1;
    const names: string[] = [];
    for (const name of [...files.keys(), ...collections]) {
      if (name === relative || !name.startsWith(under)) continue;
      if (name.split("/").length !== depth) continue;
      names.push(name);
    }
    return names.toSorted();
  };

  const strayResponse = (href: string): string =>
    `<${p}response><${p}href>${escapeXml(href)}</${p}href><${p}propstat><${p}prop><${p}resourcetype/><${p}getcontentlength>3</${p}getcontentlength></${p}prop><${p}status>HTTP/1.1 200 OK</${p}status></${p}propstat></${p}response>`;

  const multistatus = (entries: string[]): Response =>
    new Response(
      `<?xml version="1.0" encoding="utf-8"?>\n<${p}multistatus ${xmlns}>${entries.join("")}</${p}multistatus>`,
      {
        status: 207,
        headers: { "content-type": "application/xml; charset=utf-8" },
      },
    );

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      for (const [name, value] of req.headers) headers[name] = value;
      requests.push(`${req.method} ${url.pathname}`);
      requestHeaders.push(headers);

      if (options.html === true) {
        return new Response("<!doctype html><title>not webdav</title>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (headers.authorization !== expected) return statusResponse(401);
      const relative = relativeOf(url.pathname);
      if (relative === null) return statusResponse(404);

      const rule = rules.find((candidate) => candidate.left > 0 && candidate.match(req.method, relative));
      if (rule !== undefined) {
        rule.left -= 1;
        if (rule.location === null) return statusResponse(rule.status);
        return new Response(null, { status: rule.status, headers: { location: rule.location } });
      }

      if (req.method === "PROPFIND") {
        const depth = headers.depth ?? "0";
        const isFile = files.has(relative);
        const isCollection = collections.has(relative);
        if (!isFile && !isCollection) return statusResponse(404);
        const entries = [responseOf(relative, isCollection)];
        if (depth === "1" && isCollection) {
          for (const child of childrenOf(relative)) entries.push(responseOf(child, collections.has(child)));
          if (options.strayHref !== undefined) entries.push(strayResponse(options.strayHref));
        }
        return multistatus(entries);
      }

      if (req.method === "MKCOL") {
        if (files.has(relative) || collections.has(relative)) return statusResponse(405);
        const parent = relative.split("/").slice(0, -1).join("/");
        if (!collections.has(parent)) return statusResponse(409);
        collections.add(relative);
        return statusResponse(201);
      }

      if (req.method === "PUT") {
        const parent = relative.split("/").slice(0, -1).join("/");
        if (!collections.has(parent)) return statusResponse(409);
        const body = await req.arrayBuffer().catch(() => null);
        if (body === null) return statusResponse(400);
        const existed = files.has(relative);
        files.set(relative, new Uint8Array(body));
        return statusResponse(existed ? 204 : 201);
      }

      if (req.method === "GET" || req.method === "HEAD") {
        const stored = files.get(relative);
        if (stored === undefined) return statusResponse(404);
        if (req.method === "HEAD" && options.hideHeadSize === true) return statusResponse(204);
        const headers: Record<string, string> = {
          "content-type": "application/octet-stream",
          "last-modified": new Date(0).toUTCString(),
          "content-length": String(stored.byteLength),
        };
        return req.method === "HEAD"
          ? new Response(null, { status: 200, headers })
          : new Response(stored, { status: 200, headers });
      }

      if (req.method === "DELETE") {
        if (!files.delete(relative)) return statusResponse(404);
        return statusResponse(204);
      }

      return statusResponse(405);
    },
  });

  origin = `http://127.0.0.1:${server.port}`;

  return {
    url: `${origin}${rootPath}`,
    user: options.user,
    password: options.password,
    files,
    collections,
    requests,
    requestHeaders,
    failNext(match, status, times = 1) {
      rules.push({ match, status, location: null, left: times });
    },
    redirectNext(match, location, status = 301, times = 1) {
      rules.push({ match, status, location, left: times });
    },
    stop() {
      server.stop(true);
    },
  };
}
