import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { classifyFailure, TargetFailure } from "../src/targets/errors";
import { openSession } from "../src/targets/open";
import { openS3Session } from "../src/targets/s3";
import type { SftpConnection, S3Connection, TargetSession, WebdavConnection } from "../src/targets/session";
import { entryName, parseMultistatus } from "../src/targets/webdav-xml";
import { silenceLogs } from "./support/app";
import { type S3Double, startS3Double } from "./support/s3-double";
import { newEd25519Key, type SftpDouble, startSftpDouble } from "./support/sftp-double";
import { type WebdavDouble, type WebdavDoubleOptions, startWebdavDouble } from "./support/webdav-double";

const ACCESS_KEY = "AKIATESTONLY0001";
const SECRET_KEY = "test-only-secret-key-0001";
const PACKAGE = "packages/pk_aaaaaaaa.mbckpt";
const UNREACHABLE = "http://127.0.0.1:9";

function chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  return (async function* () {
    for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
  })();
}

function failingAfter(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  return (async function* () {
    yield bytes;
    throw new Error("the source stopped");
  })();
}

async function drain(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

async function reasonOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    return e instanceof TargetFailure ? e.reason : `unclassified: ${String(e)}`;
  }
  return "no error";
}

describe("S3-compatible target adapter", () => {
  let double: S3Double;
  let session: TargetSession | null = null;

  const connection = (overrides: Partial<S3Connection> = {}): S3Connection => ({
    kind: "s3",
    endpoint: double.endpoint,
    region: double.region,
    bucket: double.bucket,
    path: "minibox",
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    ...overrides,
  });

  beforeEach(() => {
    silenceLogs();
    double = startS3Double({ accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, bucket: "backups", pageSize: 2 });
  });

  afterEach(async () => {
    await session?.close();
    session = null;
    double.stop();
  });

  test("writes an object, then stats, lists and reads it back", async () => {
    session = openS3Session(connection());
    await session.probe();
    const bytes = randomBytes(300_000);
    await session.write(PACKAGE, chunked(bytes, 64 * 1024));

    expect(double.objects.get(`minibox/${PACKAGE}`)).toEqual(bytes);
    expect(await session.stat(PACKAGE)).toMatchObject({ name: PACKAGE, bytes: bytes.length });
    expect((await session.list("packages")).map((object) => object.name)).toEqual([PACKAGE]);
    expect(await drain(await session.read(PACKAGE))).toEqual(bytes);
  });

  test("completes a multipart upload across parts", async () => {
    session = openS3Session(connection());
    const bytes = randomBytes(9 * 1024 * 1024 + 17);
    await session.write(PACKAGE, chunked(bytes, 1024 * 1024));

    expect(double.objects.get(`minibox/${PACKAGE}`)).toEqual(bytes);
    expect(double.openUploads()).toBe(0);
  });

  test("lists every page of a folder through the continuation token", async () => {
    session = openS3Session(connection());
    for (let i = 0; i < 5; i++)
      await session.write(`backups/bk_${String(i).padStart(8, "0")}.mbbak`, chunked(new Uint8Array([i]), 1));

    const names = (await session.list("backups")).map((object) => object.name).toSorted();
    expect(names).toHaveLength(5);
    expect(names[0]).toBe("backups/bk_00000000.mbbak");
    expect(double.requests.filter((request) => request.includes("continuation-token")).length).toBeGreaterThan(0);
  });

  test("removes the partial object when the source fails midway", async () => {
    session = openS3Session(connection());
    const bytes = randomBytes(9 * 1024 * 1024);

    expect(await reasonOf(() => session!.write(PACKAGE, failingAfter(bytes)))).toBe("failed");
    expect(double.objects.has(`minibox/${PACKAGE}`)).toBe(false);
    expect(double.openUploads()).toBe(0);
    expect(double.requests.at(-1)).toBe(`DELETE /backups/minibox/${PACKAGE}`);
  });

  test("removes a small partial object too, where the writer sends one request", async () => {
    session = openS3Session(connection());
    expect(await reasonOf(() => session!.write(PACKAGE, failingAfter(new Uint8Array([1, 2, 3]))))).toBe("failed");
    expect(double.objects.has(`minibox/${PACKAGE}`)).toBe(false);
  });

  test("reports a missing object as absent for a stat and as missing for a read", async () => {
    session = openS3Session(connection());
    expect(await session.stat("packages/pk_bbbbbbbb.mbckpt")).toBeNull();
    expect(await reasonOf(() => session!.read("packages/pk_bbbbbbbb.mbckpt"))).toBe("missing");
  });

  test("refuses a wrong secret key as an authentication failure", async () => {
    session = openS3Session(connection({ secretAccessKey: "not-the-secret-key-0002" }));
    expect(await reasonOf(() => session!.probe())).toBe("auth");
  });

  test("reports an access denial from the service as forbidden", async () => {
    double.failNext((_method, key) => key.endsWith(".mbckpt"), 403, "AccessDenied", 20);
    session = openS3Session(connection());
    expect(await reasonOf(() => session!.write(PACKAGE, chunked(new Uint8Array([1, 2, 3]), 3)))).toBe("forbidden");
  });

  test("reports a service that is not listening as unreachable", async () => {
    session = openS3Session(connection({ endpoint: UNREACHABLE }));
    expect(await reasonOf(() => session!.probe())).toBe("unreachable");
  });

  test("is opened through the dispatcher by kind", async () => {
    session = await openSession(connection());
    await session.probe();
  });
});

