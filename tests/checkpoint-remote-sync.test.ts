import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { App } from "../src/app";
import { CHECKPOINT_VERSION, type CheckpointRecord } from "../src/checkpoints/types";
import { targetsPath } from "../src/data-dir";
import type { HostCtx } from "../src/host/registry";
import { AppError } from "../src/lib/errors";
import { setLogSink } from "../src/lib/logger";
import { OPERATIONS } from "../src/operations/registry";
import type { OperationContext } from "../src/operations/types";
import { OWNER } from "../src/operations/types";
import * as boxes from "../src/services/boxes";
import { REMOTE_SYNC_FAILURE_THRESHOLD } from "../src/services/checkpoint-remote";
import { copyCheckpoint, exportCheckpoint, importPackage } from "../src/services/checkpoint-transfer";
import { deleteCheckpoint, takeCheckpoint } from "../src/services/checkpoints";
import { newBoxId } from "../src/specs/revision";
import { provisionDefaultMounts } from "../src/volumes/provision";
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
  const { app, runtime } = createTestApp({ dataDir });
  const host = app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, {
    [host.keys.template]: "true",
    [host.keys.templateName]: "base",
  });
  return { app, host, dataDir };
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(1);
  }
}

/** A running box with its default workspace and home, so a checkpoint has two layers to write. */
async function runningBox(inst: Instance, name = "race"): Promise<boxes.Box> {
  const id = newBoxId();
  const mounts = await provisionDefaultMounts(inst.host, { id, name, createdBy: "owner" }, new Set());
  return boxes.createBox(inst.host, { id, name, cpus: 1, memoryMb: 256, createdBy: "owner", mounts });
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
    targets: app.targets,
    checkpointRemote: app.checkpointRemote,
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

describe("the sync marks when the remote position changes", () => {
  test("a new folder on the same target makes the checkpoint pending again and copies it there", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    const ctx = ctxOf(inst.app);
    await inst.app.operations.run("checkpoint.remote.set", ctx, { id: "local", targetId, path: "first" });
    const { record, snapshotId } = await checkpointOf(inst, "src");
    await inst.app.checkpointRemote.syncHost(inst.host);
    expect(storedRecord(inst, record.id).remoteSync?.[targetId]).toBeString();

    await inst.app.operations.run("checkpoint.remote.set", ctx, { id: "local", targetId, path: "second" });

    expect(storedRecord(inst, record.id).remoteSync?.[targetId]).toBeUndefined();
    const again = await inst.app.checkpointRemote.syncHost(inst.host);
    expect(again).toEqual({ hostId: "local", targetId, checkpoints: 1, snapshots: 1 });
    expect(engineOf(inst).remoteCopies).toHaveLength(2);
    expect(engineOf(inst).remoteCopies[1]).toEqual({ targetId, snapshotIds: [snapshotId] });
    expect((await inst.app.targets.remoteRepository("local")).repository).toBe(
      "s3:https://s3.example.com/archive/second/local",
    );
  });

  test("clearing the remote and setting the same position back leaves the checkpoint pending", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    const ctx = ctxOf(inst.app);
    await inst.app.operations.run("checkpoint.remote.set", ctx, { id: "local", targetId, path: "same" });
    const { record } = await checkpointOf(inst, "src");
    await inst.app.checkpointRemote.syncHost(inst.host);
    expect(storedRecord(inst, record.id).remoteSync?.[targetId]).toBeString();

    await inst.app.operations.run("checkpoint.remote.clear", ctx, { id: "local" });
    await inst.app.operations.run("checkpoint.remote.set", ctx, { id: "local", targetId, path: "same" });

    expect(storedRecord(inst, record.id).remoteSync?.[targetId]).toBeUndefined();
    expect(await inst.app.checkpointRemote.syncHost(inst.host)).toMatchObject({ checkpoints: 1, snapshots: 1 });
  });

  test("saving the same position again keeps the marks and copies nothing", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    const ctx = ctxOf(inst.app);
    await inst.app.operations.run("checkpoint.remote.set", ctx, { id: "local", targetId, path: "same" });
    const { record } = await checkpointOf(inst, "src");
    await inst.app.checkpointRemote.syncHost(inst.host);
    const at = storedRecord(inst, record.id).remoteSync?.[targetId];
    expect(at).toBeString();

    await inst.app.operations.run("checkpoint.remote.set", ctx, { id: "local", targetId, path: "same" });

    expect(storedRecord(inst, record.id).remoteSync?.[targetId]).toBe(at);
    expect(await inst.app.checkpointRemote.syncHost(inst.host)).toMatchObject({ checkpoints: 0, snapshots: 0 });
    expect(engineOf(inst).remoteCopies).toHaveLength(1);
  });

  test("a copy that fails after the position changes records nothing on the new position and starts no backoff", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    const ctx = ctxOf(inst.app);
    await inst.app.operations.run("checkpoint.remote.set", ctx, { id: "local", targetId, path: "first" });
    const { record } = await checkpointOf(inst, "src");
    const gate = engineOf(inst).holdRemote();
    const copying = inst.app.checkpointRemote.syncHost(inst.host);
    while (gate.blocked() === 0) await Bun.sleep(1);

    await inst.app.operations.run("checkpoint.remote.set", ctx, { id: "local", targetId, path: "second" });
    engineOf(inst).failRemoteCopy = true;
    gate.release();

    // The copy to the old folder really failed, and the caller is told so.
    const error = await rejectionOf(copying);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("unreachable");
    // The failure belongs to the folder the copy went to, not to the one the host now points at.
    expect(storedRecord(inst, record.id).remoteFailure).toBeUndefined();
    expect(inst.app.targets.remoteOf("local")?.lastError).toBeNull();
    expect(inst.app.checkpointRemote.stateOf("local")).toEqual({ failures: 0, lastFailure: null });

    // No retry delay from the old position holds the next pass back: the copy goes to the folder now set.
    engineOf(inst).failRemoteCopy = false;
    expect(await inst.app.checkpointRemote.run()).toHaveLength(1);
    expect(storedRecord(inst, record.id).remoteSync?.[targetId]).toBeString();
  });

  test("a copy that fails after the remote moves to another target, under the same folder, records nothing on the new one", async () => {
    const inst = instanceOf();
    const first = s3Target(inst);
    const second = s3Target(inst, "other");
    const ctx = ctxOf(inst.app);
    await inst.app.operations.run("checkpoint.remote.set", ctx, { id: "local", targetId: first, path: "same" });
    const { record } = await checkpointOf(inst, "src");
    const gate = engineOf(inst).holdRemote();
    const copying = inst.app.checkpointRemote.syncHost(inst.host);
    while (gate.blocked() === 0) await Bun.sleep(1);

    await inst.app.operations.run("checkpoint.remote.set", ctx, { id: "local", targetId: second, path: "same" });
    engineOf(inst).failRemoteCopy = true;
    gate.release();

    expect(await rejectionOf(copying)).toBeInstanceOf(Error);
    expect(storedRecord(inst, record.id).remoteFailure).toBeUndefined();
    expect(inst.app.targets.remoteOf("local")?.lastError).toBeNull();
    expect(inst.app.checkpointRemote.stateOf("local")).toEqual({ failures: 0, lastFailure: null });
  });

  test("a copy still running when the host switches to remote-only marks nothing", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    const ctx = ctxOf(inst.app);
    await inst.app.operations.run("checkpoint.remote.set", ctx, { id: "local", targetId });
    const { record } = await checkpointOf(inst, "src");
    const gate = engineOf(inst).holdRemote();
    const copying = inst.app.checkpointRemote.syncHost(inst.host);
    while (gate.blocked() === 0) await Bun.sleep(1);

    // The mode can only change with no records, so the record the copy is for is deleted while it still runs.
    inst.host.checkpoints.remove(record.id);
    await inst.app.operations.run("checkpoint.remote.set", ctx, { id: "local", targetId, mode: "only" });
    gate.release();
    expect(await copying).toMatchObject({ checkpoints: 0 });

    // The copy went to a repository the host no longer uses the same way, so it is not reported as synced.
    const remote = inst.app.targets.remoteOf("local");
    expect(remote).toMatchObject({ mode: "only", targetId });
    expect(remote?.lastSyncAt).toBeNull();
  });

  test("a copy still running when the position changes marks nothing, since it went to the old position", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    const ctx = ctxOf(inst.app);
    await inst.app.operations.run("checkpoint.remote.set", ctx, { id: "local", targetId, path: "first" });
    const { record } = await checkpointOf(inst, "src");
    const gate = engineOf(inst).holdRemote();
    const copying = inst.app.checkpointRemote.syncHost(inst.host);
    while (gate.blocked() === 0) await Bun.sleep(1);

    await inst.app.operations.run("checkpoint.remote.set", ctx, { id: "local", targetId, path: "second" });
    gate.release();
    expect(await copying).toMatchObject({ checkpoints: 0 });

    expect(storedRecord(inst, record.id).remoteSync?.[targetId]).toBeUndefined();
    expect(inst.app.targets.remoteOf("local")?.lastSyncAt).toBeNull();
    expect(await inst.app.checkpointRemote.syncHost(inst.host)).toMatchObject({ checkpoints: 1, snapshots: 1 });
  });
});

