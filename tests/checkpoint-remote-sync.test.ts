import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { App } from "../src/app";
import { CHECKPOINT_VERSION, type CheckpointRecord } from "../src/checkpoints/types";
import { targetsPath } from "../src/data-dir";
import type { HostCtx } from "../src/host/registry";
import { AppError } from "../src/lib/errors";
import type { OperationContext } from "../src/operations/types";
import { OWNER } from "../src/operations/types";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";
import { FakeCheckpointEngine } from "./support/fake-snapshots";
import { type SftpDouble, startSftpDouble } from "./support/sftp-double";

const ACCESS_KEY = "AKIAEXAMPLE";
const SECRET_KEY = "test-only-secret-key";

interface Instance {
  readonly app: App;
  readonly host: HostCtx;
  readonly dataDir: string;
}

/** The app's fake engine and runtime, where a test reaches into what the interfaces do not expose. */
function engineOf(inst: Instance): FakeCheckpointEngine {
  return inst.host.checkpointEngine as FakeCheckpointEngine;
}

function runtimeOf(inst: Instance): FakeRuntime {
  return inst.host.runtime as FakeRuntime;
}

let restoreLogs: () => void;
let dirs: string[];
let sftp: SftpDouble | null = null;

beforeEach(() => {
  restoreLogs = silenceLogs();
  dirs = [];
});

afterEach(async () => {
  await sftp?.close();
  sftp = null;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  restoreLogs();
});

function instanceOf(): Instance {
  const dataDir = mkdtempSync(join(tmpdir(), "minibox-remote-sync-"));
  dirs.push(dataDir);
  const { app } = createTestApp({ dataDir });
  return { app, host: app.hosts.get(), dataDir };
}

function s3Target(inst: Instance, name = "archive"): string {
  return inst.app.targets.add(name, {
    kind: "s3",
    path: "minibox",
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: "archive",
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
  }).id;
}

/** A snapshot of a fresh volume, as the engine would take it, and the record that names it. */
async function checkpointOf(inst: Instance, name: string): Promise<{ record: CheckpointRecord; snapshotId: string }> {
  await runtimeOf(inst).createVolume(name, {});
  runtimeOf(inst)
    .filesOf(name)
    .set("notes.txt", { type: "file", content: Buffer.from("hello remote") });
  const snapshotId = (await inst.host.checkpointEngine.backup(inst.host, name, ["ck_remote"])).snapshotId;
  const now = new Date().toISOString();
  const record: CheckpointRecord = {
    version: CHECKPOINT_VERSION,
    id: inst.host.checkpoints.allocateId(),
    hostId: inst.host.host.id,
    boxId: null,
    boxName: "dev",
    label: "before remote",
    reason: "",
    createdBy: "owner",
    pinned: false,
    auto: false,
    consistency: "live",
    specRevision: null,
    spec: null,
    data: [
      {
        volumeId: "vol_abcdefgh1234",
        path: "/workspace",
        mode: "rw",
        role: "workspace",
        ownership: "owned",
        owner: { uid: 1000, gid: 1000 },
        snapshotId,
        bytes: 12,
      },
    ],
    system: null,
    trash: null,
    createdAt: now,
    updatedAt: now,
  };
  inst.host.checkpoints.write(record);
  return { record, snapshotId };
}

function storedRecord(inst: Instance, id: string): CheckpointRecord {
  const record = inst.host.checkpoints.read(id);
  if (!record) throw new Error(`no checkpoint record ${id}`);
  return record;
}

function storedTargetFile(inst: Instance): { targets: { id: string; hostKeyLine?: string }[] } {
  return JSON.parse(readFileSync(targetsPath(inst.dataDir), "utf8")) as {
    targets: { id: string; hostKeyLine?: string }[];
  };
}

function ctxOf(app: App): OperationContext {
  return {
    host: app.hosts.get(),
    principal: OWNER,
    source: "rest",
    events: app.events,
    tokens: app.tokens,
    execs: app.execs,
    terminals: app.terminals,
  };
}

