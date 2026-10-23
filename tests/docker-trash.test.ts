/**
 * Keeps deleted boxes and volumes in the recycle bin on a real engine, then restores and purges them. A restored box must
 * hold the files the deleted one had, with the same paths, modes, owners and bytes, and a restored volume the same bytes.
 * The same engine backs the capacity purge, the retention sweep and the safety checkpoint a rebuild takes, which pauses
 * a running box for its copy and must leave it running.
 *
 *   bun run test:docker
 *
 * That script (scripts/docker-integration.ts) pulls the images, picks a fresh label prefix and sweeps what the run left
 * behind. To run this file directly: MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbit<id> bun test tests/docker-trash.test.ts
 *
 * Optional: DOCKER_SOCKET (default /var/run/docker.sock) and MINIBOX_TEST_IMAGE (default alpine:3.20). The image must
 * already be present locally. It is also the base template. The prefix must start with "mbit", so the cleanup can never
 * touch a real MiniBox install.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Docker from "dockerode";

import type { CheckpointPolicy } from "../src/checkpoints/policy";
import { createDockerRuntime } from "../src/docker/runtime";
import { createLocalHost, type HostCtx } from "../src/host/registry";
import { isRuntimeError, type Runtime } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { usageOf } from "../src/services/checkpoint-capacity";
import { applyRetention } from "../src/services/checkpoint-retention";
import { forkCheckpoint } from "../src/services/checkpoints";
import { rebuildWithSafety } from "../src/services/rebuild";
import { preRebuildSafety } from "../src/services/safety";
import { deleteBoxToTrash, listTrash, purgeEntry, restoreTrash } from "../src/services/trash";
import { createVolume, deleteVolume } from "../src/services/volumes";
import { DEV_OWNER } from "../src/volumes/types";
import { silenceLogs, testConfig } from "./support/app";

const enabled = process.env.MINIBOX_TEST_DOCKER === "1";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const IMAGE = process.env.MINIBOX_TEST_IMAGE ?? "alpine:3.20";
const LONG = 120_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIB = 1024 * 1024;

const PREFIX_PATTERN = /^mbit[a-z0-9-]{3,40}$/;
const prefix = process.env.MINIBOX_TEST_PREFIX ?? `mbit${Date.now().toString(36)}`;
if (enabled && !PREFIX_PATTERN.test(prefix)) throw new Error(`MINIBOX_TEST_PREFIX must match ${PREFIX_PATTERN}`);
const runtime: Runtime = createDockerRuntime(SOCKET);
const docker = new Docker({ socketPath: SOCKET });

/** A nested directory, a file with an owner and mode other than the defaults, and an empty directory. */
const SEED = [
  "mkdir -p /workspace/src/lib /workspace/empty",
  "echo 'hello from the recycle bin' > /workspace/notes.txt",
  "echo 'export const answer = 42' > /workspace/src/lib/answer.ts",
  "head -c 262144 /dev/urandom > /workspace/blob.bin",
  "chown 1234:4321 /workspace/src/lib/answer.ts",
  "chmod 750 /workspace/src/lib/answer.ts",
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

/**
 * Runs a snippet in a helper that mounts an engine volume, as the owner a new volume's root is given. A helper that
 * keeps only its default capabilities cannot write to that root as root, so the snippet runs as the owner instead.
 */
async function helper(host: HostCtx, volume: string, mode: "ro" | "rw", script: string): Promise<string> {
  const result = await runtime.runHelper({
    image: IMAGE,
    user: DEV_OWNER,
    cmd: ["sh", "-c", script],
    mounts: [{ source: volume, target: "/mnt", mode }],
    timeoutSec: 120,
    labels: { [host.keys.internal]: "true" },
  });
  if (result.exitCode !== 0) throw new Error(`helper failed: ${result.logs}`);
  return result.logs.trim();
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

/** The same host with some checkpoint limits changed. The stores and the engine are shared, so both see one repository. */
function withPolicy(ctx: HostCtx, policy: Partial<CheckpointPolicy>): HostCtx {
  return { ...ctx, checkpointPolicy: { ...ctx.checkpointPolicy, ...policy } };
}

/** Removes what the tests left behind: containers first, so that the volumes they mount can go, then the network. */
async function removeLeftovers(host: HostCtx): Promise<void> {
  for (const c of await runtime.listContainers({ labels: { [host.prefix]: "true" } })) {
    await runtime.removeContainer(c.id, { force: true }).catch(() => {});
  }
  const { Volumes } = await docker.listVolumes();
  for (const volume of Volumes ?? []) {
    if (volume.Labels?.[host.prefix] === "true" || volume.Name.startsWith(`${host.prefix}-`)) {
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

describe.skipIf(!enabled)("the recycle bin against a real engine", () => {
  let dataDir = "";
  let host: HostCtx;
  let restoreLogs: () => void;

  beforeAll(() => {
    restoreLogs = silenceLogs();
    dataDir = mkdtempSync(join(tmpdir(), "minibox-trash-docker-"));
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

  const createSource = (name: string) =>
    boxes.createBox(host, { name, image: IMAGE, cpus: 0.5, memoryMb: 64, createdBy: "tester" });

  test(
    "a deleted box keeps its files, and restoring the entry gives a running box with the same files",
    async () => {
      const source = await createSource("trash-src");
      await shell(source.id, SEED);
      const before = await manifestOf(source.id);

      const deleted = await deleteBoxToTrash(host, source.boxId, true, { skipTrash: false, createdBy: "tester" });

      expect(deleted).toMatchObject({ name: "trash-src", volumeDeleted: true });
      expect(deleted.trash?.id).toMatch(/^ck_/);
      expect(await volumeExists(source.volume)).toBe(false);
      const [entry] = await listTrash(host);
      expect(entry).toMatchObject({ id: deleted.trash?.id, kind: "box", sourceName: "trash-src" });

      const restored = await restoreTrash(host, entry?.id ?? "", { name: "trash-back" }, "tester");

      expect(restored.box).toMatchObject({ name: "trash-back", running: true });
      expect(await manifestOf(restored.box?.id ?? "")).toBe(before);
      expect(await listTrash(host)).toEqual([]);
    },
    LONG,
  );

  test(
    "a deleted volume keeps its bytes, and restoring it gives a new volume that reads the same",
    async () => {
      const volume = await createVolume(host, { name: "notes-real", role: null, createdBy: "tester" });
      await helper(host, volume.engineName, "rw", "echo kept in the bin > /mnt/todo.txt");

      const deleted = await deleteVolume(host, volume.id, { createdBy: "tester" });

      expect(deleted.trash?.id).toMatch(/^ck_/);
      expect(await volumeExists(volume.engineName)).toBe(false);
      const [entry] = await listTrash(host);
      expect(entry).toMatchObject({ kind: "volume", sourceName: "notes-real" });

      const restored = await restoreTrash(host, entry?.id ?? "", { name: "notes-back" }, "tester");

      expect(restored.volume?.name).toBe("notes-back");
      expect(await helper(host, restored.volume?.engineName ?? "", "ro", "cat /mnt/todo.txt")).toBe("kept in the bin");
      expect(await listTrash(host)).toEqual([]);
    },
    LONG,
  );

  test(
    "purging an entry frees its repository bytes, and the retention sweep removes an entry once its retention has ended",
    async () => {
      const source = await createSource("purge-src");
      await shell(source.id, `${SEED} && head -c ${2 * MIB} /dev/urandom > /workspace/extra.bin`);
      const deleted = await deleteBoxToTrash(host, source.boxId, true, { skipTrash: false, createdBy: "tester" });
      const held = (await usageOf(host)).bytes;
      expect(held).toBeGreaterThanOrEqual(2 * MIB);

      await purgeEntry(host, deleted.trash?.id ?? "", "requested");

      expect(await listTrash(host)).toEqual([]);
      expect((await usageOf(host)).bytes).toBeLessThan(held);

      const next = await createSource("expiry-src");
      await shell(next.id, SEED);
      const kept = await deleteBoxToTrash(host, next.boxId, true, { skipTrash: false, createdBy: "tester" });
      const keptId = kept.trash?.id ?? "";
      expect(keptId).toMatch(/^ck_/);
      expect(await applyRetention(host, Date.now() + DAY_MS)).toEqual([]);
      expect(await listTrash(host)).toHaveLength(1);
      expect(await applyRetention(host, Date.now() + 8 * DAY_MS)).toEqual([keptId]);
      expect(await listTrash(host)).toEqual([]);
    },
    LONG,
  );

  test(
    "a delete that would pass the repository limit purges the oldest entry first, then keeps the new one",
    async () => {
      const first = await createSource("cap-first");
      await shell(first.id, `head -c ${2 * MIB} /dev/urandom > /workspace/big.bin`);
      await deleteBoxToTrash(host, first.boxId, true, { skipTrash: false, createdBy: "tester" });
      const limited = withPolicy(host, { capacityBytes: 3 * MIB });

      const second = await createSource("cap-second");
      await shell(second.id, `head -c ${2 * MIB} /dev/urandom > /workspace/big.bin`);
      const deleted = await deleteBoxToTrash(limited, second.boxId, true, { skipTrash: false, createdBy: "tester" });

      expect(deleted.trash).not.toBeNull();
      expect((await listTrash(host)).map((entry) => entry.sourceName)).toEqual(["cap-second"]);
      expect((await usageOf(limited)).bytes).toBeLessThanOrEqual(3 * MIB);
      await purgeEntry(host, deleted.trash?.id ?? "", "requested");
    },
    LONG,
  );

  test(
    "a rebuild takes a safety checkpoint of a running box, which keeps its files and forks back to them",
    async () => {
      const source = await createSource("rebuild-src");
      await shell(source.id, SEED);
      const before = await manifestOf(source.id);
      const current = await boxes.getBox(host, source.boxId);

      const rebuilt = await rebuildWithSafety(
        host,
        source.boxId,
        current.revision,
        { env: [{ name: "TRIAL", value: "1" }] },
        true,
        undefined,
        preRebuildSafety(host, "tester"),
      );

      expect(rebuilt.box).toMatchObject({ running: true, revision: current.revision + 1 });
      expect(rebuilt.safety).toMatchObject({ label: "Before rebuild" });
      expect(await manifestOf(rebuilt.box.id)).toBe(before);

      const safetyId = rebuilt.safety?.id ?? "";
      const forked = await forkCheckpoint(
        host,
        safetyId,
        { name: "from-safety", cpus: 0.5, memoryMb: 64, copyHome: false },
        "tester",
      );
      expect(await manifestOf(forked.id)).toBe(before);
    },
    LONG,
  );
});