interface Overview {
  attention: {
    kind: string;
    severity: "error" | "warning";
    hostId: string;
    at: string | null;
    subject: string;
    box: { id: string; name: string } | null;
    params: Record<string, string | number>;
  }[];
}

async function overviewOf(inst: Instance): Promise<Overview> {
  return (await inst.app.operations.run("overview.get", ctxOf(inst.app), {})) as Overview;
}

describe("a streak of failed copies", () => {
  test("the overview lists the host only at the threshold, once, and clears the item after a success", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    inst.app.targets.setRemote("local", { targetId });
    await checkpointOf(inst, "src");
    engineOf(inst).failRemoteCopy = true;

    for (let failures = 1; failures < REMOTE_SYNC_FAILURE_THRESHOLD; failures += 1) {
      await rejectionOf(inst.app.checkpointRemote.syncHost(inst.host));
      expect(inst.app.checkpointRemote.stateOf("local").failures).toBe(failures);
      expect((await overviewOf(inst)).attention).toEqual([]);
    }
    await rejectionOf(inst.app.checkpointRemote.syncHost(inst.host));
    const state = inst.app.checkpointRemote.stateOf("local");
    expect(state.failures).toBe(REMOTE_SYNC_FAILURE_THRESHOLD);
    expect(state.lastFailure).toMatchObject({ targetId });
    expect(state.lastFailure?.at).toBeString();
    expect(state.lastFailure?.message).toContain("unreachable");

    expect((await overviewOf(inst)).attention).toEqual([
      expect.objectContaining({
        kind: "host.remote_sync_failing",
        severity: "warning",
        hostId: "local",
        subject: inst.host.host.name,
        box: null,
        params: {
          target: "archive",
          failures: REMOTE_SYNC_FAILURE_THRESHOLD,
          detail: state.lastFailure?.message,
        },
      }),
    ]);

    engineOf(inst).failRemoteCopy = false;
    await inst.app.checkpointRemote.syncHost(inst.host);
    expect(inst.app.checkpointRemote.stateOf("local")).toEqual({ failures: 0, lastFailure: null });
    expect((await overviewOf(inst)).attention).toEqual([]);
  });

  test("an offline host is not listed for a failing remote, since its offline item already covers it", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    inst.app.targets.setRemote("local", { targetId });
    await checkpointOf(inst, "src");
    engineOf(inst).failRemoteCopy = true;
    for (let failures = 0; failures < REMOTE_SYNC_FAILURE_THRESHOLD; failures += 1) {
      await rejectionOf(inst.app.checkpointRemote.syncHost(inst.host));
    }
    inst.host.host.status = "offline";

    const kinds = (await overviewOf(inst)).attention.map((item) => item.kind);
    expect(kinds).not.toContain("host.remote_sync_failing");
    expect(kinds).toContain("host.offline");
  });

  test("the third failure logs once, and later failures in the same streak do not log again", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    inst.app.targets.setRemote("local", { targetId });
    await checkpointOf(inst, "src");
    engineOf(inst).failRemoteCopy = true;
    const lines: string[] = [];
    const restore = setLogSink((level, line) => {
      if (level === "warn") lines.push(line);
    }, "warn");
    try {
      for (let failures = 0; failures < REMOTE_SYNC_FAILURE_THRESHOLD + 2; failures += 1) {
        await rejectionOf(inst.app.checkpointRemote.syncHost(inst.host));
      }
    } finally {
      restore();
    }

    const warnings = lines.filter((line) => line.includes("checkpoint.remote_sync_failing"));
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(warnings[0] ?? "{}")).toMatchObject({
      level: "warn",
      msg: "checkpoint.remote_sync_failing",
      host: "local",
      target: targetId,
      failures: REMOTE_SYNC_FAILURE_THRESHOLD,
    });
  });

  test("reading a configured remote reports the count and the last failure, and an unset remote keeps its old shape", async () => {
    const inst = instanceOf();
    const ctx = ctxOf(inst.app);
    expect(await inst.app.operations.run("checkpoint.remote.get", ctx, { id: "local" })).toEqual({
      remote: null,
      records: 0,
    });

    const targetId = s3Target(inst);
    inst.app.targets.setRemote("local", { targetId });
    await checkpointOf(inst, "src");
    engineOf(inst).failRemoteCopy = true;
    await rejectionOf(inst.app.checkpointRemote.syncHost(inst.host));
    await rejectionOf(inst.app.checkpointRemote.syncHost(inst.host));

    const failed = (await inst.app.operations.run("checkpoint.remote.get", ctx, { id: "local" })) as {
      remote: { failures: number; lastFailure: { targetId: string; at: string; message: string } | null };
    };
    expect(failed.remote.failures).toBe(2);
    expect(failed.remote.lastFailure).toMatchObject({ targetId });
    expect(failed.remote.lastFailure?.message).toContain("unreachable");

    engineOf(inst).failRemoteCopy = false;
    await inst.app.checkpointRemote.syncHost(inst.host);
    const recovered = (await inst.app.operations.run("checkpoint.remote.get", ctx, { id: "local" })) as {
      remote: { failures: number; lastFailure: unknown };
    };
    expect(recovered.remote).toMatchObject({ failures: 0, lastFailure: null });
  });
});

