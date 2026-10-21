/**
 * Takes checkpoints of a box on a real engine and restores them. A fork and an in-place rollback must each give back the
 * /workspace the checkpoint saw: the same paths, modes, owners and bytes. The snapshots go through the restic helper, so
 * this also covers the checkpoint repository volume and the password it is opened with.
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

import { createDockerRuntime } from "../src/docker/runtime";
import { createLocalHost, type HostCtx } from "../src/host/registry";
import type { Runtime } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { forkCheckpoint, rollbackBox, takeCheckpoint } from "../src/services/checkpoints";
import { silenceLogs, testConfig } from "./support/app";

const enabled = process.env.MINIBOX_TEST_DOCKER === "1";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const IMAGE = process.env.MINIBOX_TEST_IMAGE ?? "alpine:3.20";
const LONG = 120_000;

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

  const takeOf = (boxId: string, consistency: "live" | "pause") =>
    takeCheckpoint(host, boxId, { pinned: false, include: { system: false, volumes: [] }, consistency }, "tester");

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
});
