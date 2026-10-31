import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PACKAGE_TTL_MS, PACKAGE_VERSION, writePackageFile } from "../src/checkpoints/package";
import { expiresAtFor, type PackageMeta } from "../src/checkpoints/packages";
import { CheckpointStore } from "../src/checkpoints/store";
import { targetsPath } from "../src/data-dir";
import { AppError } from "../src/lib/errors";
import { SecretStore } from "../src/secrets/store";
import { BackupService } from "../src/services/backup";
import { type TargetDraft, TargetService } from "../src/services/targets";
import { TargetFileError } from "../src/targets/store";
import { rejectionOf, silenceLogs } from "./support/app";
import { type S3Double, startS3Double } from "./support/s3-double";
import { type SftpDouble, startSftpDouble } from "./support/sftp-double";
import { type TarEntry, tarBytes } from "./support/tar";
import { type WebdavDouble, startWebdavDouble } from "./support/webdav-double";

const PASSPHRASE = "correct horse battery staple";
const ACCESS_KEY = "AKIATESTONLY0001";
const SECRET_KEY = "test-only-secret-key-0001";
const WEBDAV_USER = "minibox@example.com";
const WEBDAV_PASSWORD = "{{SECRET_l8kwv2ra}}";
const PACK = `ab${"0".repeat(62)}`;
const SNAPSHOT = "c".repeat(64);
const KEY = "d".repeat(64);

/** A restic-shaped repository, the layout a checkpoint package carries. `fill` makes each package's bytes distinct. */
function repository(fill: number): TarEntry[] {
  return [
    { name: "repo/", dir: true },
    { name: "repo/config", body: Buffer.from('{"version":2}') },
    { name: "repo/data/", dir: true },
    { name: "repo/data/ab/", dir: true },
    { name: `repo/data/ab/${PACK}`, body: Buffer.alloc(300, fill) },
    { name: "repo/snapshots/", dir: true },
    { name: `repo/snapshots/${SNAPSHOT}`, body: Buffer.from("{}") },
    { name: "repo/keys/", dir: true },
    { name: `repo/keys/${KEY}`, body: Buffer.from("{}") },
    { name: "repo/locks/", dir: true },
    { name: "repo/index/", dir: true },
  ];
}

async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

function textOf(bytes: Uint8Array | undefined): string {
  return bytes === undefined ? "" : Buffer.from(bytes).toString("utf8");
}

