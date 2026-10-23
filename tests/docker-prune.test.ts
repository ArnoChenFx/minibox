/**
 * Finds and removes orphaned volumes on a real engine. A volume that a running box mounts is never listed, even when it
 * is old enough, a dry run removes nothing, and a real prune removes only the volume nothing mounts.
 *
 *   bun run test:docker
 *
 * That script (scripts/docker-integration.ts) pulls the images, picks a fresh label prefix and sweeps what the run left
 * behind. To run this file directly: MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbit<id> bun test tests/docker-prune.test.ts
 *
 * Optional: DOCKER_SOCKET (default /var/run/docker.sock) and MINIBOX_TEST_IMAGE (default alpine:3.20). The image must
 * already be present locally. The prefix must start with "mbit", so the cleanup can never touch a real MiniBox install.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Docker from "dockerode";

import { createDockerRuntime } from "../src/docker/runtime";
import { createLocalHost, type HostCtx } from "../src/host/registry";
import { isRuntimeError, type Runtime } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { pruneVolumes } from "../src/services/volume-prune";
import { createVolume } from "../src/services/volumes";
import { silenceLogs, testConfig } from "./support/app";

const enabled = process.env.MINIBOX_TEST_DOCKER === "1";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const IMAGE = process.env.MINIBOX_TEST_IMAGE ?? "alpine:3.20";
const LONG = 120_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const PREFIX_PATTERN = /^mbit[a-z0-9-]{3,40}$/;
const prefix = process.env.MINIBOX_TEST_PREFIX ?? `mbit${Date.now().toString(36)}`;
if (enabled && !PREFIX_PATTERN.test(prefix)) throw new Error(`MINIBOX_TEST_PREFIX must match ${PREFIX_PATTERN}`);
const runtime: Runtime = createDockerRuntime(SOCKET);
const docker = new Docker({ socketPath: SOCKET });

const KEPT_BOX = "prune-kept";
const ORPHAN = "prune-orphan";

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

async function volumeExists(name: string): Promise<boolean> {
  try {
    await runtime.inspectVolume(name);
    return true;
  } catch (e) {
    if (isRuntimeError(e, "not_found")) return false;
    throw e;
  }
}

/** Moves every volume's creation and last mount a month back, so only the mounts decide whether one is an orphan. */
function ageVolumes(host: HostCtx): void {
  const old = new Date(Date.now() - 30 * DAY_MS).toISOString();
  for (const record of host.volumes.list()) {
    host.volumes.write({
      ...record,
      createdAt: old,
      lastMount: record.lastMount ? { ...record.lastMount, at: old } : null,
    });
  }
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

describe.skipIf(!enabled)("orphaned volumes against a real engine", () => {
  let dataDir = "";
  let host: HostCtx;
  let restoreLogs: () => void;
  let keptContainer = "";

  beforeAll(() => {
    restoreLogs = silenceLogs();
    dataDir = mkdtempSync(join(tmpdir(), "minibox-prune-docker-"));
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

  const keptBox = () => {
    const box = host.specs.list().find((spec) => spec.name === KEPT_BOX);
    if (!box) throw new Error(`no box named ${KEPT_BOX}`);
    return box;
  };

  test(
    "a dry run lists the orphan, and the volumes of a running box are never listed",
    async () => {
      const created = await boxes.createBox(host, {
        name: KEPT_BOX,
        image: IMAGE,
        cpus: 0.5,
        memoryMb: 64,
        createdBy: "tester",
      });
      keptContainer = created.id;
      await createVolume(host, { name: ORPHAN, role: "cache", createdBy: "tester" });
      ageVolumes(host);

      const preview = await pruneVolumes([host], {
        dryRun: true,
        ids: null,
        olderThanMs: null,
        principal: "tester",
        may: async () => true,
      });

      expect(preview.hosts.map((item) => item.status)).toEqual(["checked"]);
      expect(preview.volumes.map((volume) => [volume.name, volume.status])).toEqual([[ORPHAN, "candidate"]]);
      for (const mount of keptBox().mounts) expect(await volumeExists(mount.volume)).toBe(true);
    },
    LONG,
  );

  test(
    "a real prune removes the orphan from the engine, and the running box keeps its volumes",
    async () => {
      const orphan = host.volumes.list().find((volume) => volume.name === ORPHAN);
      if (!orphan) throw new Error(`no record for ${ORPHAN}`);
      expect(await volumeExists(orphan.engineName)).toBe(true);

      const result = await pruneVolumes([host], {
        dryRun: false,
        ids: [orphan.id],
        olderThanMs: null,
        principal: "tester",
        may: async () => true,
      });

      expect(result.volumes.map((volume) => [volume.name, volume.status])).toEqual([[ORPHAN, "removed"]]);
      expect(await volumeExists(orphan.engineName)).toBe(false);
      for (const mount of keptBox().mounts) expect(await volumeExists(mount.volume)).toBe(true);
      expect(await shell(keptContainer, "echo still-running")).toBe("still-running");
    },
    LONG,
  );
});