describe("SFTP target adapter", () => {
  let double: SftpDouble;
  let session: TargetSession | null = null;

  const connection = (overrides: Partial<SftpConnection> = {}): SftpConnection => ({
    kind: "sftp",
    host: double.host,
    port: double.port,
    user: "minibox",
    path: "minibox",
    privateKey: double.privateKey,
    hostKeyFingerprint: double.hostKeyFingerprint,
    ...overrides,
  });

  const onDisk = (...parts: string[]) => join(double.root, ...parts);

  beforeEach(async () => {
    silenceLogs();
    double = await startSftpDouble();
  });

  afterEach(async () => {
    await session?.close();
    session = null;
    await double.close();
  });

  test("writes an object under the pinned host key, then reads it back", async () => {
    session = await openSession(connection());
    await session.probe();
    const bytes = randomBytes(200_000);
    await session.write(PACKAGE, chunked(bytes, 50_000));

    expect(new Uint8Array(await Bun.file(onDisk("minibox", PACKAGE)).arrayBuffer())).toEqual(bytes);
    expect(await session.stat(PACKAGE)).toMatchObject({ name: PACKAGE, bytes: bytes.length });
    expect((await session.list("packages")).map((object) => object.name)).toEqual([PACKAGE]);
    expect(await drain(await session.read(PACKAGE))).toEqual(bytes);
  });

  test("replaces an object by writing it again", async () => {
    session = await openSession(connection());
    await session.write(PACKAGE, chunked(new TextEncoder().encode("first version"), 4));
    await session.write(PACKAGE, chunked(new TextEncoder().encode("second"), 4));
    expect((await drain(await session.read(PACKAGE))).toString()).toBe("second");
  });

  test("leaves neither the object nor a partial file when the source fails", async () => {
    session = await openSession(connection());
    expect(await reasonOf(() => session!.write(PACKAGE, failingAfter(randomBytes(70_000))))).toBe("failed");
    expect(readdirSync(onDisk("minibox", "packages"))).toEqual([]);
  });

  test("reports a missing object as absent for a stat and as missing for a read", async () => {
    session = await openSession(connection());
    expect(await session.stat("packages/pk_bbbbbbbb.mbckpt")).toBeNull();
    expect(await reasonOf(() => session!.read("packages/pk_bbbbbbbb.mbckpt"))).toBe("missing");
    expect(await session.list("never-created")).toEqual([]);
  });

  test("does not create the folder for a connection test", async () => {
    session = await openSession(connection({ path: "fresh/folder" }));
    await session.probe();
    expect(existsSync(onDisk("fresh"))).toBe(false);
  });

  test("refuses a server that presents another host key, and sends no login", async () => {
    const attempt = openSession(connection({ hostKeyFingerprint: "SHA256:not-the-pinned-key" }));
    const failure = await attempt.then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(TargetFailure);
    expect((failure as TargetFailure).reason).toBe("host_key_mismatch");
    expect((failure as TargetFailure).fingerprint).toBe(double.hostKeyFingerprint);
    expect(double.requests).toEqual([]);
  });

  test("asks for confirmation of a host key that is not pinned yet", async () => {
    const failure = await openSession(connection({ hostKeyFingerprint: null })).then(
      () => null,
      (e: unknown) => e,
    );
    expect((failure as TargetFailure).reason).toBe("host_key_unconfirmed");
    expect((failure as TargetFailure).fingerprint).toBe(double.hostKeyFingerprint);
  });

  test("refuses a login whose key the server does not hold", async () => {
    const stranger = newEd25519Key();
    expect(await reasonOf(() => openSession(connection({ privateKey: stranger })))).toBe("auth");
  });

  test("creates nested folders on first write", async () => {
    session = await openSession(connection({ path: "" }));
    await session.write("backups/bk_aaaaaaaa.mbbak", chunked(new Uint8Array([9]), 1));
    expect(existsSync(onDisk("backups", "bk_aaaaaaaa.mbbak"))).toBe(true);
  });

  test("refuses a path that exists as a file", async () => {
    mkdirSync(onDisk("minibox"), { recursive: true });
    writeFileSync(onDisk("minibox", "packages"), "not a folder");
    session = await openSession(connection());
    expect(await reasonOf(() => session!.write(PACKAGE, chunked(new Uint8Array([1]), 1)))).toBe("failed");
  });
});

