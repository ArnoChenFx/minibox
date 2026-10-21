import { beforeEach, describe, expect, test } from "bun:test";

import type { AuditNote } from "../src/events/types";
import type { HostCtx } from "../src/host/registry";
import { RuntimeError, type VolumeOwner } from "../src/runtime";
import {
  alignVolumeRoot,
  restoreVolumeRoot,
  type WorkspaceRoot,
  writableWorkspaceVolume,
} from "../src/services/volume-owner";
import { createTestApp, rejectionOf } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

const ROOT: VolumeOwner = { uid: 0, gid: 0 };
const DEV: VolumeOwner = { uid: 1000, gid: 1000 };
const devLabels = { "minibox.template.uid": "1000", "minibox.template.gid": "1000" };

let runtime: FakeRuntime;
let host: HostCtx;
let notes: AuditNote[];
const record = (note: AuditNote) => {
  notes.push(note);
};

beforeEach(() => {
  const created = createTestApp({ labelPrefix: "mbtest" });
  runtime = created.runtime;
  host = created.app.hosts.get();
  notes = [];
});

/** A container that mounts `volume` at /workspace, on a volume whose root has `owner`, from an image with `labels`. */
async function workspaceRoot(
  volume: string,
  owner: VolumeOwner,
  labels: Record<string, string>,
): Promise<WorkspaceRoot> {
  const ref = `${volume}-template:1`;
  const image = runtime.seedImage(ref, labels);
  await runtime.createVolume(volume, {});
  runtime.seedVolumeOwner(volume, owner);
  const containerId = runtime.seedContainer({
    image: ref,
    name: `mbtest-${volume}`,
    mounts: [{ source: volume, target: "/workspace" }],
  });
  return { containerId, volume, image, labels };
}

describe("writableWorkspaceVolume", () => {
  test("names the volume mounted writable at /workspace, and no other mount", () => {
    expect(writableWorkspaceVolume([{ volume: "ws", path: "/workspace", mode: "rw" }])).toBe("ws");
    expect(writableWorkspaceVolume([{ volume: "data", path: "/data", mode: "rw" }])).toBeNull();
    expect(writableWorkspaceVolume([{ volume: "ws", path: "/workspace", mode: "ro" }])).toBeNull();
    expect(writableWorkspaceVolume([])).toBeNull();
  });
});

describe("alignVolumeRoot", () => {
  test("a template that names no owner is left alone without any engine read", async () => {
    const root = await workspaceRoot("ws", ROOT, {});

    expect(await alignVolumeRoot(host, root, record)).toBeNull();
    expect(runtime.callsTo("volumeRootOwner")).toHaveLength(0);
    expect(runtime.callsTo("setVolumeRootOwner")).toHaveLength(0);
    expect(notes).toEqual([]);
  });

  test("a root that already has the template's owner is left alone", async () => {
    const root = await workspaceRoot("ws", DEV, devLabels);

    expect(await alignVolumeRoot(host, root, record)).toBeNull();
    expect(runtime.callsTo("volumeRootOwner").map((call) => call.args)).toEqual([[root.containerId, "/workspace"]]);
    expect(runtime.callsTo("setVolumeRootOwner")).toHaveLength(0);
    expect(notes).toEqual([]);
  });

  test("a root owned by another user is set to the template's owner, and the owner it had is returned", async () => {
    const root = await workspaceRoot("ws", ROOT, devLabels);

    expect(await alignVolumeRoot(host, root, record)).toEqual(ROOT);
    expect(runtime.callsTo("setVolumeRootOwner").map((call) => call.args)).toEqual([["ws", DEV, root.image]]);
    expect(await runtime.volumeRootOwner(root.containerId, "/workspace")).toEqual(DEV);
    expect(notes).toEqual([
      {
        op: "volume.chown",
        kind: "write",
        status: "ok",
        summary: "Volume owner set: ws",
        target: { kind: "volume", name: "ws" },
        detail: { from: "0:0", to: "1000:1000" },
      },
    ]);
  });

  test("a failed change is recorded with the engine's error and the original error is rethrown", async () => {
    const root = await workspaceRoot("ws", ROOT, devLabels);
    const failure = new RuntimeError("engine", "helper exited 1", "helper exited 1");
    runtime.fail("setVolumeRootOwner", failure);

    expect(await rejectionOf(alignVolumeRoot(host, root, record))).toBe(failure);
    expect(await runtime.volumeRootOwner(root.containerId, "/workspace")).toEqual(ROOT);
    expect(notes).toEqual([
      {
        op: "volume.chown",
        kind: "write",
        status: "error",
        summary: "Volume owner change failed: ws",
        target: { kind: "volume", name: "ws" },
        detail: { from: "0:0", to: "1000:1000" },
        error: { code: "docker_error", status: 502 },
      },
    ]);
  });
});

describe("restoreVolumeRoot", () => {
  test("puts the owner back through the given image and records the undo", async () => {
    const root = await workspaceRoot("ws", ROOT, devLabels);
    await alignVolumeRoot(host, root);

    await restoreVolumeRoot(host, { volume: "ws", owner: ROOT, image: root.image }, record);

    expect(runtime.callsTo("setVolumeRootOwner").map((call) => call.args)).toEqual([
      ["ws", DEV, root.image],
      ["ws", ROOT, root.image],
    ]);
    expect(await runtime.volumeRootOwner(root.containerId, "/workspace")).toEqual(ROOT);
    expect(notes).toEqual([
      {
        op: "volume.chown_undo",
        kind: "write",
        status: "ok",
        summary: "Volume owner restored: ws",
        target: { kind: "volume", name: "ws" },
        detail: { to: "0:0" },
      },
    ]);
  });

  test("a failed restore is recorded and the original error is rethrown", async () => {
    const root = await workspaceRoot("ws", DEV, devLabels);
    const failure = new RuntimeError("engine", "helper exited 1", "helper exited 1");
    runtime.fail("setVolumeRootOwner", failure);

    expect(await rejectionOf(restoreVolumeRoot(host, { volume: "ws", owner: ROOT, image: root.image }, record))).toBe(
      failure,
    );
    expect(notes).toEqual([
      {
        op: "volume.chown_undo",
        kind: "write",
        status: "error",
        summary: "Volume owner restore failed: ws",
        target: { kind: "volume", name: "ws" },
        detail: { to: "0:0" },
        error: { code: "docker_error", status: 502 },
      },
    ]);
  });
});
