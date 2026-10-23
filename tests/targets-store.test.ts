import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { targetsPath } from "../src/data-dir";
import { TargetFileError, TargetStore } from "../src/targets/store";
import {
  isTargetId,
  isTargetSecretName,
  newTargetId,
  objectIdOf,
  objectKindOf,
  remoteNames,
  type S3TargetRecord,
  type SftpTargetRecord,
  targetIdOfSecret,
  targetSecretName,
} from "../src/targets/types";

const NOW = "2026-10-22T10:00:00.000Z";
const PACKAGE_ID = "pk_abcdefgh";
const BACKUP_ID = "bk_abcdefgh";

function s3(id: string, name = "Nightly S3"): S3TargetRecord {
  return {
    id,
    kind: "s3",
    name,
    path: "minibox",
    endpoint: "https://s3.example.test",
    region: "eu-west-1",
    bucket: "minibox-backups",
    createdAt: NOW,
    updatedAt: NOW,
    lastSync: null,
  };
}

function sftp(id: string): SftpTargetRecord {
  return {
    id,
    kind: "sftp",
    name: "Office NAS",
    path: "/volume1/minibox",
    host: "nas.example.test",
    port: 22,
    user: "minibox",
    hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    createdAt: "2026-10-22T11:00:00.000Z",
    updatedAt: "2026-10-22T11:00:00.000Z",
    lastSync: null,
  };
}

describe("target records", () => {
  test("ids have one shape and no two calls share one", () => {
    const first = newTargetId();
    expect(first).toMatch(/^tgt_[0-9a-z]{8,32}$/);
    expect(isTargetId(first)).toBe(true);
    expect(newTargetId()).not.toBe(first);
    expect(isTargetId("tgt_ABC")).toBe(false);
    expect(isTargetId("../tgt_abcdefgh")).toBe(false);
  });

  test("a credential is a secret named for its target, and only that name maps back", () => {
    const name = targetSecretName("tgt_abcdefgh", "secret-key");
    expect(name).toBe("target.tgt_abcdefgh.secret-key");
    expect(isTargetSecretName(name)).toBe(true);
    expect(targetIdOfSecret(name)).toBe("tgt_abcdefgh");
    expect(targetIdOfSecret("target.tgt_abcdefgh.password")).toBeNull();
    expect(targetIdOfSecret("api-token")).toBeNull();
  });

  test("an object's kind follows from its id, and a remote name follows from its kind", () => {
    expect(objectKindOf(PACKAGE_ID)).toBe("package");
    expect(objectKindOf(BACKUP_ID)).toBe("backup");
    expect(objectKindOf("tgt_abcdefgh")).toBeNull();
    expect(remoteNames("package", PACKAGE_ID)).toEqual({
      folder: "packages",
      archive: `packages/${PACKAGE_ID}.mbckpt`,
      record: `packages/${PACKAGE_ID}.json`,
    });
    expect(remoteNames("backup", BACKUP_ID).archive).toBe(`backups/${BACKUP_ID}.mbbak`);
    expect(objectIdOf("package", `${PACKAGE_ID}.mbckpt`)).toBe(PACKAGE_ID);
    expect(objectIdOf("package", `${BACKUP_ID}.mbbak`)).toBeNull();
    expect(objectIdOf("backup", `${PACKAGE_ID}.mbckpt`)).toBeNull();
  });
});

describe("target store", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "minibox-targets-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("starts empty when there is no file", () => {
    const store = new TargetStore(dataDir);
    store.load();
    expect(store.list()).toEqual([]);
  });

  test("keeps records across a restart, in the order they were added", () => {
    const store = new TargetStore(dataDir);
    store.put(sftp("tgt_bbbbbbbb"));
    store.put({ ...s3("tgt_aaaaaaaa"), createdAt: "2026-10-22T09:00:00.000Z" });

    const reopened = new TargetStore(dataDir);
    reopened.load();
    expect(reopened.list().map((record) => record.id)).toEqual(["tgt_aaaaaaaa", "tgt_bbbbbbbb"]);
    expect(reopened.get("tgt_bbbbbbbb")).toEqual(sftp("tgt_bbbbbbbb"));
  });

  test("writes the file without any credential, and with mode 600", () => {
    const store = new TargetStore(dataDir);
    store.put(s3("tgt_aaaaaaaa"));
    const text = readFileSync(targetsPath(dataDir), "utf8");
    expect(text).not.toMatch(/secret|password|private/i);
    expect(JSON.parse(text)).toMatchObject({ version: 1, targets: [{ id: "tgt_aaaaaaaa", kind: "s3" }] });
    expect(statSync(targetsPath(dataDir)).mode & 0o777).toBe(0o600);
  });

  test("replaces a record in place and removes one", () => {
    const store = new TargetStore(dataDir);
    store.put(s3("tgt_aaaaaaaa"));
    store.put({ ...s3("tgt_aaaaaaaa"), name: "Renamed" });
    expect(store.list()).toHaveLength(1);
    expect(store.get("tgt_aaaaaaaa")?.name).toBe("Renamed");

    expect(store.delete("tgt_aaaaaaaa")).toBe(true);
    expect(store.delete("tgt_aaaaaaaa")).toBe(false);
    const reopened = new TargetStore(dataDir);
    reopened.load();
    expect(reopened.list()).toEqual([]);
  });

  test("refuses a file that is not JSON, and names the file", () => {
    writeFileSync(targetsPath(dataDir), "{ not json");
    const store = new TargetStore(dataDir);
    expect(() => store.load()).toThrow(TargetFileError);
    expect(() => store.load()).toThrow(targetsPath(dataDir));
  });

  test("refuses a record that does not match the format, with no partial load", () => {
    writeFileSync(
      targetsPath(dataDir),
      JSON.stringify({ version: 1, targets: [s3("tgt_aaaaaaaa"), { ...s3("tgt_bbbbbbbb"), kind: "ftp" }] }),
    );
    const store = new TargetStore(dataDir);
    expect(() => store.load()).toThrow(/does not match the target format/);
    expect(store.list()).toEqual([]);
  });

  test("refuses a record with a field the format does not know", () => {
    writeFileSync(
      targetsPath(dataDir),
      JSON.stringify({ version: 1, targets: [{ ...s3("tgt_aaaaaaaa"), password: "hunter2hunter2" }] }),
    );
    expect(() => new TargetStore(dataDir).load()).toThrow(TargetFileError);
  });
});
