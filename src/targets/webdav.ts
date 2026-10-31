import { classifyFailure, TargetFailure } from "./errors";
import type { RemoteObject, TargetSession, WebdavConnection } from "./session";
import { entryName, parseMultistatus } from "./webdav-xml";

/** A property request or a folder creation gets a total time. A transfer has none: an archive may take minutes. */
const SMALL_TIMEOUT_MS = 30_000;
/**
 * A transfer that moves no byte for this long is a dead connection: a server that never reads the body, or one that stops
 * sending in the middle of a download. A transfer has no total time, since an archive may take minutes, but silence is not
 * slowness. Without this a stalled server would hold the target's lock until the process restarts.
 */
const TRANSFER_IDLE_MS = 60_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 307, 308]);
/** The properties a listing needs. Asking for them by name keeps a server from sending everything it knows. */
const PROPERTIES = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>`;
const XML_HEADERS: Readonly<Record<string, string>> = { "content-type": "application/xml; charset=utf-8" };

interface SendOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | ReadableStream<Uint8Array>;
  /** The body is a stream that cannot be sent a second time, so a redirect cannot be followed. */
  readonly streamed?: boolean;
  /** The call is small enough for a total time. */
  readonly small?: boolean;
  /**
   * Whether a redirect is followed. Every call follows one except the cleanup of a failed write: that one deletes nothing
   * rather than let the server send it to an object of its choosing.
   */
  readonly follow?: boolean;
  /** Aborts the request, which is how a stalled transfer is stopped. */
  readonly signal?: AbortSignal;
}

/**
 * The server answered an upload with a redirect. Nothing was written, so there is nothing to clean up, and the failure says
 * which address to use instead.
 */
class RedirectedUpload extends TargetFailure {
  constructor(detail: string) {
    super("failed", detail);
    this.name = "RedirectedUpload";
  }
}

function authorization(conn: WebdavConnection): string {
  return `Basic ${Buffer.from(`${conn.user}:${conn.password}`, "utf8").toString("base64")}`;
}

/** The collection a folder names: the address, the target's folder and the folder as one path, with no trailing slash. */
function collectionOf(conn: WebdavConnection, folder: string): URL {
  const url = new URL(conn.url);
  const rest = [conn.path, folder].filter((part) => part !== "").join("/");
  if (rest !== "") url.pathname = `${url.pathname.replace(/\/+$/, "")}/${rest}`;
  return url;
}

/** A child of a collection, shaped from the collection's own address, so a hostile href never decides where a call goes. */
function childOf(collection: URL, name: string): URL {
  const url = new URL(collection.href);
  url.pathname = `${collection.pathname.replace(/\/+$/, "")}/${name}`;
  return url;
}

/** The collection an object name lives in, and its own address. */
function objectOf(conn: WebdavConnection, name: string): { collection: URL; url: URL } {
  const slash = name.lastIndexOf("/");
  const folder = slash === -1 ? "" : name.slice(0, slash);
  const collection = collectionOf(conn, folder);
  return { collection, url: childOf(collection, name.slice(slash + 1)) };
}

function httpFailure(status: number, statusText: string): TargetFailure {
  if (status === 401) return new TargetFailure("auth", "the server refused the credentials (status 401)");
  if (status === 403) return new TargetFailure("forbidden", "the server denied access (status 403)");
  const reason = statusText === "" ? `status ${status}` : `status ${status} ${statusText}`;
  return new TargetFailure("failed", `the server answered ${reason}`);
}

/** Frees the connection a response holds. Nothing reads a response body here except the ones a call needs. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * One request, with the target's credentials. A same-origin redirect is followed, up to three times. A redirect to another
 * origin is refused before anything is sent to it, and a redirected upload is refused rather than sent twice.
 */
async function send(conn: WebdavConnection, method: string, url: URL, options: SendOptions = {}): Promise<Response> {
  const headers = { ...options.headers, authorization: authorization(conn) };
  let current = url;
  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      response = await fetch(current, {
        method,
        headers,
        body: options.body,
        redirect: "manual",
        signal: signalOf(options),
      });
    } catch (e) {
      throw classifyFailure(e);
    }
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    if (options.follow === false) return response;
    const location = response.headers.get("location");
    if (location === null) return response;
    await discard(response);
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new TargetFailure("failed", "the server redirected the request to an address that cannot be used");
    }
    if (next.origin !== current.origin) {
      throw new TargetFailure(
        "failed",
        `the server redirected the request to ${next.origin}, use that address instead`,
      );
    }
    if (options.streamed === true) {
      throw new RedirectedUpload(
        `the server redirected the upload to ${next.href}, so it was not sent; use that address instead`,
      );
    }
    if (hop >= MAX_REDIRECTS) throw new TargetFailure("failed", "the server redirected the request too many times");
    current = next;
  }
}

/** The signal of a request: the caller's, the total time of a small call, or both. */
function signalOf(options: SendOptions): AbortSignal | undefined {
  const signals = [options.signal, options.small === true ? AbortSignal.timeout(SMALL_TIMEOUT_MS) : undefined].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

/** A transfer that moved nothing for the idle time, which is a dead connection rather than a slow one. */
function stalledFailure(idleMs: number): TargetFailure {
  return new TargetFailure(
    "unreachable",
    `the target moved no data for ${Math.round(idleMs / 1000)}s, so it was stopped`,
  );
}

/** Whatever stopped a transfer, read as a stall when the watchdog is why it stopped. */
function transferFailure(e: unknown, guard: IdleGuard, idleMs: number): TargetFailure {
  return guard.stalled() ? stalledFailure(idleMs) : classifyFailure(e);
}

/**
 * The watchdog of one transfer: every byte that moves restarts it, and nothing moving for the idle time aborts the
 * request. A transfer has no total time, because an archive may take minutes. The abort carries no reason of its own, so
 * the failure is read as a stalled transfer only by this session, and never by another request's abort.
 */
function idleGuard(idleMs: number) {
  const controller = new AbortController();
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, idleMs);
    timer.unref?.();
  };
  arm();
  return {
    signal: controller.signal,
    beat: arm,
    /** Whether the request was stopped for moving no data, rather than for any other reason. */
    stalled: (): boolean => stalled,
    stop: (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

type IdleGuard = ReturnType<typeof idleGuard>;

/** The body of a response as text. A read that fails midway is classified, and the body is never shown. */
async function textOf(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (e) {
    throw classifyFailure(e);
  }
}

/** A PROPFIND at the given depth. Null when the resource is not there. */
async function propfind(conn: WebdavConnection, url: URL, depth: "0" | "1") {
  const response = await send(conn, "PROPFIND", url, {
    headers: { ...XML_HEADERS, depth },
    body: PROPERTIES,
    small: true,
  });
  if (response.status === 404) {
    await discard(response);
    return null;
  }
  if (response.status !== 207) {
    const failure = httpFailure(response.status, response.statusText);
    await discard(response);
    throw failure;
  }
  const body = await textOf(response);
  try {
    return parseMultistatus(body);
  } catch {
    throw new TargetFailure("failed", "the server's answer is not a WebDAV multistatus document");
  }
}

/** The size of one child, for a server that lists a file without reporting it. */
async function headSize(conn: WebdavConnection, url: URL, name: string): Promise<number> {
  const response = await send(conn, "HEAD", url, { small: true });
  const length = response.headers.get("content-length");
  await discard(response);
  if (response.status !== 200 || length === null || !/^\d+$/.test(length)) {
    throw new TargetFailure("failed", `the server did not report the size of ${name}`);
  }
  return Number(length);
}

/**
 * A WebDAV collection, such as a Nutstore folder, a Nextcloud folder or a Synology share, reached over https with HTTP
 * Basic credentials. Nothing is created until the first write: a probe and a listing only read.
 *
 * A write PUTs the object under its final name. It does not PUT a temporary name and MOVE it, because servers differ in
 * what they accept as a MOVE destination. That is safe here because a push writes the archive before its record, and a
 * target lists an object only once its record is there, so a half-written archive is never read as an object. A write
 * that fails deletes what it left when it can; when that also fails, the partial file stays until the next push of the
 * same object replaces it.
 */
export function openWebdavSession(conn: WebdavConnection, options: { readonly idleMs?: number } = {}): TargetSession {
  const idleMs = options.idleMs ?? TRANSFER_IDLE_MS;
  /** The collections this session made, by address. A second write to the same folder creates nothing. */
  const made = new Set<string>();

  const mkcol = async (url: URL): Promise<void> => {
    const response = await send(conn, "MKCOL", url, { small: true });
    const { status, statusText } = response;
    await discard(response);
    // 201 is a new collection, and 405 is one that is already there. 409 and the rest are failures.
    if (status === 201 || status === 405) return;
    if (status === 409) throw new TargetFailure("failed", `the folder ${url.pathname} has no parent on the target`);
    throw httpFailure(status, statusText);
  };

  /** Creates the folder the object goes in, one segment at a time, and never twice in one session. */
  const ensureCollection = async (collection: URL): Promise<void> => {
    const base = new URL(conn.url);
    const root = base.pathname.split("/").filter((part) => part !== "");
    const wanted = collection.pathname.split("/").filter((part) => part !== "");
    if (wanted.length <= root.length) return;
    for (let depth = root.length; depth < wanted.length; depth += 1) {
      const url = new URL(collection.origin);
      url.pathname = `/${wanted.slice(0, depth + 1).join("/")}`;
      if (made.has(url.href)) continue;
      await mkcol(url);
      made.add(url.href);
    }
  };

  return {
    async probe() {
      const missing = new TargetFailure("failed", "the WebDAV address does not exist; check the URL");
      const reached = async (url: URL): Promise<number> => {
        const response = await send(conn, "PROPFIND", url, {
          headers: { ...XML_HEADERS, depth: "0" },
          body: PROPERTIES,
          small: true,
        });
        await discard(response);
        return response.status;
      };
      const status = await reached(collectionOf(conn, ""));
      if (status === 207) return;
      if (status === 401) throw new TargetFailure("auth", "the server refused the credentials (status 401)");
      if (status === 403) throw new TargetFailure("forbidden", "the server denied access (status 403)");
      if (status === 404 && conn.path !== "") {
        // The folder is created on the first write, so the address alone is enough to go on.
        const atRoot = await reached(new URL(conn.url));
        if (atRoot === 207) return;
        if (atRoot === 401) throw new TargetFailure("auth", "the server refused the credentials (status 401)");
        if (atRoot === 403) throw new TargetFailure("forbidden", "the server denied access (status 403)");
        if (atRoot === 404) throw missing;
      }
      if (status === 404) throw missing;
      throw new TargetFailure("failed", `this address does not look like a WebDAV service (status ${status})`);
    },

    async list(folder) {
      const collection = collectionOf(conn, folder);
      const entries = await propfind(conn, collection, "1");
      if (entries === null) return [];
      const found: RemoteObject[] = [];
      let listed = 0;
      for (const entry of entries) {
        if (entry.collection) continue;
        listed += 1;
        const child = entryName(entry.href, collection);
        if (child === null) continue;
        const name = folder === "" ? child : `${folder}/${child}`;
        const bytes = entry.bytes ?? (await headSize(conn, childOf(collection, child), name));
        found.push({ name, bytes, modifiedAt: entry.modifiedAt });
      }
      // A server that lists objects under addresses of its own naming, such as a proxy that rewrites the path, is a
      // failure rather than an empty folder: an empty answer would look like a target that holds nothing.
      if (listed > 0 && found.length === 0) {
        throw new TargetFailure(
          "failed",
          `the server listed ${listed} objects that are not under ${collection.pathname}; check the address and any proxy in front of it`,
        );
      }
      return found;
    },

    async stat(name) {
      const { url } = objectOf(conn, name);
      const entries = await propfind(conn, url, "0");
      if (entries === null) return null;
      const entry = entries[0];
      if (entry === undefined || entry.collection) return null;
      const bytes = entry.bytes ?? (await headSize(conn, url, name));
      return { name, bytes, modifiedAt: entry.modifiedAt };
    },

    async read(name) {
      const { url } = objectOf(conn, name);
      const guard = idleGuard(idleMs);
      const response = await send(conn, "GET", url, { signal: guard.signal }).catch((e: unknown) => {
        guard.stop();
        throw e;
      });
      if (response.status !== 200) {
        const failure = response.status === 404 ? new TargetFailure("missing", name) : null;
        const status = httpFailure(response.status, response.statusText);
        await discard(response);
        guard.stop();
        throw failure ?? status;
      }
      if (response.body === null) {
        return chunksOf(new ReadableStream<Uint8Array>({ start: (at) => at.close() }), guard, idleMs);
      }
      return chunksOf(response.body, guard, idleMs);
    },

    async write(name, body, size) {
      const { collection, url } = objectOf(conn, name);
      await ensureCollection(collection);
      const headers: Record<string, string> = { "content-type": "application/octet-stream" };
      // A server such as nginx's DAV module or Nutstore may refuse a chunked upload, so a known length is sent up front.
      if (size !== undefined) headers["content-length"] = String(size);
      const guard = idleGuard(idleMs);
      try {
        const response = await send(conn, "PUT", url, {
          headers,
          body: streamOf(body, guard),
          streamed: true,
          signal: guard.signal,
        });
        const { status, statusText } = response;
        await discard(response);
        if (status !== 200 && status !== 201 && status !== 204) throw httpFailure(status, statusText);
      } catch (e) {
        guard.stop();
        // A redirected upload wrote nothing, and a cleanup that followed the same redirect could delete an object of the
        // server's choosing. Any other failure may have left a partial object behind, so it is removed.
        if (!(e instanceof RedirectedUpload)) await discardRemote(conn, url, idleMs);
        throw transferFailure(e, guard, idleMs);
      }
      guard.stop();
    },

    async close() {},
  };
}

/**
 * Deletes what a failed write left, and says nothing when that fails too: the write's own failure is the one reported. It
 * never follows a redirect, since a server that answers a DELETE with one is not deleting the object named here.
 */
async function discardRemote(conn: WebdavConnection, url: URL, idleMs: number): Promise<void> {
  await send(conn, "DELETE", url, { small: true, follow: false, signal: AbortSignal.timeout(idleMs) })
    .then(discard)
    .catch(() => undefined);
}

/**
 * A request body from a stream of chunks. Nothing is buffered: a package may be larger than memory. Each chunk restarts
 * the watchdog, so a server that stops reading the body is given up on rather than waited for forever.
 */
function streamOf(body: AsyncIterable<Uint8Array>, guard: IdleGuard): ReadableStream<Uint8Array> {
  const chunks = body[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      guard.beat();
      const { done, value } = await chunks.next();
      guard.beat();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      try {
        await chunks.return?.();
      } catch {
        // The source is already gone, and a cancel has nothing to report.
      }
    },
  });
}

/** The chunks of a web stream. A read that fails midway is classified, and a consumer that stops early cancels it. */
async function* chunksOf(
  stream: ReadableStream<Uint8Array>,
  guard: IdleGuard,
  idleMs: number,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let finished = false;
  try {
    for (;;) {
      guard.beat();
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      yield value;
    }
  } catch (e) {
    finished = true;
    throw transferFailure(e, guard, idleMs);
  } finally {
    guard.stop();
    if (!finished) await reader.cancel().catch(() => undefined);
  }
}
