/**
 * Runs the Docker adapter and the box/snapshot/template services against a real engine.
 *
 *   MINIBOX_TEST_DOCKER=1 bun test tests/docker-runtime.test.ts
 *
 * Optional: DOCKER_SOCKET (default /var/run/docker.sock), MINIBOX_TEST_IMAGE (default alpine:3.20, must already be
 * present locally). Every resource is labelled with a unique prefix and removed afterwards.
 */
import { afterAll, describe, expect, test } from "bun:test";

import Docker from "dockerode";

import { BOX_PROFILES, type BoxProfile } from "../src/box-profile";
import { createDockerRuntime } from "../src/docker/runtime";
import { createLocalHost } from "../src/host/registry";
import type { Runtime } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { createSnapshot, deleteSnapshot } from "../src/services/snapshots";
import { deleteTemplate, promoteSnapshot } from "../src/services/templates";
import { rejectionOf, silenceLogs, testConfig } from "./support/app";

const enabled = process.env.MINIBOX_TEST_DOCKER === "1";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const IMAGE = process.env.MINIBOX_TEST_IMAGE ?? "alpine:3.20";
const LONG = 60_000;

const prefix = `mbit${Date.now().toString(36)}`;
const runtime: Runtime = createDockerRuntime(SOCKET);
const cfg = testConfig({ labelPrefix: prefix, dockerSocket: SOCKET, baseTemplateTag: `${prefix}-template:base` });
const host = createLocalHost(cfg, runtime);
const owned = { [prefix]: "true" };
const docker = new Docker({ socketPath: SOCKET });

/** CapBnd and NoNewPrivs each profile must produce inside a box (docs/design.md §14). */
const EXPECTED_STATE: Record<BoxProfile, { capBnd: string; noNewPrivs: string }> = {
  standard: { capBnd: "00000000a00024fb", noNewPrivs: "0" },
  strict: { capBnd: "0000000000000000", noNewPrivs: "1" },
  relaxed: { capBnd: "00000000a80425fb", noNewPrivs: "0" },
};