/** The remote of a test instance, as the read operation reports it. */
async function remoteOf(
  inst: Instance,
): Promise<{ remote: { mode: string; targetId: string; path: string } | null; records: number }> {
  return (await inst.app.operations.run("checkpoint.remote.get", ctxOf(inst.app), { id: "local" })) as {
    remote: { mode: string; targetId: string; path: string } | null;
    records: number;
  };
}

/** Sets the remote through the operation, so the mode check and the save path are the ones a console uses. */
function saveRemote(
  inst: Instance,
  input: { targetId: string; path?: string; mode?: "sync" | "only" },
): Promise<unknown> {
  return inst.app.operations.run("checkpoint.remote.set", ctxOf(inst.app), { id: "local", ...input });
}

function saveRemoteOn(
  inst: Instance,
  hostId: string,
  input: { targetId: string; path?: string; mode?: "sync" | "only" },
): Promise<unknown> {
  return inst.app.operations.run("checkpoint.remote.set", ctxOf(inst.app), { id: hostId, ...input });
}

describe("a host that keeps its checkpoints only on the remote", () => {
  test("a host with no records switches to only and back, and the repository is opened before the save", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);

    const set = (await saveRemote(inst, { targetId, mode: "only" })) as { remote: { mode: string; path: string } };
    expect(set.remote).toMatchObject({ mode: "only", path: "local" });
    expect(engineOf(inst).remoteChecks).toHaveLength(1);
    expect(engineOf(inst).remoteChecks[0]?.repository).toBe("s3:https://s3.example.com/archive/local");
    expect((await remoteOf(inst)).remote).toMatchObject({ mode: "only", targetId, path: "local" });

    const back = (await saveRemote(inst, { targetId, mode: "sync" })) as { remote: { mode: string } };
    expect(back.remote.mode).toBe("sync");
    // The remote is validated only when the host is set to use it alone.
    expect(engineOf(inst).remoteChecks).toHaveLength(1);
  });

  test("a host with a record cannot switch either way, and a record in the recycle bin counts", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    inst.app.targets.setRemote("local", { targetId });
    const { record } = await checkpointOf(inst, "src");

    expect(await rejectionOf(Promise.resolve().then(() => saveRemote(inst, { targetId, mode: "only" })))).toMatchObject(
      {
        status: 409,
        key: "checkpoint_remote_has_checkpoints",
      },
    );
    expect((await remoteOf(inst)).remote?.mode).toBe("sync");

    const now = new Date().toISOString();
    inst.host.checkpoints.write({
      ...storedRecord(inst, record.id),
      trash: {
        kind: "box",
        sourceId: "bx_abcdefgh",
        sourceName: "deleted",
        deletedAt: now,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(await rejectionOf(Promise.resolve().then(() => saveRemote(inst, { targetId, mode: "only" })))).toMatchObject(
      {
        status: 409,
        key: "checkpoint_remote_has_checkpoints",
      },
    );

    inst.host.checkpoints.remove(record.id);
    expect(((await saveRemote(inst, { targetId, mode: "only" })) as { remote: { mode: string } }).remote.mode).toBe(
      "only",
    );
    await checkpointOf(inst, "after");
    expect(await rejectionOf(Promise.resolve().then(() => saveRemote(inst, { targetId, mode: "sync" })))).toMatchObject(
      {
        status: 409,
        key: "checkpoint_remote_has_checkpoints",
      },
    );
  });

  test("the read reports the host's records, recycling bin included, with or without a remote", async () => {
    const inst = instanceOf();
    const ctx = ctxOf(inst.app);
    // An unset remote keeps the shape of its old answer and still counts the host's records.
    expect(await inst.app.operations.run("checkpoint.remote.get", ctx, { id: "local" })).toEqual({
      remote: null,
      records: 0,
    });

    const targetId = s3Target(inst);
    await saveRemote(inst, { targetId, mode: "only" });
    const { record } = await checkpointOf(inst, "src");
    const counted = (await inst.app.operations.run("checkpoint.remote.get", ctx, { id: "local" })) as {
      records: number;
    };
    expect(counted.records).toBe(1);

    const now = new Date().toISOString();
    inst.host.checkpoints.write({
      ...storedRecord(inst, record.id),
      trash: {
        kind: "box",
        sourceId: "bx_abcdefgh",
        sourceName: "deleted",
        deletedAt: now,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    // The page's own checkpoint list leaves the recycling bin entry out, so the read has to count it.
    const listed = (await inst.app.operations.run("checkpoint.list", ctx, {})) as { checkpoints: { id: string }[] };
    expect(listed.checkpoints.map((checkpoint) => checkpoint.id)).not.toContain(record.id);
    const trashed = (await inst.app.operations.run("checkpoint.remote.get", ctx, { id: "local" })) as {
      remote: { mode: string } | null;
      records: number;
    };
    expect(trashed.remote?.mode).toBe("only");
    expect(trashed.records).toBe(1);
  });

  test("a remote-only host cannot be moved or cleared with records, while a sync host still can", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    await saveRemote(inst, { targetId, mode: "only" });
    const { record } = await checkpointOf(inst, "src");

    expect(
      await rejectionOf(Promise.resolve().then(() => saveRemote(inst, { targetId, path: "elsewhere" }))),
    ).toMatchObject({ status: 409, key: "checkpoint_remote_has_checkpoints" });
    expect(await rejectionOf(Promise.resolve().then(() => inst.app.targets.clearRemote("local")))).toMatchObject({
      status: 409,
      key: "checkpoint_remote_has_checkpoints",
    });
    expect(await remoteOf(inst)).toMatchObject({ remote: { mode: "only", path: "local" } });

    inst.host.checkpoints.remove(record.id);
    const moved = (await saveRemote(inst, { targetId, path: "elsewhere" })) as { remote: { path: string } };
    expect(moved.remote.path).toBe("elsewhere/local");
    inst.app.targets.clearRemote("local");
    expect(await remoteOf(inst)).toEqual({ remote: null, records: 0 });

    // The same changes on a sync-mode host are not locked by its records.
    const sync = instanceOf();
    const syncTarget = s3Target(sync);
    sync.app.targets.setRemote("local", { targetId: syncTarget });
    await checkpointOf(sync, "src");
    const movedSync = (await saveRemote(sync, { targetId: syncTarget, path: "moved" })) as {
      remote: { path: string };
    };
    expect(movedSync.remote.path).toBe("moved/local");
    sync.app.targets.clearRemote("local");
    expect(sync.app.targets.remoteOf("local")).toBeNull();
  });

  test("a remote-only host is skipped by every sync pass, and a manual sync is a 409", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    await saveRemote(inst, { targetId, mode: "only" });
    const { record } = await checkpointOf(inst, "src");

    expect(await inst.app.checkpointRemote.run()).toEqual([]);
    expect(engineOf(inst).remoteCopies).toEqual([]);
    expect(storedRecord(inst, record.id).remoteSync).toBeUndefined();
    expect(inst.app.checkpointRemote.stateOf("local")).toEqual({ failures: 0, lastFailure: null });
    expect(await rejectionOf(inst.app.checkpointRemote.syncHost(inst.host))).toMatchObject({
      status: 409,
      key: "checkpoint_remote_only_no_sync",
    });
    expect(
      await rejectionOf(inst.app.operations.run("checkpoint.remote.sync", ctxOf(inst.app), { id: "local" })),
    ).toMatchObject({ status: 409, key: "checkpoint_remote_only_no_sync" });
    expect(engineOf(inst).remoteCopies).toEqual([]);
  });

  test("the overview drops a failing sync streak when the host switches to remote-only", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    inst.app.targets.setRemote("local", { targetId });
    const { record } = await checkpointOf(inst, "src");
    engineOf(inst).failRemoteCopy = true;
    for (let failures = 0; failures < REMOTE_SYNC_FAILURE_THRESHOLD; failures += 1) {
      await rejectionOf(inst.app.checkpointRemote.syncHost(inst.host));
    }
    expect((await overviewOf(inst)).attention.some((item) => item.kind === "host.remote_sync_failing")).toBe(true);

    // The retry state survives on the service, but a remote-only host reports nothing and is never listed.
    inst.host.checkpoints.remove(record.id);
    await saveRemote(inst, { targetId, mode: "only" });

    expect(inst.app.checkpointRemote.stateOf("local")).toEqual({ failures: 0, lastFailure: null });
    expect((await overviewOf(inst)).attention.some((item) => item.kind === "host.remote_sync_failing")).toBe(false);
  });

  test("a failed check refuses the save and leaves the previous setting in place", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    inst.app.targets.setRemote("local", { targetId, path: "first" });
    engineOf(inst).failRemoteCheck = true;

    const error = await rejectionOf(
      Promise.resolve().then(() =>
        inst.app.operations.run("checkpoint.remote.set", ctxOf(inst.app), {
          id: "local",
          targetId,
          path: "second",
          mode: "only",
        }),
      ),
    );
    expect(error).toMatchObject({ status: 502, key: "checkpoint_remote_check_failed" });
    expect(inst.app.targets.remoteOf("local")).toMatchObject({ mode: "sync", path: "first/local" });
    expect(engineOf(inst).remoteChecks).toHaveLength(1);

    engineOf(inst).failRemoteCheck = false;
    const saved = (await inst.app.operations.run("checkpoint.remote.set", ctxOf(inst.app), {
      id: "local",
      targetId,
      path: "second",
      mode: "only",
    })) as { remote: { mode: string } };
    expect(saved.remote.mode).toBe("only");
    expect(engineOf(inst).remoteChecks).toHaveLength(2);
  });

  test("a remote file written before modes existed reads as sync", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "minibox-remote-old-"));
    dirs.push(dataDir);
    const now = new Date().toISOString();
    mkdirSync(join(dataDir, "secrets"), { recursive: true, mode: 0o700 });
    writeFileSync(
      targetsPath(dataDir),
      JSON.stringify({
        version: 1,
        targets: [],
        remotes: [
          {
            hostId: "local",
            targetId: "tgt_0000000000000000",
            kind: "s3",
            path: "old",
            createdAt: now,
            updatedAt: now,
            lastSyncAt: null,
            lastError: null,
          },
        ],
      }),
    );
    const { app } = createTestApp({ dataDir });

    expect(app.targets.remoteOf("local")).toMatchObject({ mode: "sync", path: "old/local" });
  });
});