describe("copying checkpoints to a remote repository", () => {
  test("a pending checkpoint is copied once, marked, and not copied again", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    inst.app.targets.setRemote("local", { targetId, path: "checkpoints" });
    const { record, snapshotId } = await checkpointOf(inst, "src");

    const first = await inst.app.checkpointRemote.syncHost(inst.host);
    expect(first).toEqual({ hostId: "local", targetId, checkpoints: 1, snapshots: 1 });
    expect(engineOf(inst).remoteCopies).toEqual([{ targetId, snapshotIds: [snapshotId] }]);
    expect(engineOf(inst).remoteSnapshots.get(targetId)).toEqual(new Set([snapshotId]));
    const marked = storedRecord(inst, record.id);
    expect(marked.remoteSync?.[targetId]).toBeString();
    expect(marked.remoteFailure).toBeUndefined();
    expect(inst.app.targets.remoteOf("local")).toMatchObject({ lastSyncAt: marked.remoteSync?.[targetId] });
    expect(inst.app.targets.remoteOf("local")?.lastError).toBeNull();

    const second = await inst.app.checkpointRemote.syncHost(inst.host);
    expect(second).toEqual({ hostId: "local", targetId, checkpoints: 0, snapshots: 0 });
    expect(engineOf(inst).remoteCopies).toHaveLength(1);
  });

  test("a failed copy records the reason, leaves the local checkpoint, and is retried after the delay", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    inst.app.targets.setRemote("local", { targetId });
    const { record, snapshotId } = await checkpointOf(inst, "src");
    engineOf(inst).failRemoteCopy = true;

    const error = await rejectionOf(inst.app.checkpointRemote.syncHost(inst.host));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("unreachable");
    const failed = storedRecord(inst, record.id);
    expect(failed.remoteFailure).toMatchObject({ targetId });
    expect(failed.remoteFailure?.message).toContain("unreachable");
    expect(failed.remoteSync).toBeUndefined();
    expect(inst.app.targets.remoteOf("local")?.lastError).toContain("unreachable");
    expect(engineOf(inst).snapshots.has(snapshotId)).toBe(true);

    // The first retry is 30 seconds later, so a pass before then does nothing.
    await inst.app.checkpointRemote.run(new Date(Date.now() + 5_000));
    expect(engineOf(inst).remoteCopies).toHaveLength(0);

    engineOf(inst).failRemoteCopy = false;
    await inst.app.checkpointRemote.run(new Date(Date.now() + 31_000));
    expect(engineOf(inst).remoteCopies).toHaveLength(1);
    const recovered = storedRecord(inst, record.id);
    expect(recovered.remoteFailure).toBeUndefined();
    expect(recovered.remoteSync?.[targetId]).toBeString();
    expect(inst.app.targets.remoteOf("local")?.lastError).toBeNull();
  });

  test("a local forget reaches nothing on the remote: the snapshot it copied stays there", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    inst.app.targets.setRemote("local", { targetId });
    const { record, snapshotId } = await checkpointOf(inst, "src");
    await inst.app.checkpointRemote.syncHost(inst.host);

    await inst.host.checkpointEngine.forget(inst.host, snapshotId);
    inst.host.checkpoints.remove(record.id);
    await inst.app.checkpointRemote.run();

    expect(engineOf(inst).snapshots.has(snapshotId)).toBe(false);
    expect(engineOf(inst).remoteSnapshots.get(targetId)).toEqual(new Set([snapshotId]));
    expect(engineOf(inst).remoteCopies).toHaveLength(1);
  });

  test("the remote repository's password is generated apart from the local one, in its own secrets file", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    inst.app.targets.setRemote("local", { targetId });
    // The local repository's key, as the engine creates it on the first backup.
    const local = "a".repeat(64);
    mkdirSync(join(inst.dataDir, "secrets"), { recursive: true });
    writeFileSync(join(inst.dataDir, "secrets", "checkpoint-repo.key"), `${local}\n`, { mode: 0o600 });

    const remote = await inst.app.targets.remoteRepository("local");

    expect(local).toMatch(/^[0-9a-f]{64}$/);
    expect(remote.password).toMatch(/^[0-9a-f]{64}$/);
    expect(remote.password).not.toBe(local);
    expect(readFileSync(join(inst.dataDir, "secrets", "checkpoint-remote-local.key"), "utf8").trim()).toBe(
      remote.password,
    );
    expect(remote.repository).not.toContain(remote.password);
    expect(remote.repository).toBe("s3:https://s3.example.com/archive/local");
  });
});

