import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { silenceLogs } from "./support/app";
import { type S3Double, startS3Double } from "./support/s3-double";
import { type SftpDouble, startSftpDouble } from "./support/sftp-double";
import { call, finishedTask, type Harness, mint, refused, startHarness } from "./support/tokens";

const PASSPHRASE = "correct horse battery staple";
const ACCESS_KEY = "AKIATESTONLY0002";
const SECRET_KEY = "test-only-secret-key-0002";

let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
});

afterEach(() => restoreLogs());

describe("targets over REST", () => {
  let harness: Harness;
  let double: S3Double;

  beforeEach(() => {
    harness = startHarness();
    double = startS3Double({ accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, bucket: "backups" });
  });

  afterEach(() => {
    harness.stop();
    double.stop();
  });

  function s3Target(name = "archive") {
    return {
      name,
      kind: "s3",
      path: "minibox",
      endpoint: double.endpoint,
      region: double.region,
      bucket: double.bucket,
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
    };
  }

  async function addS3(base: string): Promise<string> {
    const added = await call(base, "/api/targets", { body: s3Target() });
    expect(added.status).toBe(201);
    return (added.json as unknown as { target: { id: string } }).target.id;
  }

  test("a target is added over REST and listed without its credentials, which no answer or event carries", async () => {
    const before = harness.app.events.head();
    const added = await call(harness.base, "/api/targets", { body: s3Target() });
    expect(added.status).toBe(201);
    expect((added.json as unknown as { target: object }).target).toMatchObject({
      name: "archive",
      kind: "s3",
      credentials: true,
      lastSync: null,
    });

    const listed = await call(harness.base, "/api/targets");
    expect(listed.status).toBe(200);
    expect((listed.json as unknown as { targets: { name: string }[] }).targets.map((t) => t.name)).toEqual(["archive"]);

    const answers = JSON.stringify([added.json, listed.json, harness.app.events.after(before, {}, 20)]);
    expect(answers).not.toContain(SECRET_KEY);
    expect(answers).not.toContain(ACCESS_KEY);
  });

  test("a target that names the other kind's fields, or leaves out a required one, is refused with its field", async () => {
    const mixed = await call(harness.base, "/api/targets", { body: { ...s3Target(), host: "sftp.example.com" } });
    expect(refused(mixed)).toEqual({ status: 400, key: "target_field_not_allowed" });
    expect(mixed.json.error?.details).toEqual({ field: "host" });

    const noBucket = await call(harness.base, "/api/targets", { body: { ...s3Target(), bucket: undefined } });
    expect(refused(noBucket)).toEqual({ status: 400, key: "field_required" });
    expect(noBucket.json.error?.details).toEqual({ field: "bucket" });

    const plainHttp = await call(harness.base, "/api/targets", {
      body: { ...s3Target(), endpoint: "http://s3.example.com" },
    });
    expect(refused(plainHttp)).toEqual({ status: 400, key: "target_endpoint_invalid" });
    expect(harness.app.targets.list()).toEqual([]);
  });

  test("a test with credentials the target refuses is a 502 that names no secret", async () => {
    const wrong = "wrong-secret-key-0002";
    const res = await call(harness.base, "/api/targets/test", { body: { ...s3Target(), secretAccessKey: wrong } });
    expect(refused(res)).toEqual({ status: 502, key: "target_auth_failed" });
    expect(JSON.stringify(res.json)).not.toContain(wrong);
    expect(harness.app.targets.list()).toEqual([]);
  });

  test("an SFTP server is not added until a test has reported its host key, and the key then pins the target", async () => {
    const sftp: SftpDouble = await startSftpDouble();
    try {
      const draft = {
        name: "eu",
        kind: "sftp",
        path: "backups/eu",
        host: sftp.host,
        port: sftp.port,
        user: "minibox",
        privateKey: sftp.privateKey,
      };
      const unpinned = await call(harness.base, "/api/targets", { body: draft });
      expect(refused(unpinned)).toEqual({ status: 400, key: "target_host_key_required" });

      const probe = await call(harness.base, "/api/targets/test", { body: draft });
      expect(refused(probe)).toEqual({ status: 409, key: "target_host_key_unconfirmed" });
      expect((probe.json as unknown as { error: { details: unknown } }).error.details).toEqual({
        fingerprint: sftp.hostKeyFingerprint,
      });

      const added = await call(harness.base, "/api/targets", {
        body: { ...draft, hostKeyFingerprint: sftp.hostKeyFingerprint },
      });
      expect(added.status).toBe(201);
      expect((added.json as unknown as { target: object }).target).toMatchObject({
        kind: "sftp",
        hostKeyFingerprint: sftp.hostKeyFingerprint,
        credentials: true,
      });
    } finally {
      await sftp.close();
    }
  });

  test("a backup is pushed as a task, listed on the target, and pulled by a second instance", async () => {
    const targetId = await addS3(harness.base);

    const made = await call(harness.base, "/api/backups", { body: { passphrase: PASSPHRASE } });
    expect(made.status).toBe(202);
    const created = await finishedTask(harness.base, String(made.json.taskId));
    expect(created.status).toBe("succeeded");
    const backupId = (created.result as unknown as { backup: { id: string } }).backup.id;

    const pushed = await call(harness.base, `/api/targets/${targetId}/push`, { body: { object: backupId } });
    expect(pushed.status).toBe(202);
    const sent = await finishedTask(harness.base, String(pushed.json.taskId));
    expect(sent.status).toBe("succeeded");
    expect(sent.result).toMatchObject({ object: backupId, kind: "backup", skipped: false });

    const objects = await call(harness.base, `/api/targets/${targetId}/objects`);
    expect(objects.status).toBe(200);
    expect((objects.json as unknown as { objects: { id: string }[] }).objects.map((o) => o.id)).toEqual([backupId]);

    const local = startHarness();
    try {
      const localId = await addS3(local.base);
      const pulled = await call(local.base, `/api/targets/${localId}/pull`, { body: { object: backupId } });
      expect(pulled.status).toBe(202);
      const fetched = await finishedTask(local.base, String(pulled.json.taskId));
      expect(fetched.status).toBe("succeeded");

      const backups = await call(local.base, "/api/backups");
      expect((backups.json as unknown as { backups: object[] }).backups).toEqual([
        expect.objectContaining({ id: backupId, origin: "target", targetId: localId }),
      ]);
    } finally {
      local.stop();
    }
  });

  test("a push of an object this instance does not hold fails its task and sends nothing", async () => {
    const targetId = await addS3(harness.base);
    const pushed = await call(harness.base, `/api/targets/${targetId}/push`, { body: { object: "pk_nothere0001" } });
    expect(pushed.status).toBe(202);

    const done = await finishedTask(harness.base, String(pushed.json.taskId));
    expect(done.status).toBe("failed");
    expect(done.error).toMatchObject({ key: "package_not_found" });
    expect(double.objects.size).toBe(0);
  });

  test("an object id that is neither a package nor a backup is refused before any task starts", async () => {
    const targetId = await addS3(harness.base);
    const res = await call(harness.base, `/api/targets/${targetId}/pull`, { body: { object: "nope" } });
    expect(refused(res)).toEqual({ status: 400, key: "target_object_invalid" });
    expect(res.json.error?.details).toEqual({ field: "object" });
  });

  test("a stored target is checked, then removed, and after its removal it is not found", async () => {
    const targetId = await addS3(harness.base);
    expect((await call(harness.base, `/api/targets/${targetId}/check`)).status).toBe(200);

    expect((await call(harness.base, `/api/targets/${targetId}`, { method: "DELETE" })).status).toBe(200);
    expect(refused(await call(harness.base, `/api/targets/${targetId}`, { method: "DELETE" }))).toEqual({
      status: 404,
      key: "target_not_found",
    });
    expect(refused(await call(harness.base, `/api/targets/${targetId}/objects`))).toEqual({
      status: 404,
      key: "target_not_found",
    });
  });

  test("only the owner reaches targets: an admin or an operator token is refused on every route", async () => {
    for (const preset of ["admin", "operator"] as const) {
      const minted = mint(harness.app, { name: preset, preset });
      expect((await call(harness.base, "/api/targets", { token: minted.secret })).status).toBe(403);
      expect((await call(harness.base, "/api/targets", { token: minted.secret, body: s3Target() })).status).toBe(403);
    }
    expect(harness.app.targets.list()).toEqual([]);
  });
});