async function waitUntil(check: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

afterAll(async () => {
  if (!enabled) return;
  for (const c of await runtime.listContainers({ labels: owned })) {
    await runtime.removeContainer(c.id, { force: true }).catch(() => {});
  }
  for (const label of ["snapshot", "template"]) {
    for (const img of await runtime.listImages({ labels: { [`${prefix}.${label}`]: "true" } })) {
      await runtime.removeImage(img.id, { force: true }).catch(() => {});
    }
  }
  const { Volumes } = await docker.listVolumes({ filters: { label: [`${prefix}=true`] } });
  for (const volume of Volumes ?? [])
    await docker
      .getVolume(volume.Name)
      .remove()
      .catch(() => {});
  for (const name of [host.security.network, `${prefix}-icc-check`, `${prefix}-gone`]) {
    await docker
      .getNetwork(name)
      .remove()
      .catch(() => {});
  }
});

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

/** The address and gateway a box has on one network, as the engine reports them. */
async function endpointOf(id: string, network: string): Promise<{ ip: string; gateway: string }> {
  const endpoint = (await docker.getContainer(id).inspect()).NetworkSettings.Networks[network];
  if (!endpoint) throw new Error(`box ${id} has no endpoint on ${network}`);
  return { ip: endpoint.IPAddress, gateway: endpoint.Gateway };
}

describe.skipIf(!enabled)("Docker adapter against a real engine", () => {
  test(
    "the engine answers ping and info",
    async () => {
      const restore = silenceLogs();
      try {
        await runtime.ping();
        const info = await runtime.info();
        expect(typeof info.containers.total).toBe("number");
        expect(typeof info.images).toBe("number");
      } finally {
        restore();
      }
    },
    LONG,
  );

  test(
    "container lifecycle, limits, logs and error kinds",
    async () => {
      const name = `${prefix}-lifecycle`;
      const { id } = await runtime.createContainer({
        image: IMAGE,
        name,
        cmd: ["sleep", "300"],
        labels: { ...owned, [`${prefix}.name`]: "lifecycle" },
        restart: "unless-stopped",
        cpus: 0.5,
        memoryBytes: 64 * 1024 * 1024,
        swapBytes: 64 * 1024 * 1024,
        init: true,
        workingDir: "/",
        hostname: "lifecycle",
      });

      expect(await rejectionOf(runtime.createContainer({ image: IMAGE, name }))).toMatchObject({ kind: "conflict" });
      expect(await rejectionOf(runtime.inspectContainer("no-such-container-xyz"))).toMatchObject({ kind: "not_found" });
      expect(await rejectionOf(runtime.createContainer({ image: "no-such-image-xyz:latest" }))).toMatchObject({
        kind: "not_found",
      });

      const listed = await runtime.listContainers({ labels: owned });
      expect(listed.map((c) => c.id)).toEqual([id]);
      expect(listed[0]).toMatchObject({
        name,
        cpus: 0.5,
        memoryBytes: 64 * 1024 * 1024,
        running: false,
        startedAt: null,
      });

      await runtime.startContainer(id);
      await runtime.startContainer(id);
      expect((await runtime.inspectContainer(id)).running).toBe(true);

      await runtime.updateContainer(id, { cpus: 1 });
      expect(await runtime.inspectContainer(id)).toMatchObject({ cpus: 1, memoryBytes: 64 * 1024 * 1024 });

      await runtime.stopContainer(id, { timeoutSec: 1 });
      await runtime.stopContainer(id, { timeoutSec: 1 });
      expect((await runtime.inspectContainer(id)).running).toBe(false);

      await runtime.restartContainer(id, { timeoutSec: 1 });
      expect((await runtime.inspectContainer(id)).running).toBe(true);

      await runtime.renameContainer(id, `${name}-renamed`);
      expect((await runtime.inspectContainer(id)).name).toBe(`${name}-renamed`);

      const stats = await runtime.containerStats(id);
      expect(stats.memLimit).toBeGreaterThan(0);

      expect(await rejectionOf(runtime.removeContainer(id, { force: false }))).toMatchObject({ kind: "conflict" });
      await runtime.removeContainer(id, { force: true });
      expect(await rejectionOf(runtime.removeContainer(id, { force: true }))).toMatchObject({ kind: "not_found" });
    },
    LONG,
  );

  test(
    "exec runs under a TTY, accepts resize and reports the exit code",
    async () => {
      const { id } = await runtime.createContainer({
        image: IMAGE,
        name: `${prefix}-exec`,
        cmd: ["sleep", "300"],
        labels: owned,
        init: true,
      });
      await runtime.startContainer(id);
      try {
        const exec = await runtime.startExec(id, {
          cmd: ["sh", "-c", "echo hello-tty; sleep 1; exit 3"],
          env: ["TERM=xterm-256color"],
          workingDir: "/",
        });
        let output = "";
        exec.stream.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
        });
        await exec.resize({ cols: 100, rows: 30 });
        expect(await exec.inspect()).toMatchObject({ running: true, exitCode: null });

        await waitUntil(async () => !(await exec.inspect()).running, "the exec to finish");
        expect(await exec.inspect()).toMatchObject({ running: false, exitCode: 3 });
        expect(output).toContain("hello-tty");
      } finally {
        await runtime.removeContainer(id, { force: true });
      }
    },
    LONG,
  );

  test(
    "events stop when the signal aborts",
    async () => {
      const controller = new AbortController();
      const seen: string[] = [];
      const consumer = (async () => {
        for await (const event of runtime.events({ labels: owned }, controller.signal)) {
          seen.push(`${event.type}:${event.action}`);
        }
        return "ended";
      })();

      const { id } = await runtime.createContainer({ image: IMAGE, name: `${prefix}-events`, labels: owned });
      await waitUntil(async () => {
        if (seen.includes("container:start")) return true;
        await runtime.startContainer(id);
        await runtime.stopContainer(id, { timeoutSec: 0 });
        return false;
      }, "the start event");
      controller.abort();

      expect(await settleWithin(consumer, 5000)).toBe("ended");
      await runtime.removeContainer(id, { force: true });
    },
    LONG,
  );

  test(
    "a box can be created, snapshotted, restored from the snapshot and promoted to a template",
    async () => {
      const restore = silenceLogs();
      try {
        const alpha = await boxes.createBox(host, { name: "a", image: IMAGE, cpus: 0.5, memoryMb: 64 });
        expect(alpha).toMatchObject({ running: true, volume: `${prefix}-ws-a` });
        expect(await runtime.inspectVolume(`${prefix}-ws-a`)).toMatchObject({ name: `${prefix}-ws-a` });

        const { ref } = await createSnapshot(host, alpha.id, "base");
        expect(ref).toMatch(new RegExp(`^${prefix}-snap:base-`));

        const beta = await boxes.createBox(host, { name: "b", image: ref, cpus: 0.5, memoryMb: 64 });
        expect(beta).toMatchObject({ running: true, template: ref });

        const promoted = await promoteSnapshot(host, ref, "gold", "Gold");
        expect(promoted.ref).toBe(`${prefix}-template:gold`);
        expect((await runtime.inspectImage(promoted.ref)).labels).toMatchObject({
          [`${prefix}.template`]: "true",
          [`${prefix}.snapshot`]: "false",
        });

        await boxes.deleteBox(host, alpha.id, true);
        await boxes.deleteBox(host, beta.id, true);
        expect(await rejectionOf(runtime.inspectVolume(`${prefix}-ws-a`))).toMatchObject({ kind: "not_found" });

        await deleteSnapshot(host, ref);
        await deleteTemplate(host, promoted.ref);
        expect(await rejectionOf(runtime.inspectImage(promoted.ref))).toMatchObject({ kind: "not_found" });
      } finally {
        restore();
      }
    },
    LONG,
  );

  test(
    "the box network is created once, and a network with other settings is refused",
    async () => {
      const name = `${prefix}-icc-check`;
      await runtime.ensureBridgeNetwork(name, { interContainerComm: false });
      await runtime.ensureBridgeNetwork(name, { interContainerComm: false });
      expect(await rejectionOf(runtime.ensureBridgeNetwork(name, { interContainerComm: true }))).toMatchObject({
        kind: "conflict",
      });
      expect((await docker.getNetwork(name).inspect()).Options).toMatchObject({
        "com.docker.network.bridge.enable_icc": "false",
      });
    },
    LONG,
  );

  test(
    "boxes on the box network cannot reach each other, but still reach their gateway",
    async () => {
      const restore = silenceLogs();
      try {
        const a = await boxes.createBox(host, { name: "icc-a", image: IMAGE, cpus: 0.5, memoryMb: 64 });
        const b = await boxes.createBox(host, { name: "icc-b", image: IMAGE, cpus: 0.5, memoryMb: 64 });
        const { gateway } = await endpointOf(a.id, host.security.network);
        const { ip } = await endpointOf(b.id, host.security.network);

        const pingFromA = (target: string) =>
          shell(a.id, `ping -c 1 -W 2 ${target} >/dev/null 2>&1 && echo reached || echo blocked`);
        expect(await pingFromA(gateway)).toBe("reached");
        expect(await pingFromA(ip)).toBe("blocked");
      } finally {
        restore();
      }
    },
    LONG,
  );

  test(
    "each box profile reaches the engine with its capabilities, privilege rule, process limit and ulimits",
    async () => {
      const restore = silenceLogs();
      try {
        for (const profile of BOX_PROFILES) {
          const box = await boxes.createBox(host, {
            name: `p-${profile}`,
            image: IMAGE,
            cpus: 0.5,
            memoryMb: 64,
            profile,
          });
          expect(box).toMatchObject({ profile, network: host.security.network, running: true });
          expect((await runtime.inspectContainer(box.id)).network).toBe(host.security.network);

          const { capBnd, noNewPrivs } = EXPECTED_STATE[profile];
          expect(
            await shell(box.id, "grep -E '^(CapBnd|NoNewPrivs):' /proc/self/status | cut -f2 | tr '\\n' ' '"),
          ).toBe(`${capBnd} ${noNewPrivs}`);
          expect(await shell(box.id, "ulimit -c; ulimit -n")).toBe("0\n65536");
          // cgroup v1 hosts have no pids.max at this path, so the limit is only checked where it exists.
          const pids = await shell(box.id, "cat /sys/fs/cgroup/pids.max 2>/dev/null");
          if (pids) expect(pids).toBe("1024");
        }
      } finally {
        restore();
      }
    },
    LONG,
  );

  test(
    "a stopped box starts again after its network was removed",
    async () => {
      const restore = silenceLogs();
      try {
        const box = await boxes.createBox(host, { name: "pruned", image: IMAGE, cpus: 0.5, memoryMb: 64 });
        for (const other of await boxes.listBoxes(host)) await boxes.stopBox(host, other.id);
        await docker.getNetwork(host.security.network).remove();

        expect(await boxes.startBox(host, box.id)).toMatchObject({ running: true, network: host.security.network });
      } finally {
        restore();
      }
    },
    LONG,
  );

  test(
    "reattachNetwork attaches a box that never started, and leaves a current endpoint alone",
    async () => {
      const network = host.security.network;
      await runtime.ensureBridgeNetwork(network, { interContainerComm: false });
      const { id } = await runtime.createContainer({
        image: IMAGE,
        name: `${prefix}-fresh`,
        cmd: ["sleep", "300"],
        labels: owned,
        network,
        init: true,
      });
      const endpointFor = async () => (await docker.getContainer(id).inspect()).NetworkSettings.Networks[network];
      expect((await endpointFor())?.NetworkID).toBe("");

      await runtime.reattachNetwork(id, network);
      await runtime.startContainer(id);
      expect((await endpointFor())?.NetworkID).toBe((await docker.getNetwork(network).inspect()).Id);

      const endpointId = (await endpointFor())?.EndpointID;
      await runtime.reattachNetwork(id, network);
      expect((await endpointFor())?.EndpointID).toBe(endpointId);
      expect((await runtime.inspectContainer(id)).running).toBe(true);
    },
    LONG,
  );

  test(
    "reattachNetwork refuses a container on another network, and a network that no longer exists",
    async () => {
      const { id: plain } = await runtime.createContainer({ image: IMAGE, name: `${prefix}-plain`, labels: owned });
      expect(await rejectionOf(runtime.reattachNetwork(plain, host.security.network))).toMatchObject({
        kind: "invalid",
      });

      const gone = `${prefix}-gone`;
      await runtime.ensureBridgeNetwork(gone, { interContainerComm: false });
      const { id } = await runtime.createContainer({
        image: IMAGE,
        name: `${prefix}-orphan`,
        labels: owned,
        network: gone,
      });
      await docker.getNetwork(gone).remove();
      expect(await rejectionOf(runtime.reattachNetwork(id, gone))).toMatchObject({ kind: "not_found" });
    },
    LONG,
  );
});