describe("an SFTP remote repository", () => {
  test("the server's whole public key is captured from the pinned exchange and kept on the target", async () => {
    sftp = await startSftpDouble();
    const inst = instanceOf();
    const target = inst.app.targets.add("nas", {
      kind: "sftp",
      path: "minibox",
      host: sftp.host,
      port: sftp.port,
      user: "backup",
      privateKey: sftp.privateKey,
      hostKeyFingerprint: sftp.hostKeyFingerprint,
    });
    inst.app.targets.setRemote("local", { targetId: target.id, path: "/srv/checkpoints" });

    const remote = await inst.app.targets.remoteRepository("local");

    if (remote.credentials.kind !== "sftp") throw new Error("the remote is not an SFTP repository");
    expect(remote.credentials.knownHosts).toStartWith(`[${sftp.host}]:${sftp.port} ssh-ed25519 AAAA`);
    expect(remote.credentials.knownHosts).not.toContain("SHA256:");
    expect(remote.repository).toBe(`sftp://backup@${sftp.host}:${sftp.port}//srv/checkpoints/local`);
    expect(remote.password).toMatch(/^[0-9a-f]{64}$/);
    const stored = storedTargetFile(inst).targets.find((item) => item.id === target.id);
    expect(stored?.hostKeyLine).toStartWith("ssh-ed25519 AAAA");
  });

  test("a server that presents another key is refused, and no key line is stored for it", async () => {
    sftp = await startSftpDouble();
    const inst = instanceOf();
    const target = inst.app.targets.add("nas", {
      kind: "sftp",
      path: "minibox",
      host: sftp.host,
      port: sftp.port,
      user: "backup",
      privateKey: sftp.privateKey,
      // A well-formed fingerprint that is not the key the server presents.
      hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    inst.app.targets.setRemote("local", { targetId: target.id });

    const error = await rejectionOf(inst.app.targets.remoteRepository("local"));

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 409, key: "target_host_key_mismatch" });
    expect(storedTargetFile(inst).targets.find((item) => item.id === target.id)?.hostKeyLine).toBeUndefined();
  });

  test("the descriptor hands restic the private key and the whole known_hosts line, never a fingerprint", async () => {
    sftp = await startSftpDouble();
    const inst = instanceOf();
    const target = inst.app.targets.add("nas", {
      kind: "sftp",
      path: "minibox",
      host: sftp.host,
      port: sftp.port,
      user: "backup",
      privateKey: sftp.privateKey,
      hostKeyFingerprint: sftp.hostKeyFingerprint,
    });
    inst.app.targets.setRemote("local", { targetId: target.id });

    const remote = await inst.app.targets.remoteRepository("local");

    if (remote.credentials.kind !== "sftp") throw new Error("the remote is not an SFTP repository");
    expect(remote.credentials.privateKey).toBe(sftp.privateKey);
    expect(remote.credentials.knownHosts).toContain(" ssh-ed25519 ");
    expect(remote.repository).not.toContain(sftp.privateKey);
  });
});