function errorOf(run: () => unknown): unknown {
  try {
    run();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to throw");
}

type S3Draft = Extract<TargetDraft, { kind: "s3" }>;

interface Instance {
  readonly dataDir: string;
  readonly secrets: SecretStore;
  readonly checkpoints: CheckpointStore;
  readonly backups: BackupService;
  readonly service: TargetService;
  readonly known: string[];
}

/** A package written into the instance's own packages folder, with a day to live. */
async function packageIn(instance: Instance, fill = 7): Promise<PackageMeta> {
  const { packages } = instance.checkpoints;
  const id = packages.allocateId();
  packages.begin(id);
  try {
    const digest = await writePackageFile(
      chunked(tarBytes(repository(fill)), 4096),
      packages.pathFor(id),
      packages.maxBytes,
    );
    const now = Date.now();
    const meta: PackageMeta = {
      version: PACKAGE_VERSION,
      id,
      origin: "export",
      checkpointId: null,
      hostId: null,
      createdBy: "owner",
      bytes: digest.bytes,
      sha256: digest.sha256,
      createdAt: new Date(now).toISOString(),
      expiresAt: expiresAtFor(now),
    };
    packages.write(meta);
    return meta;
  } finally {
    packages.end(id);
  }
}

const sha256Of = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

describe("off-site targets", () => {
  let double: S3Double;
  let dirs: string[];
  let restoreLogs: () => void;

  beforeEach(() => {
    restoreLogs = silenceLogs();
    dirs = [];
    double = startS3Double({ accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, bucket: "backups", pageSize: 2 });
  });

  afterEach(() => {
    double.stop();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    restoreLogs();
  });

  function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "minibox-targets-"));
    dirs.push(dir);
    return dir;
  }

  function instanceOf(dataDir = freshDir()): Instance {
    const secrets = new SecretStore(dataDir);
    const checkpoints = new CheckpointStore(dataDir, { packageMaxBytes: 16 * 1024 * 1024 });
    const backups = new BackupService({ dataDir, databases: [] });
    const known: string[] = [];
    const service = new TargetService({
      dataDir,
      secrets,
      checkpoints,
      backups,
      onSecret: (value) => known.push(value),
    });
    service.start();
    return { dataDir, secrets, checkpoints, backups, service, known };
  }

  const s3 = (path = "minibox"): S3Draft => ({
    kind: "s3",
    path,
    endpoint: double.endpoint,
    region: double.region,
    bucket: double.bucket,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
  });

  describe("the list of targets", () => {
    test("a target is added, listed and fetched without its credentials", () => {
      const inst = instanceOf();
      const view = inst.service.add("archive", s3());

      expect(view).toMatchObject({
        name: "archive",
        kind: "s3",
        address: `${double.endpoint}/backups`,
        path: "minibox",
        hostKeyFingerprint: null,
        credentials: true,
        lastSync: null,
      });
      expect(inst.service.list()).toEqual([view]);
      expect(inst.service.get(view.id)).toEqual(view);
      expect(inst.secrets.list().map((meta) => meta.name)).toEqual([
        `target.${view.id}.access-key`,
        `target.${view.id}.secret-key`,
      ]);
      expect(inst.known).toEqual(expect.arrayContaining([ACCESS_KEY, SECRET_KEY]));
    });

    test("the record file holds no credential and is readable by its owner only", () => {
      const inst = instanceOf();
      inst.service.add("archive", s3());

      const file = targetsPath(inst.dataDir);
      const stored = readFileSync(file, "utf8");
      expect(stored).not.toContain(ACCESS_KEY);
      expect(stored).not.toContain(SECRET_KEY);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    test("a second target with the same name is refused and stores nothing", () => {
      const inst = instanceOf();
      inst.service.add("archive", s3());
      const refusal = errorOf(() => inst.service.add("archive", s3("other")));

      expect(refusal).toBeInstanceOf(AppError);
      expect(refusal).toMatchObject({ status: 409, key: "target_name_taken" });
      expect(inst.service.list()).toHaveLength(1);
      expect(inst.secrets.list()).toHaveLength(2);
    });

    test("removing a target removes its record and its credentials, and removing it again is not found", () => {
      const inst = instanceOf();
      const view = inst.service.add("archive", s3());
      inst.service.remove(view.id);

      expect(inst.service.list()).toEqual([]);
      expect(inst.secrets.list()).toEqual([]);
      expect(errorOf(() => inst.service.remove(view.id))).toMatchObject({ status: 404, key: "target_not_found" });
    });

    test("a target and its credentials survive a restart over the same DATA_DIR", () => {
      const inst = instanceOf();
      const view = inst.service.add("archive", s3());
      const restarted = instanceOf(inst.dataDir);

      expect(restarted.service.list()).toEqual([view]);
      expect(restarted.known).toEqual(expect.arrayContaining([ACCESS_KEY, SECRET_KEY]));
    });

    test("a credential that no target owns is swept at startup", () => {
      const inst = instanceOf();
      const view = inst.service.add("archive", s3());
      inst.secrets.set("target.tgt_orphan0001.secret-key", "left behind", new Date().toISOString());
      const restarted = instanceOf(inst.dataDir);

      expect(restarted.secrets.meta("target.tgt_orphan0001.secret-key")).toBeNull();
      expect(restarted.secrets.meta(`target.${view.id}.secret-key`)).not.toBeNull();
    });

    test("a targets file that does not match the format stops the start, and names the file", () => {
      const dataDir = freshDir();
      writeFileSync(targetsPath(dataDir), '{"version":1,"targets":"nope"}');
      expect(() => instanceOf(dataDir)).toThrow(TargetFileError);
      expect(() => instanceOf(dataDir)).toThrow(/targets\.json/);
    });
  });

  describe("reaching a target", () => {
    test("a test reaches the target and stores nothing", async () => {
      const inst = instanceOf();
      await inst.service.test(s3());

      expect(inst.service.list()).toEqual([]);
      expect(inst.secrets.list()).toEqual([]);
    });

    test("a test with credentials the target refuses fails as an auth failure, with no detail of the secret", async () => {
      const inst = instanceOf();
      const refusal = await rejectionOf(inst.service.test({ ...s3(), secretAccessKey: "wrong-secret-key-0001" }));

      expect(refusal).toMatchObject({ status: 502, key: "target_auth_failed" });
      expect(JSON.stringify(refusal)).not.toContain("wrong-secret-key-0001");
    });

    test("a target nothing listens on is unreachable", async () => {
      const inst = instanceOf();
      const refusal = await rejectionOf(inst.service.test({ ...s3(), endpoint: "http://127.0.0.1:9" }));
      expect(refusal).toMatchObject({ status: 502, key: "target_unreachable" });
    });

    test("a stored target is checked with its own credentials, and a bad one is reported", async () => {
      const inst = instanceOf();
      const view = inst.service.add("archive", s3());
      await inst.service.check(view.id);

      const bad = inst.service.add("broken", { ...s3(), secretAccessKey: "wrong-secret-key-0001" });
      expect(await rejectionOf(inst.service.check(bad.id))).toMatchObject({ status: 502, key: "target_auth_failed" });
    });
  });

  describe("pushing a package", () => {
    test("the archive and its record land on the target, and a second push is skipped", async () => {
      const inst = instanceOf();
      const view = inst.service.add("archive", s3());
      const meta = await packageIn(inst);

      const first = await inst.service.push(view.id, meta.id);
      expect(first).toMatchObject({ object: meta.id, kind: "package", bytes: meta.bytes, skipped: false });
      const archive = double.objects.get(`minibox/packages/${meta.id}.mbckpt`);
      expect(archive?.byteLength).toBe(meta.bytes);
      expect(JSON.parse(textOf(double.objects.get(`minibox/packages/${meta.id}.json`)))).toMatchObject({
        id: meta.id,
        sha256: meta.sha256,
      });
      expect(inst.service.get(view.id).lastSync).toMatchObject({
        at: expect.any(String),
        direction: "push",
        kind: "package",
        object: meta.id,
        bytes: meta.bytes,
        error: null,
      });

      const second = await inst.service.push(view.id, meta.id);
      expect(second).toMatchObject({ skipped: true, bytes: meta.bytes });
    });

    test("an object the target holds with other contents is refused, and the failure is recorded", async () => {
      const inst = instanceOf();
      const view = inst.service.add("archive", s3());
      const meta = await packageIn(inst);
      await inst.service.push(view.id, meta.id);

      const recordKey = `minibox/packages/${meta.id}.json`;
      const remote = JSON.parse(textOf(double.objects.get(recordKey))) as Record<string, unknown>;
      double.objects.set(recordKey, new TextEncoder().encode(JSON.stringify({ ...remote, sha256: "f".repeat(64) })));

      const refusal = await rejectionOf(inst.service.push(view.id, meta.id));
      expect(refusal).toMatchObject({ status: 409, key: "target_object_differs" });
      expect(inst.service.get(view.id).lastSync).toMatchObject({
        direction: "push",
        error: expect.stringContaining("other contents"),
      });
    });

    test("a target is busy while a transfer runs, and cannot be removed until it ends", async () => {
      const inst = instanceOf();
      const view = inst.service.add("archive", s3());
      const meta = await packageIn(inst);

      const pending = inst.service.push(view.id, meta.id);
      expect(errorOf(() => inst.service.remove(view.id))).toMatchObject({ status: 409, key: "target_busy" });
      await pending;
      inst.service.remove(view.id);
      expect(inst.service.list()).toEqual([]);
    });

    test("a package that is not on this instance is not found, and nothing is sent", async () => {
      const inst = instanceOf();
      const view = inst.service.add("archive", s3());
      const refusal = await rejectionOf(inst.service.push(view.id, "pk_nothere0001"));

      expect(refusal).toMatchObject({ status: 404, key: "package_not_found" });
      expect(double.objects.size).toBe(0);
    });
  });

  describe("pulling a package", () => {
    test("a pulled package is stored whole, with origin target and a day to live", async () => {
      const source = instanceOf();
      const sourceView = source.service.add("archive", s3());
      const meta = await packageIn(source);
      await source.service.push(sourceView.id, meta.id);

      const local = instanceOf();
      const view = local.service.add("archive", s3());
      const pulled = await local.service.pull(view.id, meta.id);
      expect(pulled).toMatchObject({ object: meta.id, kind: "package", bytes: meta.bytes, skipped: false });

      const held = local.checkpoints.packages.read(meta.id);
      expect(held).toMatchObject({ origin: "target", sha256: meta.sha256, bytes: meta.bytes });
      const ttl = Date.parse(held?.expiresAt ?? "") - Date.now();
      expect(ttl).toBeLessThanOrEqual(PACKAGE_TTL_MS);
      expect(ttl).toBeGreaterThan(PACKAGE_TTL_MS - 60_000);
      expect(readFileSync(local.checkpoints.packages.pathFor(meta.id))).toEqual(
        readFileSync(source.checkpoints.packages.pathFor(meta.id)),
      );
      expect(local.service.get(view.id).lastSync).toMatchObject({ direction: "pull", object: meta.id, error: null });

      expect((await local.service.pull(view.id, meta.id)).skipped).toBe(true);
    });

    test("an archive that does not match its record is refused, and leaves nothing behind", async () => {
      const source = instanceOf();
      const sourceView = source.service.add("archive", s3());
      const meta = await packageIn(source);
      await source.service.push(sourceView.id, meta.id);

      const archiveKey = `minibox/packages/${meta.id}.mbckpt`;
      const tampered = Buffer.from(double.objects.get(archiveKey) ?? new Uint8Array());
      const body = tampered.indexOf(Buffer.alloc(300, 7));
      expect(body).toBeGreaterThan(0);
      tampered[body] = (tampered[body] ?? 0) ^ 0xff;
      double.objects.set(archiveKey, new Uint8Array(tampered));

      const local = instanceOf();
      const view = local.service.add("archive", s3());
      const refusal = await rejectionOf(local.service.pull(view.id, meta.id));
      expect(refusal).toMatchObject({ status: 400, key: "target_object_invalid" });
      expect(local.checkpoints.packages.read(meta.id)).toBeNull();
      expect(local.checkpoints.packages.fileBytes(meta.id)).toBeNull();
    });

    test("a stored package with other contents is not replaced", async () => {
      const source = instanceOf();
      const sourceView = source.service.add("archive", s3());
      const meta = await packageIn(source);
      await source.service.push(sourceView.id, meta.id);

      const local = instanceOf();
      const view = local.service.add("archive", s3());
      await local.service.pull(view.id, meta.id);
      const held = local.checkpoints.packages.read(meta.id);
      if (held === null) throw new Error("the pulled package is not stored");
      local.checkpoints.packages.write({ ...held, sha256: "e".repeat(64) });

      const refusal = await rejectionOf(local.service.pull(view.id, meta.id));
      expect(refusal).toMatchObject({ status: 409, key: "target_object_held" });
    });

    test("a stored package whose file is gone is pulled again, not skipped", async () => {
      const source = instanceOf();
      const sourceView = source.service.add("archive", s3());
      const meta = await packageIn(source);
      await source.service.push(sourceView.id, meta.id);

      const local = instanceOf();
      const view = local.service.add("archive", s3());
      await local.service.pull(view.id, meta.id);
      rmSync(local.checkpoints.packages.pathFor(meta.id));

      expect(await local.service.pull(view.id, meta.id)).toMatchObject({ skipped: false, bytes: meta.bytes });
      expect(local.checkpoints.packages.fileBytes(meta.id)).toBe(meta.bytes);
    });

    test("a file left behind without its metadata does not block a pull", async () => {
      const source = instanceOf();
      const sourceView = source.service.add("archive", s3());
      const meta = await packageIn(source);
      await source.service.push(sourceView.id, meta.id);

      const local = instanceOf();
      const view = local.service.add("archive", s3());
      mkdirSync(local.checkpoints.packages.dir(), { recursive: true });
      writeFileSync(local.checkpoints.packages.pathFor(meta.id), "left by an interrupted pull");

      expect(await local.service.pull(view.id, meta.id)).toMatchObject({ skipped: false, bytes: meta.bytes });
      expect(local.checkpoints.packages.read(meta.id)).toMatchObject({ origin: "target", sha256: meta.sha256 });
    });

    test("an object is not pulled twice at once, even from another target", async () => {
      const source = instanceOf();
      const sourceView = source.service.add("archive", s3());
      const meta = await packageIn(source);
      await source.service.push(sourceView.id, meta.id);

      const local = instanceOf();
      const first = local.service.add("archive", s3());
      const second = local.service.add("mirror", s3());
      const pending = local.service.pull(first.id, meta.id);
      expect(await rejectionOf(local.service.pull(second.id, meta.id))).toMatchObject({
        status: 409,
        key: "target_object_busy",
      });
      await pending;
      expect(await local.service.pull(second.id, meta.id)).toMatchObject({ skipped: true });
    });

    test("a package the target does not hold is not found", async () => {
      const local = instanceOf();
      const view = local.service.add("archive", s3());
      const refusal = await rejectionOf(local.service.pull(view.id, "pk_absent00001"));
      expect(refusal).toMatchObject({ status: 404, key: "target_object_missing" });
    });
  });

  describe("backups", () => {
    test("a backup is pushed and pulled as an archive with its record, and keeps its origin", async () => {
      const source = instanceOf();
      const sourceView = source.service.add("archive", s3());
      const backup = await source.backups.create(PASSPHRASE, "owner");
      const pushed = await source.service.push(sourceView.id, backup.id);
      expect(pushed).toMatchObject({ kind: "backup", bytes: backup.bytes, skipped: false });

      const local = instanceOf();
      const view = local.service.add("archive", s3());
      await local.service.pull(view.id, backup.id);
      expect(local.backups.stored(backup.id)).toMatchObject({
        origin: "target",
        targetId: view.id,
        bytes: backup.bytes,
        sha256: backup.sha256,
      });
      expect((await local.service.pull(view.id, backup.id)).skipped).toBe(true);
    });

    test("a stored backup whose archive is gone is pulled again, not skipped", async () => {
      const source = instanceOf();
      const sourceView = source.service.add("archive", s3());
      const backup = await source.backups.create(PASSPHRASE, "owner");
      await source.service.push(sourceView.id, backup.id);

      const local = instanceOf();
      const view = local.service.add("archive", s3());
      await local.service.pull(view.id, backup.id);
      rmSync(local.backups.store.pathFor(backup.id));

      expect(await local.service.pull(view.id, backup.id)).toMatchObject({ skipped: false, bytes: backup.bytes });
      expect(local.backups.stored(backup.id)).toMatchObject({ origin: "target", sha256: backup.sha256 });
    });

    test("an archive left without its record does not block a pull", async () => {
      const source = instanceOf();
      const sourceView = source.service.add("archive", s3());
      const backup = await source.backups.create(PASSPHRASE, "owner");
      await source.service.push(sourceView.id, backup.id);

      const local = instanceOf();
      const view = local.service.add("archive", s3());
      local.backups.store.ensureDir();
      writeFileSync(local.backups.store.pathFor(backup.id), "left by an interrupted pull");

      expect(await local.service.pull(view.id, backup.id)).toMatchObject({ skipped: false, bytes: backup.bytes });
      expect(local.backups.stored(backup.id)).toMatchObject({ origin: "target", sha256: backup.sha256 });
    });
  });

  describe("the objects a target holds", () => {
    test("lists whole packages and backups, and leaves out an archive whose record is missing or wrong", async () => {
      const inst = instanceOf();
      const view = inst.service.add("archive", s3());
      const meta = await packageIn(inst);
      const backup = await inst.backups.create(PASSPHRASE, "owner");
      await inst.service.push(view.id, meta.id);
      await inst.service.push(view.id, backup.id);

      double.objects.set("minibox/packages/pk_orphan0001.mbckpt", new Uint8Array([1, 2, 3]));
      double.objects.set("minibox/packages/pk_mismatch01.mbckpt", new Uint8Array([1, 2, 3]));
      double.objects.set(
        "minibox/packages/pk_mismatch01.json",
        new TextEncoder().encode(JSON.stringify({ ...meta, id: "pk_mismatch01", bytes: 999 })),
      );

      const objects = await inst.service.objects(view.id);
      expect(objects.map((object) => [object.kind, object.id, object.bytes]).toSorted()).toEqual(
        [
          ["backup", backup.id, backup.bytes],
          ["package", meta.id, meta.bytes],
        ].toSorted(),
      );
      expect(objects.find((object) => object.id === meta.id)).toMatchObject({ sha256: meta.sha256 });
    });
  });

  describe("a WebDAV target", () => {
    let dav: WebdavDouble;

    beforeEach(() => {
      dav = startWebdavDouble({ user: WEBDAV_USER, password: WEBDAV_PASSWORD, prefix: "remote.php/dav/files/u" });
    });

    afterEach(() => {
      dav.stop();
    });

    const webdav = (path = "minibox"): TargetDraft => ({
      kind: "webdav",
      path,
      url: dav.url,
      user: WEBDAV_USER,
      password: WEBDAV_PASSWORD,
    });

    test("a package and a backup are pushed, listed and pulled back with the same bytes", async () => {
      const source = instanceOf();
      const sourceView = source.service.add("dav", webdav());
      const meta = await packageIn(source);
      const backup = await source.backups.create(PASSPHRASE, "owner");
      await source.service.push(sourceView.id, meta.id);
      await source.service.push(sourceView.id, backup.id);

      expect([...dav.files.keys()].toSorted()).toEqual([
        `minibox/backups/${backup.id}.json`,
        `minibox/backups/${backup.id}.mbbak`,
        `minibox/packages/${meta.id}.json`,
        `minibox/packages/${meta.id}.mbckpt`,
      ]);
      expect(dav.files.get(`minibox/packages/${meta.id}.mbckpt`)?.byteLength).toBe(meta.bytes);

      const local = instanceOf();
      const view = local.service.add("dav", webdav());
      expect(view).toMatchObject({
        kind: "webdav",
        address: dav.url,
        path: "minibox",
        hostKeyFingerprint: null,
        credentials: true,
      });
      expect((await local.service.objects(view.id)).map((object) => [object.kind, object.id]).toSorted()).toEqual([
        ["backup", backup.id],
        ["package", meta.id],
      ]);

      expect(await local.service.pull(view.id, meta.id)).toMatchObject({
        object: meta.id,
        kind: "package",
        bytes: meta.bytes,
        skipped: false,
      });
      expect(sha256Of(local.checkpoints.packages.pathFor(meta.id))).toBe(meta.sha256);
      expect(await local.service.pull(view.id, backup.id)).toMatchObject({
        object: backup.id,
        kind: "backup",
        bytes: backup.bytes,
        skipped: false,
      });
      const pulled = local.backups.stored(backup.id);
      expect(pulled).toMatchObject({ origin: "target", targetId: view.id, sha256: backup.sha256 });
      expect(sha256Of(local.backups.store.pathFor(backup.id))).toBe(backup.sha256);
    });

    test("the password is kept as a secret and never written to targets.json", () => {
      const inst = instanceOf();
      const view = inst.service.add("dav", webdav());

      expect(inst.secrets.list().map((meta) => meta.name)).toEqual([`target.${view.id}.password`]);
      expect(inst.known).toContain(WEBDAV_PASSWORD);
      expect(inst.service.get(view.id).credentials).toBe(true);
      const stored = readFileSync(targetsPath(inst.dataDir), "utf8");
      expect(stored).toContain(dav.url);
      expect(stored).not.toContain(WEBDAV_PASSWORD);
    });

    test("removing the target removes its password", () => {
      const inst = instanceOf();
      const view = inst.service.add("dav", webdav());
      inst.service.remove(view.id);

      expect(inst.service.list()).toEqual([]);
      expect(inst.secrets.list()).toEqual([]);
    });

    test("a target whose password is gone is refused before anything is sent", async () => {
      const inst = instanceOf();
      const view = inst.service.add("dav", webdav());
      inst.secrets.remove(`target.${view.id}.password`);

      expect(await rejectionOf(inst.service.check(view.id))).toMatchObject({
        status: 409,
        key: "target_credentials_missing",
      });
      expect(dav.requests).toEqual([]);
    });
  });

  describe("an SFTP target", () => {
    let sftp: SftpDouble;

    beforeEach(async () => {
      sftp = await startSftpDouble();
    });

    afterEach(async () => {
      await sftp.close();
    });

    const sftpDraft = (hostKeyFingerprint: string | null): TargetDraft => ({
      kind: "sftp",
      path: "backups/eu",
      host: sftp.host,
      port: sftp.port,
      user: "minibox",
      privateKey: sftp.privateKey,
      hostKeyFingerprint,
    });

    test("a server whose host key is not confirmed is reported with the key it presented", async () => {
      const inst = instanceOf();
      const refusal = await rejectionOf(inst.service.test(sftpDraft(null)));

      expect(refusal).toMatchObject({ status: 409, key: "target_host_key_unconfirmed" });
      expect((refusal as AppError).details).toEqual({ fingerprint: sftp.hostKeyFingerprint });
      expect(sftp.requests).toEqual([]);
    });

    test("adding a target without a confirmed host key is refused", () => {
      const inst = instanceOf();
      expect(errorOf(() => inst.service.add("eu", sftpDraft(null)))).toMatchObject({
        status: 400,
        key: "target_host_key_required",
      });
      expect(inst.service.list()).toEqual([]);
    });

    test("a server that presents another host key is refused before anything is sent", async () => {
      const inst = instanceOf();
      const other = `SHA256:${"A".repeat(43)}`;
      const refusal = await rejectionOf(inst.service.test(sftpDraft(other)));

      expect(refusal).toMatchObject({ status: 409, key: "target_host_key_mismatch" });
      expect(sftp.requests).toEqual([]);
    });

    test("a package is pushed to the folder and pulled back, once the key is pinned", async () => {
      const source = instanceOf();
      const sourceView = source.service.add("eu", sftpDraft(sftp.hostKeyFingerprint));
      const meta = await packageIn(source);
      const pushed = await source.service.push(sourceView.id, meta.id);
      expect(pushed).toMatchObject({ kind: "package", bytes: meta.bytes, skipped: false });

      const local = instanceOf();
      const view = local.service.add("eu", sftpDraft(sftp.hostKeyFingerprint));
      expect(view).toMatchObject({ kind: "sftp", hostKeyFingerprint: sftp.hostKeyFingerprint, credentials: true });
      await local.service.pull(view.id, meta.id);
      expect(local.checkpoints.packages.read(meta.id)).toMatchObject({ origin: "target", bytes: meta.bytes });
      expect(await local.service.objects(view.id)).toEqual([
        expect.objectContaining({ kind: "package", id: meta.id, bytes: meta.bytes }),
      ]);
    });
  });
});
