import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { HostMetrics } from "../src/host/metrics";
import type { HostCtx } from "../src/host/registry";
import { createVolume, getVolume } from "../src/services/volumes";
import { remeasureHostDisk } from "../src/volumes/disk";
import { silenceLogs } from "./support/app";
import {
  type CheckpointBody,
  call,
  finishedTask,
  type Harness,
  mint,
  type Reply,
  startHarness,
} from "./support/tokens";

const GB = 1024 ** 3;
const MB = 1024 * 1024;
const DISK_TOTAL = 100 * GB;

/** A host with room for every request here, so the capacity check never decides an answer. */
const ROOMY_HOST = { cpu: { cores: 64 }, memory: { total: 64 * GB } } as unknown as HostMetrics;

/** An app whose disk floor and checkpoint capacity leave every request here to the rule under test. */
function harnessWithDisk(): { harness: Harness; host: HostCtx } {
  const harness = startHarness();
  harness.app.monitor.snapshot = async () => ROOMY_HOST;
  harness.runtime.disk = { totalBytes: DISK_TOTAL, freeBytes: 40 * GB };
  return { harness, host: harness.app.hosts.get() };
}

describe("snapshotting one volume over HTTP", () => {
  let harness: Harness;
  let host: HostCtx;
  let restoreLogs: () => void;

  beforeEach(async () => {
    restoreLogs = silenceLogs();
    ({ harness, host } = harnessWithDisk());
    await remeasureHostDisk(host);
  });

  afterEach(() => {
    harness.stop();
    restoreLogs();
  });

  /** Snapshots a volume over REST and waits for its task, which returns the checkpoint. */
  async function snapshot(ref: string, body: Record<string, unknown> = {}, token?: string): Promise<CheckpointBody> {
    const started = await call(harness.base, `/api/volumes/${encodeURIComponent(ref)}/checkpoints`, {
      method: "POST",
      body,
      token,
    });
    expect(started.status).toBe(202);
    const done = await finishedTask(harness.base, started.json.taskId ?? "");
    expect(done.status).toBe("succeeded");
    const checkpoint = done.result?.checkpoint;
    if (!checkpoint) throw new Error("the task returned no checkpoint");
    return checkpoint;
  }

  function seed(volume: string, path: string, text: string): void {
    harness.runtime.seedVolumeFile(volume, path, {
      type: "file",
      content: Buffer.from(text),
      mode: 0o644,
      uid: 1000,
      gid: 1000,
    });
  }

  function filesOf(volume: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, entry] of harness.runtime.filesOf(volume)) {
      if (path !== "" && entry.type === "file") out[path] = entry.content?.toString() ?? "";
    }
    return out;
  }

  test("an independent volume no box mounts is snapshotted on its own: the record names no box and holds that one volume", async () => {
    const volume = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    seed(volume.engineName, "todo.md", "- write the report\n");

    const checkpoint = await snapshot(volume.id, { label: "before the edit" });

    expect(checkpoint).toMatchObject({
      boxId: null,
      label: "before the edit",
      legacy: false,
      pinned: false,
      consistency: "live",
      system: null,
    });
    // The box name carries the volume's name, so a list that groups a record with no box shows the volume it holds.
    expect(checkpoint).toMatchObject({ boxName: "notes" });
    expect(checkpoint.data).toHaveLength(1);
    expect(checkpoint.data[0]).toMatchObject({ volumeId: volume.id, path: "", mode: "rw", ownership: "independent" });

    const stored = host.checkpoints.read(checkpoint.id);
    expect(stored).toMatchObject({ boxId: null, boxName: "notes", spec: null, specRevision: null });
    // The snapshot is tagged with the checkpoint and the volume, and with no box.
    const tags = harness.checkpoints.snapshots.get(checkpoint.data[0]?.snapshotId ?? "")?.tags ?? [];
    expect(tags).toEqual([`checkpoint:${checkpoint.id}`, `volume:${volume.id}`]);

    // The list and the read show it like any other checkpoint.
    const listed = await call(harness.base, "/api/checkpoints");
    expect(listed.json.checkpoints?.map((item) => item.id)).toEqual([checkpoint.id]);
    const read = await call(harness.base, `/api/checkpoints/${checkpoint.id}`);
    expect(read.status).toBe(200);
    expect(read.json.checkpoint).toMatchObject({ id: checkpoint.id, boxId: null, boxName: "notes" });
  });

  test("a volume that a box mounts is snapshotted without the box, and the box keeps running", async () => {
    const made = await call(harness.base, "/api/boxes", { body: { name: "alpha", cpus: 1, memoryMb: 256 } });
    expect(made.status).toBe(201);
    const shared = await createVolume(host, { name: "shared", role: null, createdBy: "owner" });
    const attached = await call(harness.base, `/api/volumes/${shared.id}/attach`, {
      body: { box: made.json.box?.id, path: "/srv/data", mode: "ro", confirm: true },
      headers: { "if-match": String(made.json.box?.revision) },
    });
    expect(attached.status).toBe(200);
    seed(shared.engineName, "data.csv", "a,b\n");

    const checkpoint = await snapshot(shared.id);

    expect(checkpoint).toMatchObject({ boxId: null, boxName: "shared" });
    expect(checkpoint.data.map((layer) => layer.volumeId)).toEqual([shared.id]);
    // A volume snapshot reads live: the box it is mounted by is never paused or stopped for it. (Pausing belongs to the
    // system-layer commit a box's checkpoint may take, which a volume snapshot never does.)
    const snapshotCalls = harness.runtime.calls.map((call) => call.op);
    const commit = snapshotCalls.indexOf("commitContainer");
    expect(commit).toBe(-1);
    const box = await call(harness.base, `/api/boxes/${made.json.box?.boxId}`);
    expect(box.json.box).toMatchObject({ running: true, state: "running" });
  });

  test("the volume's data is still there after the snapshot, and the snapshot holds what it held", async () => {
    const volume = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    seed(volume.engineName, "todo.md", "- write the report\n");

    const checkpoint = await snapshot(volume.id);
    seed(volume.engineName, "todo.md", "- write the report\n- send it\n");

    expect(filesOf(volume.engineName)).toEqual({ "todo.md": "- write the report\n- send it\n" });
    const snapshotId = checkpoint.data[0]?.snapshotId ?? "";
    const held = harness.checkpoints.snapshots.get(snapshotId);
    const content = held?.files.get("todo.md")?.content?.toString() ?? "";
    expect(content).toBe("- write the report\n");
  });

  test("a cache volume and a tools volume are refused with checkpoint_volume_excluded, and nothing is taken", async () => {
    const cache = await createVolume(host, { name: "cache-a", role: "cache", createdBy: "owner" });
    const tools = await createVolume(host, { name: "tools-a", role: "tools", createdBy: "owner" });

    for (const volume of [cache, tools]) {
      const reply = await call(harness.base, `/api/volumes/${volume.id}/checkpoints`, { method: "POST", body: {} });
      expect(reply).toMatchObject({
        status: 400,
        json: { error: { key: "checkpoint_volume_excluded", code: "validation_failed" } },
      });
      expect(reply.json).not.toHaveProperty("taskId");
    }
    expect(host.checkpoints.list()).toEqual([]);
  });

  test("a volume the engine has lost is refused, since a backup would only create it again empty", async () => {
    const volume = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    harness.runtime.volumes.delete(volume.engineName);

    const reply = await call(harness.base, `/api/volumes/${volume.id}/checkpoints`, { method: "POST", body: {} });

    expect(reply).toMatchObject({ status: 409, json: { error: { key: "volume_missing", code: "conflict" } } });
    expect(host.checkpoints.list()).toEqual([]);
  });

  test("an offline remote host is refused with its reason before any task starts", async () => {
    // The local host is never marked offline, so the check is the remote one a second host gets.
    const added = await call(harness.base, "/api/hosts", {
      method: "POST",
      body: { id: "lab", endpoint: "unix:///var/run/lab.sock" },
    });
    expect(added.status).toBe(201);
    const lab = harness.app.hosts.get("lab");
    const volume = await createVolume(lab, { name: "notes", role: null, createdBy: "owner" });
    lab.host.status = "offline";

    const reply = await call(harness.base, `/api/volumes/${volume.id}/checkpoints`, { method: "POST", body: {} });

    expect(reply).toMatchObject({ status: 409, json: { error: { key: "volume_snapshot_host_offline" } } });
    expect(reply.json).not.toHaveProperty("taskId");
  });

  test("a missing volume is a 404 before anything starts", async () => {
    const reply = await call(harness.base, "/api/volumes/nowhere/checkpoints", { method: "POST", body: {} });
    expect(reply).toMatchObject({ status: 404, json: { error: { key: "volume_not_found" } } });
  });

  test("a label is optional, and a snapshot without one is labelled with the volume's name", async () => {
    const volume = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    const checkpoint = await snapshot(volume.id);
    expect(checkpoint).toMatchObject({ label: "notes", boxName: "notes" });
  });

  test("pinned is recorded, so the snapshot cannot be deleted until it is unpinned", async () => {
    const volume = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    const checkpoint = await snapshot(volume.id, { pinned: true });

    expect(checkpoint.pinned).toBe(true);
    const refusedDelete = await call(harness.base, `/api/checkpoints/${checkpoint.id}`, { method: "DELETE" });
    expect(refusedDelete).toMatchObject({ status: 409, json: { error: { key: "checkpoint_pinned" } } });

    const unpinned = await call(harness.base, `/api/checkpoints/${checkpoint.id}`, {
      method: "PATCH",
      body: { pinned: false },
    });
    expect(unpinned.status).toBe(202);
    await finishedTask(harness.base, unpinned.json.taskId ?? "");
    const removed = await call(harness.base, `/api/checkpoints/${checkpoint.id}`, { method: "DELETE" });
    expect(removed.status).toBe(202);
    expect((await finishedTask(harness.base, removed.json.taskId ?? "")).status).toBe("succeeded");
    expect(host.checkpoints.list()).toEqual([]);
  });

  test("the record takes part in the retention policy: it is never expired as an automatic checkpoint", async () => {
    const volume = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    const checkpoint = await snapshot(volume.id);
    const stored = host.checkpoints.read(checkpoint.id);
    expect(stored?.auto).toBe(false);
    // A record with no box is skipped by the automatic retention, which keeps the manual ones anyway.
    const { expiredAutomatic } = await import("../src/checkpoints/policy");
    const farFuture = Date.now() + 3650 * 24 * 60 * 60 * 1000;
    expect(
      expiredAutomatic(
        [stored!],
        { keepLast: 0, keepDays: 1, capacityBytes: 0, trashKeepDays: 7 },
        farFuture,
        new Set(),
      ),
    ).toEqual([]);
  });

  test("a token without checkpoint:create is refused, and one that holds it snapshots the volume", async () => {
    const volume = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    const reader = mint(harness.app, { name: "reader", preset: "readonly" });

    const refusedCall = await call(harness.base, `/api/volumes/${volume.id}/checkpoints`, {
      method: "POST",
      body: {},
      token: reader.secret,
    });
    expect(refusedCall.status).toBe(403);
    expect(refusedCall.json).not.toHaveProperty("taskId");

    const writer = mint(harness.app, {
      name: "snapper",
      preset: "operator",
      scopes: ["box:read", "checkpoint:create", "volume:read"],
      volumes: { type: "all" },
    });
    const checkpoint = await snapshot(volume.id, {}, writer.secret);
    expect(checkpoint).toMatchObject({ boxId: null, createdBy: writer.id });
  });

  test("a token whose volume grant does not cover the volume is refused, so it cannot copy a volume outside its grants", async () => {
    const volume = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    const elsewhere = await createVolume(host, { name: "other", role: null, createdBy: "owner" });
    const narrow = mint(harness.app, {
      name: "narrow",
      preset: "operator",
      scopes: ["box:read", "checkpoint:create", "volume:read"],
      volumes: { type: "list", ids: [elsewhere.id] },
    });

    const reply = await call(harness.base, `/api/volumes/${volume.id}/checkpoints`, {
      method: "POST",
      body: {},
      token: narrow.secret,
    });

    expect(reply).toMatchObject({ status: 403, json: { error: { key: "volume_not_granted" } } });
  });

  test("a token's checkpoint quota is honoured, and the refusal starts no task", async () => {
    const volume = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    const token = mint(harness.app, {
      name: "limited",
      preset: "operator",
      scopes: ["box:read", "checkpoint:create", "volume:read"],
      volumes: { type: "all" },
      quotas: { maxCheckpoints: 1 },
    });

    expect((await snapshot(volume.id, {}, token.secret)).boxId).toBeNull();
    const over: Reply = await call(harness.base, `/api/volumes/${volume.id}/checkpoints`, {
      method: "POST",
      body: {},
      token: token.secret,
    });
    expect(over).toMatchObject({ status: 403, json: { error: { key: "quota_checkpoints" } } });
    expect(over.json).not.toHaveProperty("taskId");
  });

  test("the host disk floor refuses a volume snapshot with 507, before any task starts", async () => {
    const volume = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    harness.runtime.disk = { totalBytes: DISK_TOTAL, freeBytes: 5 * GB };
    await remeasureHostDisk(host);

    const reply = await call(harness.base, `/api/volumes/${volume.id}/checkpoints`, { method: "POST", body: {} });

    expect(reply).toMatchObject({
      status: 507,
      json: { error: { code: "insufficient_storage", key: "host_disk_low" } },
    });
    expect(reply.json).not.toHaveProperty("taskId");
  });

  test("a repository at its capacity limit still takes a volume snapshot, which is a manual checkpoint", async () => {
    const limited = startHarness({ checkpointCapacityMb: 1 });
    limited.app.monitor.snapshot = async () => ROOMY_HOST;
    limited.runtime.disk = { totalBytes: DISK_TOTAL, freeBytes: 40 * GB };
    const limitedHost = limited.app.hosts.get();
    await remeasureHostDisk(limitedHost);
    const limitedVolume = await createVolume(limitedHost, { name: "notes", role: null, createdBy: "owner" });
    limited.checkpoints.reportedBytes = MB;
    try {
      const reply = await call(limited.base, `/api/volumes/${limitedVolume.id}/checkpoints`, {
        method: "POST",
        body: {},
      });
      // The take itself is allowed: a manual checkpoint is what the capacity limit does not refuse. The retention policy
      // then keeps the repository under the limit by removing automatic checkpoints only, so nothing is expired here.
      expect(reply.status).toBe(202);
      expect((await finishedTask(limited.base, reply.json.taskId ?? "")).status).toBe("succeeded");
      expect(limitedHost.checkpoints.list()).toHaveLength(1);
    } finally {
      limited.stop();
    }
  });

  test("an agent host is refused with unsupported, since a backup needs a helper container", async () => {
    const volume = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    // The local host is not an agent, so the refusal is the one the precondition gives: the feature is named.
    host.host.transport = "agent";
    try {
      const reply = await call(harness.base, `/api/volumes/${volume.id}/checkpoints`, { method: "POST", body: {} });
      expect(reply).toMatchObject({
        status: 501,
        json: { error: { code: "unsupported", key: "agent_host_unsupported" } },
      });
    } finally {
      host.host.transport = "local";
    }
  });

  test("the activity feed and the audit event both point at the volume", async () => {
    const volume = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    await snapshot(volume.id);

    expect(harness.app.activity.list().find((entry) => entry.action === "volume.snapshot")).toMatchObject({
      target: "notes",
      ok: true,
    });
    const events = harness.app.events.list({ op: "volume.snapshot" }, { limit: 10 }).events;
    expect(events[0]).toMatchObject({
      op: "volume.snapshot",
      kind: "write",
      status: "ok",
      target: { kind: "volume", id: volume.id, name: "notes" },
    });
  });

  test("a volume snapshot is not exported as a package, and a copy is refused, with a reason rather than a broken package", async () => {
    const volume = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    const checkpoint = await snapshot(volume.id);

    const exported = await call(harness.base, `/api/checkpoints/${checkpoint.id}/export`, {
      method: "POST",
      body: { passphrase: "correct horse battery staple" },
    });
    expect(exported).toMatchObject({ status: 409, json: { error: { key: "checkpoint_export_no_box" } } });

    const addedHost = await call(harness.base, "/api/hosts", {
      method: "POST",
      body: { id: "lab", endpoint: "unix:///var/run/lab.sock" },
    });
    expect(addedHost.status).toBe(201);
    const copied = await call(harness.base, `/api/checkpoints/${checkpoint.id}/copy`, {
      method: "POST",
      body: { host: "lab" },
    });
    expect(copied).toMatchObject({ status: 409, json: { error: { key: "checkpoint_copy_no_box" } } });
  });

  test("a fork of a volume snapshot is refused with its reason, since there are no box settings to make a box from", async () => {
    const volume = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    const checkpoint = await snapshot(volume.id);

    const forked = await call(harness.base, `/api/checkpoints/${checkpoint.id}/fork`, {
      method: "POST",
      body: { name: "from-notes" },
    });

    expect(forked).toMatchObject({ status: 409, json: { error: { key: "checkpoint_no_spec" } } });
  });

  test("the volume record is unchanged by the snapshot, and its own read still works", async () => {
    const volume = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    const before = host.volumes.read(volume.id);
    await snapshot(volume.id);
    expect(host.volumes.read(volume.id)).toEqual(before);
    const read = await getVolume(host, volume.id);
    expect(read).toMatchObject({ id: volume.id, name: "notes", role: null, ownership: "independent" });
  });
});