/** A file the server already holds, with the folders above it, as a previous push would have left them. */
function stored(server: WebdavDouble, name: string, bytes: Uint8Array): void {
  const parts = name.split("/");
  for (let at = 1; at < parts.length; at += 1) server.collections.add(parts.slice(0, at).join("/"));
  server.files.set(name, bytes);
}

describe("WebDAV target adapter", () => {
  let double: WebdavDouble;
  let session: TargetSession | null = null;
  const started: WebdavDouble[] = [];

  const start = (options: Partial<WebdavDoubleOptions> = {}): WebdavDouble => {
    const started0 = startWebdavDouble({ user: "minibox@example.com", password: "app-password-0001", ...options });
    started.push(started0);
    return started0;
  };

  const connection = (overrides: Partial<WebdavConnection> = {}): WebdavConnection => ({
    kind: "webdav",
    url: double.url,
    user: double.user,
    password: double.password,
    path: "minibox",
    ...overrides,
  });

  beforeEach(() => {
    silenceLogs();
    started.length = 0;
    double = start();
  });

  afterEach(async () => {
    await session?.close();
    session = null;
    for (const server of started) server.stop();
  });

  test("writes an object, then stats, lists and reads it back", async () => {
    session = await openSession(connection());
    await session.probe();
    const bytes = randomBytes(200_000);
    await session.write(PACKAGE, chunked(bytes, 60_000), bytes.length);

    expect(double.files.get(`minibox/${PACKAGE}`)).toEqual(bytes);
    expect(await session.stat(PACKAGE)).toMatchObject({ name: PACKAGE, bytes: bytes.length });
    expect((await session.list("packages")).map((object) => object.name)).toEqual([PACKAGE]);
    expect(await drain(await session.read(PACKAGE))).toEqual(bytes);
    expect(await session.list("never-created")).toEqual([]);
  });

  test("creates each folder once, and only the folders a write needs", async () => {
    session = await openSession(connection());
    await session.write(PACKAGE, chunked(new Uint8Array([1]), 1), 1);
    await session.write("packages/pk_bbbbbbbb.mbckpt", chunked(new Uint8Array([2]), 1), 1);
    await session.write("backups/bk_aaaaaaaa.mbbak", chunked(new Uint8Array([3]), 1), 1);

    expect(double.requests.filter((request) => request.startsWith("MKCOL "))).toEqual([
      "MKCOL /minibox",
      "MKCOL /minibox/packages",
      "MKCOL /minibox/backups",
    ]);
  });

  test("deletes what a write left behind when its source fails midway", async () => {
    session = await openSession(connection());
    const bytes = randomBytes(50_000);
    expect(await reasonOf(() => session!.write(PACKAGE, failingAfter(bytes), bytes.length))).toBe("failed");

    expect(double.files.has(`minibox/${PACKAGE}`)).toBe(false);
    expect(double.requests.at(-1)).toBe(`DELETE /minibox/${PACKAGE}`);
  });

  test("reports a missing object as absent for a stat and as missing for a read", async () => {
    session = await openSession(connection());
    expect(await session.stat("packages/pk_bbbbbbbb.mbckpt")).toBeNull();
    expect(await reasonOf(() => session!.read("packages/pk_bbbbbbbb.mbckpt"))).toBe("missing");
  });

  test("refuses credentials the server does not accept", async () => {
    session = await openSession(connection({ password: "wrong-password-0001" }));
    expect(await reasonOf(() => session!.probe())).toBe("auth");
  });

  test("reports an access denial as forbidden", async () => {
    double.failNext(() => true, 403);
    session = await openSession(connection());
    expect(await reasonOf(() => session!.probe())).toBe("forbidden");
  });

  test("reports a server that is not listening as unreachable", async () => {
    session = await openSession(connection({ url: UNREACHABLE }));
    expect(await reasonOf(() => session!.probe())).toBe("unreachable");
  });

  test("says an address that answers with a web page is not a WebDAV service", async () => {
    const plain = start({ html: true });
    session = await openSession({ kind: "webdav", url: plain.url, user: "u", password: "p", path: "" });

    const failure = await session.probe().then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(TargetFailure);
    expect((failure as TargetFailure).reason).toBe("failed");
    expect((failure as TargetFailure).message).toContain("does not look like a WebDAV service (status 200)");
    expect(plain.requests).toHaveLength(1);
  });

  test("follows a redirect that stays on the same server", async () => {
    session = await openSession(connection());
    await session.write(PACKAGE, chunked(new Uint8Array([1, 2, 3]), 3), 3);
    const other = new Uint8Array([7, 8, 9]);
    double.files.set("minibox/packages/other.bin", other);
    double.redirectNext(
      (method, path) => method === "GET" && path === `minibox/${PACKAGE}`,
      `${double.url}/minibox/packages/other.bin`,
    );

    expect(await drain(await session.read(PACKAGE))).toEqual(Buffer.from(other));
    expect(double.requests.filter((request) => request.startsWith("GET "))).toHaveLength(2);
  });

  test("does not follow a redirect to another address, and sends it nothing", async () => {
    const elsewhere = start();
    session = await openSession(connection());
    await session.write(PACKAGE, chunked(new Uint8Array([1, 2, 3]), 3), 3);
    double.redirectNext((method) => method === "GET", `${elsewhere.url}/minibox/${PACKAGE}`);

    const failure = await session.read(PACKAGE).then(
      () => null,
      (e: unknown) => e,
    );
    expect((failure as TargetFailure).reason).toBe("failed");
    expect((failure as TargetFailure).message).toContain(`redirected the request to ${new URL(elsewhere.url).origin}`);
    expect(elsewhere.requests).toEqual([]);
  });

  test("sends a known size as a content length, and no chunked encoding", async () => {
    session = await openSession(connection());
    const bytes = randomBytes(1000);
    await session.write(PACKAGE, chunked(bytes, 300), bytes.length);

    const put = double.requestHeaders[double.requests.findIndex((request) => request.startsWith("PUT "))];
    expect(put?.["content-length"]).toBe(String(bytes.length));
    expect(put?.["transfer-encoding"]).toBeUndefined();
    expect(double.files.get(`minibox/${PACKAGE}`)).toEqual(bytes);
  });

  test("sends a body of unknown size as a chunked stream", async () => {
    session = await openSession(connection());
    await session.write("packages/pk_cccccccc.mbckpt", chunked(randomBytes(700), 200));

    const put = double.requestHeaders[double.requests.findIndex((request) => request.startsWith("PUT "))];
    expect(put?.["content-length"]).toBeUndefined();
    expect(put?.["transfer-encoding"]).toBe("chunked");
  });

  test("round-trips names with spaces, Chinese, a plus and an ampersand", async () => {
    session = await openSession(connection());
    const name = "packages/pk_中文 名字+x&y.mbckpt";
    const bytes = new TextEncoder().encode(name);
    await session.write(name, chunked(bytes, 3), bytes.length);

    expect(await drain(await session.read(name))).toEqual(Buffer.from(bytes));
    expect((await session.list("packages")).map((object) => object.name)).toEqual([name]);
  });

  test("lists a folder whose server leaves the names unencoded too", async () => {
    double = start({ rawHref: true });
    stored(double, "minibox/packages/pk_中文 名字+x&y.mbckpt", new Uint8Array([1]));
    session = await openSession(connection());

    expect((await session.list("packages")).map((object) => object.name)).toEqual(["packages/pk_中文 名字+x&y.mbckpt"]);
  });

  test("leaves out an href that is not directly inside the folder", async () => {
    double = start({ strayHref: "/elsewhere/pk_evil000001.mbckpt" });
    session = await openSession(connection());
    await session.write(PACKAGE, chunked(new Uint8Array([1]), 1), 1);

    expect((await session.list("packages")).map((object) => object.name)).toEqual([PACKAGE]);
  });

  test("lists the same objects whatever namespace prefix the server uses", async () => {
    for (const style of ["d", "D", "default"] as const) {
      const server = start({ style, splitProps: true });
      stored(server, `minibox/${PACKAGE}`, new Uint8Array([1, 2, 3]));
      const opened = await openSession({
        kind: "webdav",
        url: server.url,
        user: server.user,
        password: server.password,
        path: "minibox",
      });
      try {
        expect([style, (await opened.list("packages")).map((object) => [object.name, object.bytes])]).toEqual([
          style,
          [[PACKAGE, 3]],
        ]);
      } finally {
        await opened.close();
      }
    }
  });

  test("asks with HEAD for the size of a file that a listing leaves out", async () => {
    double = start({ hideSize: [`minibox/${PACKAGE}`] });
    stored(double, `minibox/${PACKAGE}`, randomBytes(4321));
    session = await openSession(connection());

    expect(await session.list("packages")).toEqual([{ name: PACKAGE, bytes: 4321, modifiedAt: expect.any(String) }]);
    expect(double.requests.some((request) => request.startsWith("HEAD "))).toBe(true);
  });

  test("says so when the server reports no size at all", async () => {
    double = start({ hideSize: [`minibox/${PACKAGE}`], hideHeadSize: true });
    stored(double, `minibox/${PACKAGE}`, randomBytes(10));
    session = await openSession(connection());

    const failure = await session.list("packages").then(
      () => null,
      (e: unknown) => e,
    );
    expect((failure as TargetFailure).reason).toBe("failed");
    expect((failure as TargetFailure).message).toContain(`did not report the size of ${PACKAGE}`);
  });

  test("does not create the folder for a connection test", async () => {
    session = await openSession(connection({ path: "fresh/folder" }));
    await session.probe();

    expect(double.requests.filter((request) => request.startsWith("MKCOL "))).toEqual([]);
    expect(double.collections.has("fresh")).toBe(false);
  });

  test("reports an address that does not exist as one to check", async () => {
    const empty = start({ root: false });
    session = await openSession({
      kind: "webdav",
      url: empty.url,
      user: empty.user,
      password: empty.password,
      path: "minibox",
    });

    const failure = await session.probe().then(
      () => null,
      (e: unknown) => e,
    );
    expect((failure as TargetFailure).reason).toBe("failed");
    expect((failure as TargetFailure).message).toContain("does not exist");
  });

  test("is opened through the dispatcher by kind", async () => {
    session = await openSession(connection());
    await session.probe();
  });
});

