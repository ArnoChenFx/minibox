import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listEntries } from "../src/backup/layout";
import { backupDirRefusal } from "../src/data-dir";
import { BackupService } from "../src/services/backup";
import { silenceLogs } from "./support/app";
const restore = silenceLogs();
afterAll(restore);
const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "minibox-backup-storage-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

test("a corrupt backup record cannot roll back a completed archive or hide healthy records", async () => {
  const data = join(temp(), "data");
  const backups = join(data, "backups");
  mkdirSync(backups, { recursive: true });
  mkdirSync(join(backups, "bk_aaaaaaaaaaaaaaaa.json"));
  writeFileSync(join(data, "sample.json"), "{}");
  const service = new BackupService({ dataDir: data, databases: [], keep: 2 });
  const record = await service.create("probe-passphrase", "owner");
  expect(service.whole(record.id)?.id).toBe(record.id);
  expect(service.list().map((r) => r.id)).toContain(record.id);
  expect(readdirSync(backups)).toContain(`${record.id}.mbbak`);
});

test("real paths exclude backup aliases and refuse an alias for the data directory", async () => {
  const root = temp();
  const data = join(root, "data");
  const archives = join(data, "archives");
  mkdirSync(archives, { recursive: true });
  writeFileSync(join(archives, "old.mbbak"), "old");
  const alias = join(root, "backup-link");
  symlinkSync(archives, alias, "dir");
  expect((await listEntries(data, { exclude: [alias] })).map((e) => e.rel)).not.toContain("archives/old.mbbak");
  const dataAlias = join(root, "data-link");
  symlinkSync(data, dataAlias, "dir");
  expect(backupDirRefusal(dataAlias, data)).not.toBeNull();
  expect(backupDirRefusal(join(alias, "new"), data)).toBeNull();
});

test("custom shared backup folders retain their mode; archives stay private", async () => {
  const root = temp();
  const dir = join(root, "shared");
  mkdirSync(dir);
  chmodSync(dir, 0o750);
  const service = new BackupService({ dataDir: join(root, "data"), backupDir: dir, databases: [] });
  const record = await service.create("probe-passphrase", "owner");
  expect(statSync(dir).mode & 0o777).toBe(0o750);
  expect(statSync(service.store.pathFor(record.id)).mode & 0o777).toBe(0o600);
});

test("an alias inside DATA_DIR cannot archive the default backups folder", async () => {
  const data = join(temp(), "data");
  const backups = join(data, "backups");
  mkdirSync(backups, { recursive: true });
  writeFileSync(join(backups, "old.mbbak"), "old archive");
  symlinkSync(backups, join(data, "archive-alias"), "dir");
  const lines: string[] = [];
  const service = new BackupService({ dataDir: data, databases: [] });
  await service.create("probe-passphrase", "owner", (line) => lines.push(line));
  expect(lines.some((line) => line.includes("archive-alias") || line.includes("old.mbbak"))).toBe(false);
});
