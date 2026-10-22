/**
 * Takes checkpoints of a box on a real engine and restores them. A fork and an in-place rollback must each give back the
 * /workspace the checkpoint saw: the same paths, modes, owners and bytes. The snapshots go through the restic helper, so
 * this also covers the checkpoint repository volume and the password it is opened with. The same engine backs the
 * repository limit, retention, the confirm and undo of a rollback, and startup recovery of a paused box.
 *
 *   bun run test:docker
 *
 * That script (scripts/docker-integration.ts) pulls the images, picks a fresh label prefix and sweeps what the run left
 * behind. To run this file directly: MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbit<id> bun test tests/docker-checkpoint.test.ts
 *
 * Optional: DOCKER_SOCKET (default /var/run/docker.sock) and MINIBOX_TEST_IMAGE (default alpine:3.20). The image must
 * already be present locally. It is also the base template, so the ownership helpers run from it. The prefix must start
 * with "mbit", so the cleanup can never touch a real MiniBox install.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Docker from "dockerode";

import type { CheckpointPolicy } from "../src/checkpoints/policy";
import { readSecretFile } from "../src/data-dir";
import { createDockerRuntime } from "../src/docker/runtime";
import { createLocalHost, type HostCtx } from "../src/host/registry";
import { HELPER_SECRETS_DIR, isRuntimeError, type Runtime } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { usageOf } from "../src/services/checkpoint-capacity";
import { applyRetention } from "../src/services/checkpoint-retention";
import { forkCheckpoint, rollbackBox, takeCheckpoint } from "../src/services/checkpoints";
import { reconcileHost } from "../src/services/reconcile";
import { confirmRollback, undoRollback } from "../src/services/rollback";
import { rejectionOf, silenceLogs, testConfig } from "./support/app";

const enabled = process.env.MINIBOX_TEST_DOCKER === "1";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const IMAGE = process.env.MINIBOX_TEST_IMAGE ?? "alpine:3.20";
const LONG = 120_000;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const PREFIX_PATTERN = /^mbit[a-z0-9-]{3,40}$/;
const prefix = process.env.MINIBOX_TEST_PREFIX ?? `mbit${Date.now().toString(36)}`;
if (enabled && !PREFIX_PATTERN.test(prefix)) throw new Error(`MINIBOX_TEST_PREFIX must match ${PREFIX_PATTERN}`);
const runtime: Runtime = createDockerRuntime(SOCKET);
const docker = new Docker({ socketPath: SOCKET });

/** A nested directory, a binary file, an empty file, and a file with an owner and mode other than the defaults. */
const SEED = [
  "mkdir -p /workspace/src/lib /workspace/empty",
  "echo 'hello from the checkpoint' > /workspace/notes.txt",
  "echo 'export const answer = 42' > /workspace/src/lib/answer.ts",
  "head -c 262144 /dev/urandom > /workspace/blob.bin",
  "chown 1234:4321 /workspace/src/lib/answer.ts",
  "chmod 750 /workspace/src/lib/answer.ts",
].join(" && ");

/** Changes made after the checkpoint: a file edited, a binary overwritten, a tree removed, and a new file added. */
const DRIFT = [
  "rm -rf /workspace/src",
  "echo 'changed after the checkpoint' > /workspace/notes.txt",
  "head -c 1024 /dev/zero > /workspace/blob.bin",
  "echo 'new after the checkpoint' > /workspace/extra.txt",
].join(" && ");

/** Every path under /workspace with its mode and owner, then a checksum for each file. */
const MANIFEST =
  "cd /workspace && { find . -exec stat -c '%a %u:%g %n' {} \\; | sort; find . -type f -exec sha256sum {} \\; | sort; }";