function withPrefix(p: string, xmlns: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<${p}multistatus ${xmlns}>
  <${p}response>
    <${p}href>/dav/files/u/packages/pk_a%20b.mbckpt</${p}href>
    <${p}propstat>
      <${p}prop><${p}getcontentlength>12</${p}getcontentlength></${p}prop>
      <${p}status>HTTP/1.1 200 OK</${p}status>
    </${p}propstat>
    <${p}propstat>
      <${p}prop><${p}quota-used-bytes/></${p}prop>
      <${p}status>HTTP/1.1 404 Not Found</${p}status>
    </${p}propstat>
  </${p}response>
  <${p}response>
    <${p}href>/dav/files/u/packages/</${p}href>
    <${p}propstat>
      <${p}prop><${p}resourcetype><${p}collection/></${p}resourcetype></${p}prop>
      <${p}status>HTTP/1.1 200 OK</${p}status>
    </${p}propstat>
  </${p}response>
</${p}multistatus>`;
}

describe("WebDAV multistatus parsing", () => {
  test("reads a body whatever namespace prefix the server writes", () => {
    for (const [p, xmlns] of [
      ["d:", 'xmlns:d="DAV:"'],
      ["D:", 'xmlns:D="DAV:"'],
      ["lp1:", 'xmlns:lp1="DAV:"'],
      ["", 'xmlns="DAV:"'],
    ] as const) {
      expect([p, parseMultistatus(withPrefix(p, xmlns))]).toEqual([
        p,
        [
          { href: "/dav/files/u/packages/pk_a%20b.mbckpt", collection: false, bytes: 12, modifiedAt: null },
          { href: "/dav/files/u/packages/", collection: true, bytes: null, modifiedAt: null },
        ],
      ]);
    }
  });

  test("decodes XML entities in an href, and reads a date", () => {
    const body = `<multistatus xmlns="DAV:"><response><href>/dav/x&amp;y&#x4e2d;&#25991;.mbckpt</href><propstat><prop><getcontentlength>3</getcontentlength><getlastmodified>Mon, 01 Jan 2024 00:00:00 GMT</getlastmodified></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
    expect(parseMultistatus(body)).toEqual([
      { href: "/dav/x&y中文.mbckpt", collection: false, bytes: 3, modifiedAt: "Mon, 01 Jan 2024 00:00:00 GMT" },
    ]);
  });

  test("ignores a property that only a propstat that failed reports", () => {
    const body = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/a.mbckpt</d:href><d:propstat><d:prop><d:getcontentlength>7</d:getcontentlength><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>`;
    expect(parseMultistatus(body)).toEqual([
      { href: "/dav/a.mbckpt", collection: false, bytes: null, modifiedAt: null },
    ]);
  });

  test("a response that failed as a whole is left out", () => {
    const body = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/a.mbckpt</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response></d:multistatus>`;
    expect(parseMultistatus(body)).toEqual([]);
  });

  test("names an href that is directly inside the collection, and no other", () => {
    const collection = new URL("https://host/remote.php/dav/files/u/packages");
    expect(entryName("https://host/remote.php/dav/files/u/packages/a%20b+c.mbckpt", collection)).toBe("a b+c.mbckpt");
    expect(entryName("https://host/remote.php/dav/files/u/packages/%E4%B8%AD%E6%96%87.mbckpt", collection)).toBe(
      "中文.mbckpt",
    );
    expect(entryName("/remote.php/dav/files/u/packages/x.mbckpt", collection)).toBe("x.mbckpt");
    expect(entryName("/remote.php/dav/files/u/packages/nested/x.mbckpt", collection)).toBeNull();
    expect(entryName("/remote.php/dav/files/u/packages/", collection)).toBeNull();
    expect(entryName("/remote.php/dav/files/u/other/x.mbckpt", collection)).toBeNull();
    expect(entryName("/remote.php/dav/files/u/packages/%2E%2E/other/x.mbckpt", collection)).toBeNull();
    expect(entryName("/remote.php/dav/files/u/packages/a%2Fb.mbckpt", collection)).toBeNull();
  });
});

function withCode(code: string): Error {
  return Object.assign(new Error("the request failed"), { code });
}

describe("certificate failures", () => {
  test("a certificate the client refuses is a failure of the target, not an unreachable server", () => {
    for (const code of [
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "CERT_HAS_EXPIRED",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ]) {
      const failure = classifyFailure(withCode(code));
      expect([code, failure.reason]).toEqual([code, "failed"]);
      expect([code, failure.message]).toEqual([code, expect.stringContaining("certificate is not trusted")]);
    }
  });

  test("the text Bun reports for a self-signed certificate is read the same way", () => {
    const failure = classifyFailure(new TypeError("self signed certificate"));
    expect(failure.reason).toBe("failed");
    expect(failure.message).toContain("certificate is not trusted");
  });

  test("a server that cannot be reached stays unreachable", () => {
    expect(classifyFailure(withCode("ECONNREFUSED")).reason).toBe("unreachable");
    expect(classifyFailure(new Error("connect ECONNREFUSED 127.0.0.1:1")).reason).toBe("unreachable");
  });
});