describe("a remote-only relocation and a checkpoint write exclude each other", () => {
  const PASSPHRASE = "correct horse battery staple";

  test("a multi-layer take in progress refuses a switch to only, and the record stays in the repository it started in", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    inst.app.targets.setRemote("local", { targetId });
    const box = await runningBox(inst);
    const gate = engineOf(inst).holdBackupAt(2);

    const taking = takeCheckpoint(
      inst.host,
      box.boxId,
      { pinned: false, include: { system: false, volumes: [] }, consistency: "live" },
      "owner",
    );
    await waitFor(() => gate.blocked() > 0, "the second layer");

    const error = await rejectionOf(saveRemote(inst, { targetId, mode: "only" }));

    expect(error).toMatchObject({ status: 409, key: "checkpoint_remote_write_busy" });
    expect(inst.app.targets.remoteOf("local")?.mode).toBe("sync");
    gate.release();
    const view = await taking;
    expect(inst.host.checkpoints.read(view.id)?.data).toHaveLength(2);
    expect(inst.app.targets.remoteOf("local")?.mode).toBe("sync");
  });

  test("a switch to only in progress refuses a take, and the take succeeds after the save", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    const box = await runningBox(inst);
    const gate = engineOf(inst).holdRemoteCheck();

    const saving = saveRemote(inst, { targetId, mode: "only" });
    await waitFor(() => gate.blocked() > 0, "the remote check");
    const error = await rejectionOf(
      takeCheckpoint(
        inst.host,
        box.boxId,
        { pinned: false, include: { system: false, volumes: [] }, consistency: "live" },
        "owner",
      ),
    );

    expect(error).toMatchObject({ status: 409, key: "checkpoint_remote_relocating" });
    expect(engineOf(inst).started).toBe(0);
    expect(inst.host.checkpoints.list()).toEqual([]);
    gate.release();
    await saving;
    expect(inst.app.targets.remoteOf("local")?.mode).toBe("only");

    const view = await takeCheckpoint(
      inst.host,
      box.boxId,
      { pinned: false, include: { system: false, volumes: [] }, consistency: "live" },
      "owner",
    );
    expect(inst.host.checkpoints.read(view.id)?.data).toHaveLength(2);
  });

  test("a take in progress refuses clearing an only-remote repository", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    await saveRemote(inst, { targetId, mode: "only" });
    const box = await runningBox(inst);
    const gate = engineOf(inst).holdBackupAt(1);

    const taking = takeCheckpoint(
      inst.host,
      box.boxId,
      { pinned: false, include: { system: false, volumes: [] }, consistency: "live" },
      "owner",
    );
    await waitFor(() => gate.blocked() > 0, "the first layer");
    const error = await rejectionOf(
      inst.app.operations.run("checkpoint.remote.clear", ctxOf(inst.app), { id: "local" }),
    );

    expect(error).toMatchObject({ status: 409, key: "checkpoint_remote_write_busy" });
    expect(inst.app.targets.remoteOf("local")?.mode).toBe("only");
    gate.release();
    await taking;
    expect(inst.app.targets.remoteOf("local")?.mode).toBe("only");
  });

  test("the gate releases after success and after a throw, and refuses each side while the other holds it", async () => {
    const inst = instanceOf();
    const store = inst.host.checkpoints;
    let releaseWrite: (() => void) | undefined;
    const writing = store.writing(
      "gate",
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = resolve;
        }),
    );
    await waitFor(() => releaseWrite !== undefined, "the write gate");

    expect(
      await rejectionOf(Promise.resolve().then(() => store.relocating("gate", async () => undefined))),
    ).toMatchObject({
      status: 409,
      key: "checkpoint_remote_write_busy",
    });
    releaseWrite?.();
    await writing;
    await store.relocating("gate", async () => undefined);

    expect(
      await rejectionOf(
        store.writing("gate2", async () => {
          throw new Error("the write failed");
        }),
      ),
    ).toBeInstanceOf(Error);
    await store.relocating("gate2", async () => undefined);

    let releaseRelocation: (() => void) | undefined;
    const relocating = store.relocating(
      "gate3",
      () =>
        new Promise<void>((resolve) => {
          releaseRelocation = resolve;
        }),
    );
    await waitFor(() => releaseRelocation !== undefined, "the relocation gate");
    expect(
      await rejectionOf(Promise.resolve().then(() => store.writing("gate3", async () => undefined))),
    ).toMatchObject({
      status: 409,
      key: "checkpoint_remote_relocating",
    });
    // A second relocation of the same host is refused too, and does not release the first one's place when it fails.
    expect(
      await rejectionOf(Promise.resolve().then(() => store.relocating("gate3", async () => undefined))),
    ).toMatchObject({
      status: 409,
      key: "checkpoint_remote_relocating",
    });
    expect(
      await rejectionOf(Promise.resolve().then(() => store.writing("gate3", async () => undefined))),
    ).toMatchObject({
      status: 409,
      key: "checkpoint_remote_relocating",
    });
    releaseRelocation?.();
    await relocating;
  });

  test("an import in progress refuses a switch to only, and writes its record after the save is refused", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    const box = await runningBox(inst, "imported");
    const checkpoint = await takeCheckpoint(
      inst.host,
      box.boxId,
      { pinned: false, include: { system: false, volumes: [] }, consistency: "live" },
      "owner",
    );
    const pkg = await exportCheckpoint(inst.host, checkpoint.id, PASSPHRASE, "owner");
    await deleteCheckpoint(inst.host, checkpoint.id);
    expect(inst.host.checkpoints.read(checkpoint.id)).toBeNull();
    const gate = engineOf(inst).holdUnpack();

    const importing = importPackage(inst.host, pkg.id, PASSPHRASE, "owner");
    await waitFor(() => gate.blocked() > 0, "the import unpack");
    const error = await rejectionOf(saveRemote(inst, { targetId, mode: "only" }));

    expect(error).toMatchObject({ status: 409, key: "checkpoint_remote_write_busy" });
    expect(inst.app.targets.remoteOf("local")).toBeNull();
    gate.release();
    await importing;
    expect(inst.host.checkpoints.read(checkpoint.id)).not.toBeNull();
  });

  test("a copy in progress on the target refuses a switch to only there", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    await inst.app.hostAdmin.add({ id: "edge", endpoint: "unix:///run/minibox-test/edge-docker.sock" });
    const edge = inst.app.hosts.get("edge");
    (edge.runtime as FakeRuntime).seedImage(edge.baseTemplateTag, {
      [edge.keys.template]: "true",
      [edge.keys.templateName]: "base",
    });
    const box = await runningBox(inst, "copied");
    const record = await takeCheckpoint(
      inst.host,
      box.boxId,
      { pinned: false, include: { system: false, volumes: [] }, consistency: "live" },
      "owner",
    );
    const gate = engineOf(inst).holdUnpack();

    const copying = copyCheckpoint(inst.host, edge, record.id, "owner", [inst.host]);
    await waitFor(() => gate.blocked() > 0, "the copy unpack");
    const error = await rejectionOf(saveRemoteOn(inst, "edge", { targetId, mode: "only" }));

    expect(error).toMatchObject({ status: 409, key: "checkpoint_remote_write_busy" });
    expect(inst.app.targets.remoteOf("edge")).toBeNull();
    gate.release();
    const copy = await copying;
    expect(edge.checkpoints.read(copy.id)?.hostId).toBe("edge");
    inst.app.hostAdmin.close();
  });

  test("a no-op only save leaves the remote alone, and a sync folder change still works during a write", async () => {
    const inst = instanceOf();
    const targetId = s3Target(inst);
    await saveRemote(inst, { targetId, mode: "only" });
    const checks = engineOf(inst).remoteChecks.length;

    await saveRemote(inst, { targetId, mode: "only" });
    expect(engineOf(inst).remoteChecks).toHaveLength(checks);

    const sync = instanceOf();
    const syncTarget = s3Target(sync);
    sync.app.targets.setRemote("local", { targetId: syncTarget });
    const box = await runningBox(sync);
    const gate = engineOf(sync).holdBackupAt(1);
    const taking = takeCheckpoint(
      sync.host,
      box.boxId,
      { pinned: false, include: { system: false, volumes: [] }, consistency: "live" },
      "owner",
    );
    await waitFor(() => gate.blocked() > 0, "the sync write");
    const movedSync = (await saveRemote(sync, { targetId: syncTarget, path: "moved" })) as {
      remote: { path: string };
    };
    expect(movedSync.remote.path).toBe("moved/local");
    gate.release();
    await taking;
  });

  test("the set operation is a long synchronous request", () => {
    expect(OPERATIONS.find((operation) => operation.name === "checkpoint.remote.set")?.longSync).toBe(true);
  });
});