async function waitUntil(check: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

/** Runs a shell snippet inside a box and returns what it printed, trimmed. */
async function shell(id: string, script: string): Promise<string> {
  const exec = await runtime.startExec(id, {
    cmd: ["sh", "-c", `${script}; echo MB_DONE`],
    env: ["TERM=dumb"],
    workingDir: "/",
  });
  let text = "";
  exec.stream.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  try {
    await waitUntil(async () => text.includes("MB_DONE"), "the command output");
  } finally {
    exec.stream.destroy();
  }
  return text.slice(0, text.indexOf("MB_DONE")).replace(/\r/g, "").trim();
}

const manifestOf = (id: string) => shell(id, MANIFEST);

/** The same host with some checkpoint limits changed. The stores and the engine are shared, so both see one repository. */
function withPolicy(ctx: HostCtx, policy: Partial<CheckpointPolicy>): HostCtx {
  return { ...ctx, checkpointPolicy: { ...ctx.checkpointPolicy, ...policy } };
}

async function volumeExists(name: string): Promise<boolean> {
  try {
    await runtime.inspectVolume(name);
    return true;
  } catch (e) {
    if (isRuntimeError(e, "not_found")) return false;
    throw e;
  }
}

/**
 * The first restic backup helper the engine shows as running while `until` is pending, read back in full. A helper runs
 * as long as its backup reads, so a large backup leaves a window to see it in.
 */
async function backupHelperWhile(
  until: Promise<unknown>,
  internalLabel: string,
): Promise<Docker.ContainerInspectInfo | null> {
  const settled = until.then(
    () => true,
    () => true,
  );
  for (;;) {
    for (const info of await runtime.listContainers({ labels: { [internalLabel]: "true" } })) {
      if (!info.running) continue;
      const inspected = await docker
        .getContainer(info.id)
        .inspect()
        .catch(() => null);
      if (inspected?.Config.Cmd?.includes("backup")) return inspected;
    }
    if (await Promise.race([settled, Bun.sleep(25).then(() => false)])) return null;
  }
}

/** Removes what the tests left behind: containers first, so that the volumes they mount can go, then the network. */
async function removeLeftovers(host: HostCtx): Promise<void> {
  for (const c of await runtime.listContainers({ labels: { [prefix]: "true" } })) {
    await runtime.removeContainer(c.id, { force: true }).catch(() => {});
  }
  const { Volumes } = await docker.listVolumes();
  for (const volume of Volumes ?? []) {
    if (volume.Labels?.[prefix] === "true" || volume.Name.startsWith(`${prefix}-`)) {
      await docker
        .getVolume(volume.Name)
        .remove()
        .catch(() => {});
    }
  }
  await docker
    .getNetwork(host.security.network)
    .remove()
    .catch(() => {});
}

describe.skipIf(!enabled)("checkpoints against a real engine", () => {
  let dataDir = "";
  let host: HostCtx;
  let restoreLogs: () => void;

  const takeOf = (boxId: string, consistency: "live" | "pause", ctx: HostCtx = host) =>
    takeCheckpoint(ctx, boxId, { pinned: false, include: { system: false, volumes: [] }, consistency }, "tester");

  const createSource = (name: string) =>
    boxes.createBox(host, { name, image: IMAGE, cpus: 0.5, memoryMb: 64, createdBy: "tester" });

  const forkOf = (checkpointId: string, name: string) =>
    forkCheckpoint(host, checkpointId, { name, cpus: 0.5, memoryMb: 64, copyHome: false }, "tester");

  /** Rolls a box back to one of its checkpoints, at the box's current revision, with the confirmation given. */
  async function rollbackTo(boxId: string, checkpointId: string, ctx: HostCtx = host) {
    const current = await boxes.getBox(ctx, boxId);
    return rollbackBox(ctx, boxId, { checkpoint: checkpointId, confirm: true, revision: current.revision }, "tester");
  }

  beforeAll(() => {
    restoreLogs = silenceLogs();
    dataDir = mkdtempSync(join(tmpdir(), "minibox-checkpoint-docker-"));
    host = createLocalHost(
      testConfig({ labelPrefix: prefix, dockerSocket: SOCKET, baseTemplateTag: IMAGE, dataDir }),
      runtime,
    );
  });

  afterAll(async () => {
    await removeLeftovers(host);
    restoreLogs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test(
    "usage counts the repository, and a full repository refuses automatic checkpoints but not manual ones",
    async () => {
      expect(await usageOf(host)).toMatchObject({ bytes: 0, limitBytes: null, state: "unlimited" });

      const source = await createSource("usage-src");
      await shell(source.id, `${SEED} && head -c ${2 * MIB} /dev/urandom > /workspace/random.bin`);
      const checkpoint = await takeOf(source.boxId, "live");
      expect((await usageOf(host)).bytes).toBeGreaterThanOrEqual(2 * MIB);

      const full = withPolicy(host, { capacityBytes: MIB });
      expect(await usageOf(full)).toMatchObject({ limitBytes: MIB, state: "exceeded" });

      await shell(source.id, "echo changed > /workspace/notes.txt");
      const changed = await manifestOf(source.id);
      const refused = await rejectionOf(rollbackTo(source.boxId, checkpoint.id, full));
      expect(refused).toMatchObject({ status: 409, key: "checkpoint_capacity_exceeded" });
      expect(host.checkpoints.pendingRollback(source.boxId)).toBeNull();
      expect(await manifestOf(source.id)).toBe(changed);

      const manual = await takeOf(source.boxId, "live", full);
      expect(manual).toMatchObject({ auto: false, boxId: source.boxId });
    },
    LONG,
  );

  test(
    "a fork starts with the /workspace the checkpoint took, and the source box is left alone",
    async () => {
      const source = await boxes.createBox(host, {
        name: "fork-src",
        image: IMAGE,
        cpus: 0.5,
        memoryMb: 64,
        createdBy: "tester",
      });
      await shell(source.id, SEED);
      const before = await manifestOf(source.id);
      expect(before).toContain("./src/lib/answer.ts");

      const checkpoint = await takeOf(source.boxId, "pause");
      expect(checkpoint).toMatchObject({ consistency: "pause", system: null });
      expect(checkpoint.data.map((layer) => layer.role).toSorted()).toEqual(["home", "workspace"]);
      expect(checkpoint.bytes).toBeGreaterThanOrEqual(262_144);
      expect((await boxes.getBox(host, source.boxId)).running).toBe(true);
      expect(await manifestOf(source.id)).toBe(before);

      const forked = await forkCheckpoint(
        host,
        checkpoint.id,
        { name: "fork-copy", cpus: 0.5, memoryMb: 64, copyHome: false },
        "tester",
      );
      expect(forked).toMatchObject({ name: "fork-copy", running: true });
      expect(forked.volume).not.toBe(source.volume);
      expect(await manifestOf(forked.id)).toBe(before);

      await shell(forked.id, "echo only-in-the-fork > /workspace/fork-only.txt");
      expect(await manifestOf(source.id)).toBe(before);
    },
    LONG,
  );

  test(
    "a rollback puts the checkpoint's /workspace back, keeps the volumes it replaced, and the checkpoint still forks",
    async () => {
      const source = await boxes.createBox(host, {
        name: "roll-src",
        image: IMAGE,
        cpus: 0.5,
        memoryMb: 64,
        createdBy: "tester",
      });
      await shell(source.id, SEED);
      const before = await manifestOf(source.id);
      const checkpoint = await takeOf(source.boxId, "live");

      await shell(source.id, DRIFT);
      expect(await manifestOf(source.id)).not.toBe(before);

      const current = await boxes.getBox(host, source.boxId);
      const result = await rollbackBox(
        host,
        source.boxId,
        { checkpoint: checkpoint.id, confirm: true, revision: current.revision },
        "tester",
      );
      expect(result.box).toMatchObject({ boxId: source.boxId, running: true });
      expect(result.box.volume).not.toBe(source.volume);
      expect(result.replaced.map((volume) => volume.name).toSorted()).toEqual(["roll-src-home", "roll-src-workspace"]);
      expect(await manifestOf(result.box.id)).toBe(before);
      for (const volume of result.replaced) {
        expect((await runtime.inspectVolume(volume.id)).name).toBe(volume.id);
      }

      const forked = await forkCheckpoint(
        host,
        checkpoint.id,
        { name: "roll-copy", cpus: 0.5, memoryMb: 64, copyHome: false },
        "tester",
      );
      expect(await manifestOf(forked.id)).toBe(before);
    },
    LONG,
  );

  test(
    "a stop checkpoint stops the box for the backup, then starts it again with its files unchanged",
    async () => {
      const source = await boxes.createBox(host, {
        name: "stop-src",
        image: IMAGE,
        cpus: 0.5,
        memoryMb: 64,
        createdBy: "tester",
      });
      await shell(source.id, SEED);
      const before = await manifestOf(source.id);

      const steps: string[] = [];
      const checkpoint = await takeCheckpoint(
        host,
        source.boxId,
        { pinned: false, include: { system: false, volumes: [] }, consistency: "stop" },
        "tester",
        { log: (text) => steps.push(text) },
      );
      expect(checkpoint.consistency).toBe("stop");
      expect(steps.join("")).toMatch(/Stopping the box[\s\S]*Starting the box again/);
      expect((await boxes.getBox(host, source.boxId)).running).toBe(true);
      expect(await manifestOf(source.id)).toBe(before);
    },
    LONG,
  );

  test(
    "retention removes the automatic checkpoints the policy no longer keeps, and frees their repository space",
    async () => {
      const source = await createSource("retain-src");
      await shell(source.id, SEED);
      const seeded = await manifestOf(source.id);
      const kept = await takeOf(source.boxId, "live");

      await shell(source.id, `head -c ${MIB} /dev/urandom > /workspace/first.bin`);
      const first = await rollbackTo(source.boxId, kept.id);
      await confirmRollback(host, source.boxId);

      await shell(first.box.id, `head -c ${MIB} /dev/urandom > /workspace/second.bin`);
      const second = await rollbackTo(source.boxId, kept.id);
      await confirmRollback(host, source.boxId);

      const before = (await usageOf(host)).bytes;
      const removed = await applyRetention(withPolicy(host, { keepLast: 1 }));
      expect(removed).toEqual([first.safety.id]);
      expect(host.checkpoints.read(first.safety.id)).toBeNull();
      expect(host.checkpoints.read(second.safety.id)).not.toBeNull();
      expect(host.checkpoints.read(kept.id)).not.toBeNull();
      expect(before - (await usageOf(host)).bytes).toBeGreaterThanOrEqual(MIB / 2);

      const forked = await forkOf(kept.id, "retain-copy");
      expect(await manifestOf(forked.id)).toBe(seeded);
    },
    LONG,
  );

  test(
    "confirming a rollback deletes the volumes it replaced, and the checkpoint still forks",
    async () => {
      const source = await createSource("confirm-src");
      await shell(source.id, SEED);
      const before = await manifestOf(source.id);
      const checkpoint = await takeOf(source.boxId, "live");
      await shell(source.id, DRIFT);

      const result = await rollbackTo(source.boxId, checkpoint.id);
      const replaced = host.checkpoints.pendingRollback(source.boxId)?.replaced ?? [];
      expect(replaced.map((volume) => volume.name).toSorted()).toEqual(["confirm-src-home", "confirm-src-workspace"]);
      for (const volume of replaced) expect(await volumeExists(volume.engineName)).toBe(true);

      const confirmed = await confirmRollback(host, source.boxId);
      expect(confirmed.removed.map((volume) => volume.name).toSorted()).toEqual([
        "confirm-src-home",
        "confirm-src-workspace",
      ]);
      for (const volume of replaced) expect(await volumeExists(volume.engineName)).toBe(false);
      expect(host.checkpoints.pendingRollback(source.boxId)).toBeNull();
      expect(await manifestOf(result.box.id)).toBe(before);

      const forked = await forkOf(checkpoint.id, "confirm-copy");
      expect(await manifestOf(forked.id)).toBe(before);
    },
    LONG,
  );

  test(
    "undoing a rollback mounts the replaced volumes again, and deletes the volumes the rollback restored",
    async () => {
      const source = await createSource("undo-src");
      await shell(source.id, SEED);
      const checkpoint = await takeOf(source.boxId, "live");
      await shell(source.id, DRIFT);
      const drifted = await manifestOf(source.id);

      await rollbackTo(source.boxId, checkpoint.id);
      const pending = host.checkpoints.pendingRollback(source.boxId);
      const replaced = pending?.replaced ?? [];
      const restored = pending?.restored ?? [];
      expect(replaced.map((volume) => volume.name).toSorted()).toEqual(["undo-src-home", "undo-src-workspace"]);
      expect(restored.map((volume) => volume.name).toSorted()).toEqual([
        "undo-src-home-local",
        "undo-src-workspace-local",
      ]);
      for (const volume of restored) expect(await volumeExists(volume.engineName)).toBe(true);

      const current = await boxes.getBox(host, source.boxId);
      const undone = await undoRollback(host, source.boxId, { revision: current.revision });
      expect(undone).toMatchObject({ boxId: source.boxId, running: true, volume: source.volume });
      expect(await manifestOf(undone.id)).toBe(drifted);
      for (const volume of replaced) expect(await volumeExists(volume.engineName)).toBe(true);
      for (const volume of restored) expect(await volumeExists(volume.engineName)).toBe(false);
      expect(host.checkpoints.pendingRollback(source.boxId)).toBeNull();
    },
    LONG,
  );

  test(
    "startup recovery unpauses a box a crash left paused, and starts a box stopped while it should run",
    async () => {
      const paused = await createSource("pause-src");
      const stopped = await createSource("halt-src");
      await shell(paused.id, SEED);
      const before = await manifestOf(paused.id);

      await runtime.pauseContainer(paused.id);
      await runtime.stopContainer(stopped.id, { timeoutSec: 3 });
      expect((await runtime.inspectContainer(paused.id)).state).toBe("paused");

      const report = await reconcileHost(host);
      expect(report.failed).toEqual([]);
      expect(report.unpaused).toContain(paused.boxId);
      expect(report.started).toContain(stopped.boxId);
      expect((await runtime.inspectContainer(paused.id)).state).toBe("running");
      expect(await manifestOf(paused.id)).toBe(before);
      expect((await boxes.getBox(host, stopped.boxId)).running).toBe(true);
    },
    LONG,
  );

  test(
    "the restic helper reads the repository password from a secret file, and the password is not in its environment",
    async () => {
      const source = await createSource("secret-src");
      await shell(source.id, `truncate -s ${2 * GIB} /workspace/big.bin && echo sized`);

      const backup = takeOf(source.boxId, "live");
      const helper = await backupHelperWhile(backup, host.keys.internal);
      const checkpoint = await backup;
      expect(helper).not.toBeNull();

      const password = readSecretFile(join(dataDir, "secrets", "checkpoint-repo.key")) ?? "";
      expect(password).toMatch(/^[0-9a-f]{64}$/);
      const env = helper?.Config.Env ?? [];
      expect(env).toContain(`RESTIC_PASSWORD_FILE=${HELPER_SECRETS_DIR}/repo.key`);
      expect(env.some((entry) => entry.startsWith("RESTIC_PASSWORD="))).toBe(false);
      expect(JSON.stringify(helper)).not.toContain(password);
      expect(helper?.Mounts.find((mount) => mount.Destination === HELPER_SECRETS_DIR)).toMatchObject({
        Type: "volume",
        RW: false,
      });

      expect(checkpoint.data.find((layer) => layer.role === "workspace")?.bytes).toBeGreaterThanOrEqual(2 * GIB);
    },
    LONG,
  );
});
