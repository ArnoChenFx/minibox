import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { utils } from "ssh2";

import { TargetFailure } from "../src/targets/errors";
import { openSession } from "../src/targets/open";
import { openS3Session } from "../src/targets/s3";
import type { SftpConnection, S3Connection, TargetSession } from "../src/targets/session";
import { silenceLogs } from "./support/app";
import { type S3Double, startS3Double } from "./support/s3-double";
import { type SftpDouble, startSftpDouble } from "./support/sftp-double";

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
    const stranger = utils.generateKeyPairSync("ed25519").private;
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