describe("the remote repository configuration", () => {
  test("a WebDAV target is refused, and its message names the kinds that work", async () => {
    const inst = instanceOf();
    const target = inst.app.targets.add("cloud", {
      kind: "webdav",
      path: "",
      url: "https://dav.example.com/files",
      user: "owner",
      password: "app-password",
    });

    const error = await rejectionOf(
      Promise.resolve().then(() => inst.app.targets.setRemote("local", { targetId: target.id })),
    );

    expect(error).toMatchObject({ status: 400, key: "checkpoint_remote_unsupported" });
    expect(inst.app.targets.remoteOf("local")).toBeNull();
  });

  test("setting and clearing a remote keeps only the target id and the folder, never a credential", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);

    const view = inst.app.targets.setRemote("local", { targetId, path: "backups/checkpoints" });
    expect(view).toMatchObject({
      hostId: "local",
      targetId,
      targetName: "archive",
      kind: "s3",
      path: "backups/checkpoints/local",
    });
    const stored = readFileSync(targetsPath(inst.dataDir), "utf8");
    expect(stored).not.toContain(ACCESS_KEY);
    expect(stored).not.toContain(SECRET_KEY);
    expect(stored).not.toContain(view.lastSyncAt ?? "nothing");

    inst.app.targets.clearRemote("local");
    expect(inst.app.targets.remoteOf("local")).toBeNull();
  });

  test("a host with no remote is a 404 from the copy, and a copy that is already running is a 409", async () => {
    const inst = instanceOf();
    expect(await rejectionOf(inst.app.checkpointRemote.syncHost(inst.host))).toMatchObject({
      status: 404,
      key: "checkpoint_remote_not_set",
    });

    const targetId = s3Target(inst);
    inst.app.targets.setRemote("local", { targetId });
    await checkpointOf(inst, "src");
    const gate = engineOf(inst).holdRemote();
    const first = inst.app.checkpointRemote.syncHost(inst.host);
    while (gate.blocked() === 0) await Bun.sleep(1);
    const error = await rejectionOf(inst.app.checkpointRemote.syncHost(inst.host));
    expect(error).toMatchObject({ status: 409, key: "checkpoint_remote_busy" });
    gate.release();
    expect((await first).checkpoints).toBe(1);
  });

  test("removing a target a host copies to is refused until the remote is cleared", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    inst.app.targets.setRemote("local", { targetId });

    expect(await rejectionOf(Promise.resolve().then(() => inst.app.targets.remove(targetId)))).toMatchObject({
      status: 409,
      key: "target_in_use",
    });
    inst.app.targets.clearRemote("local");
    inst.app.targets.remove(targetId);
    expect(inst.app.targets.list()).toEqual([]);
  });
});

describe("the remote repository operations", () => {
  test("set, read and clear are owned by the owner only, and the copy starts as a task", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    const ctx = ctxOf(inst.app);

    const set = (await inst.app.operations.run("checkpoint.remote.set", ctx, {
      id: "local",
      targetId,
      path: "checkpoints",
    })) as { remote: { targetId: string; path: string } };
    expect(set.remote).toMatchObject({ targetId, path: "checkpoints/local" });
    const got = (await inst.app.operations.run("checkpoint.remote.get", ctx, { id: "local" })) as {
      remote: { targetId: string } | null;
    };
    expect(got.remote?.targetId).toBe(targetId);

    await checkpointOf(inst, "src");
    const started = (await inst.app.operations.run("checkpoint.remote.sync", ctx, { id: "local" })) as {
      taskId: string;
    };
    await inst.app.tasks.drain();
    const finished = inst.app.tasks.get(started.taskId, { output: false });
    expect(finished?.status).toBe("succeeded");
    expect(finished?.result).toEqual({ synced: { hostId: "local", targetId, checkpoints: 1, snapshots: 1 } });

    await inst.app.operations.run("checkpoint.remote.clear", ctx, { id: "local" });
    expect(inst.app.targets.remoteOf("local")).toBeNull();
    expect(await rejectionOf(inst.app.operations.run("checkpoint.remote.sync", ctx, { id: "local" }))).toMatchObject({
      status: 404,
      key: "checkpoint_remote_not_set",
    });
  });
});
