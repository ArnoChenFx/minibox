import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import { HELPER_SECRETS_LABEL } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { takeCheckpoint } from "../src/services/checkpoints";
import { reconcileHost } from "../src/services/reconcile";
import { newBoxId } from "../src/specs/revision";
import { provisionDefaultMounts } from "../src/volumes/provision";
import { createTestApp, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";
import type { FakeCheckpointEngine } from "./support/fake-snapshots";

let app: App;
let runtime: FakeRuntime;
let engine: FakeCheckpointEngine;
let host: HostCtx;
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  ({ app, runtime, checkpoints: engine } = createTestApp({ labelPrefix: "mbtest" }));
  host = app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true", [host.keys.templateName]: "base" });
});

afterEach(() => {
  restoreLogs();
});

async function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a call to reach the engine");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** A running box with its default workspace and home, so a checkpoint has volumes to back up. */
async function runningBox(name: string): Promise<boxes.Box> {
  const id = newBoxId();
  const mounts = await provisionDefaultMounts(host, { id, name, createdBy: "owner" }, new Set());
  return boxes.createBox(host, { id, name, cpus: 1, memoryMb: 256, createdBy: "owner", mounts });
}

describe("startup after a checkpoint a crash cut short", () => {
  test("a container left paused is unpaused, and the box keeps running", async () => {
    const box = await runningBox("frozen");
    await runtime.pauseContainer(box.id);
    expect(runtime.containers.get(box.id)?.paused).toBe(true);

    const report = await reconcileHost(host);

    expect(report.unpaused).toEqual([box.boxId]);
    expect(runtime.containers.get(box.id)?.paused).toBe(false);
    expect(report.started).not.toContain(box.boxId);
    expect((await boxes.getBox(host, box.boxId)).running).toBe(true);
  });

  test("a running box that was never paused is left alone", async () => {
    const box = await runningBox("calm");

    const report = await reconcileHost(host);

    expect(report.unpaused).toEqual([]);
    expect(runtime.callsTo("unpauseContainer")).toHaveLength(0);
    expect((await boxes.getBox(host, box.boxId)).running).toBe(true);
  });

  test("a stopped box whose desired state is running is started again", async () => {
    const box = await runningBox("stopped-midway");
    await runtime.stopContainer(box.id, { timeoutSec: 1 });

    const report = await reconcileHost(host);

    expect(report.started).toEqual([box.boxId]);
    expect((await boxes.getBox(host, box.boxId)).running).toBe(true);
  });

  test("a paused box whose desired state is stopped is unpaused and then stopped", async () => {
    const box = await runningBox("paused-then-stopped");
    await boxes.stopBox(host, box.boxId);
    await runtime.startContainer(box.id);
    await runtime.pauseContainer(box.id);

    const report = await reconcileHost(host);

    expect(report.unpaused).toEqual([box.boxId]);
    expect(report.stopped).toEqual([box.boxId]);
    expect((await boxes.getBox(host, box.boxId)).running).toBe(false);
  });
});

describe("startup does not wake a box that was put to sleep on purpose", () => {
  for (const reason of ["idle", "ttl"] as const) {
    test(`a box slept for ${reason} stays stopped`, async () => {
      const box = await runningBox(`slept-${reason}`);
      expect(await boxes.sleepBox(host, box.boxId, reason)).toBe(true);

      const report = await reconcileHost(host);

      expect(report.started).not.toContain(box.boxId);
      expect(await boxes.getBox(host, box.boxId)).toMatchObject({
        running: false,
        desired: "stopped",
        stopReason: reason,
      });
    });
  }
});

describe("startup removes helper secret volumes a crash left behind", () => {
  test("only this instance's staged secret volumes are removed", async () => {
    await runtime.createVolume("mbhsecstale", { [host.keys.internal]: "true", [HELPER_SECRETS_LABEL]: "true" });
    await runtime.createVolume("mbhsecother", { "other.internal": "true", [HELPER_SECRETS_LABEL]: "true" });
    await runtime.createVolume("plain-internal", { [host.keys.internal]: "true" });

    const report = await reconcileHost(host);

    expect(report.secretsRemoved).toEqual(["mbhsecstale"]);
    expect(runtime.volumes.has("mbhsecstale")).toBe(false);
    expect(runtime.volumes.has("mbhsecother")).toBe(true);
    expect(runtime.volumes.has("plain-internal")).toBe(true);
  });
});

describe("a stop checkpoint leaves the box's desired state alone", () => {
  test("while the backup runs, and after it, the box is running with the same desired state and revision", async () => {
    const box = await runningBox("stop-me");
    const before = host.specs.read(box.boxId);
    const gate = engine.hold();

    const taking = takeCheckpoint(
      host,
      box.boxId,
      { pinned: false, include: { system: false, volumes: [] }, consistency: "stop" },
      "owner",
    );
    await waitFor(() => engine.started > 0);
    expect((await boxes.getBox(host, box.boxId)).running).toBe(false);
    expect(host.specs.read(box.boxId)?.lifecycle).toEqual(before?.lifecycle);

    gate.release();
    await taking;

    const after = host.specs.read(box.boxId);
    expect((await boxes.getBox(host, box.boxId)).running).toBe(true);
    expect(after?.lifecycle).toEqual(before?.lifecycle);
    expect(after?.revision).toBe(before?.revision);
  });

  test("a failed backup still starts the box again, and never records it as stopped by a person", async () => {
    const box = await runningBox("unlucky");
    for (const mount of host.specs.read(box.boxId)?.mounts ?? []) engine.failBackupOf.add(mount.volume);
    const before = host.specs.read(box.boxId);

    await takeCheckpoint(
      host,
      box.boxId,
      { pinned: false, include: { system: false, volumes: [] }, consistency: "stop" },
      "owner",
    ).catch(() => undefined);

    expect((await boxes.getBox(host, box.boxId)).running).toBe(true);
    expect(host.specs.read(box.boxId)?.lifecycle).toEqual(before?.lifecycle);
  });
});
