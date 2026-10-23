/**
 * Runs the Docker adapter and the box/snapshot/template services against a real engine.
 *
 *   bun run test:docker
 *
 * That script (scripts/docker-integration.ts) pulls the image, picks a fresh label prefix and sweeps what the run left
 * behind. To run this file directly: MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbit<id> bun test tests/docker-runtime.test.ts
 *
 * Optional: DOCKER_SOCKET (default /var/run/docker.sock), MINIBOX_TEST_IMAGE (default alpine:3.20, must already be
 * present locally, and must contain /bin/busybox for the sudo test). The prefix must start with "mbit", so the cleanup
 * can never touch a real MiniBox install.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Docker from "dockerode";

import { BOX_PROFILES, type BoxProfile } from "../src/box-profile";
import { createDockerRuntime, toHelperOptions } from "../src/docker/runtime";
import { OutputStore } from "../src/events/outputs";
import { createRedactor } from "../src/events/redact";
import { createLocalHost } from "../src/host/registry";
import type { HostSampler } from "../src/host/sampler";
import type { Runtime } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { ExecManager } from "../src/services/exec";
import { rebuildBox } from "../src/services/rebuild";
import { createSnapshot, deleteSnapshot } from "../src/services/snapshots";
import { deleteTemplate, promoteSnapshot, saveBoxAsTemplate } from "../src/services/templates";
import { attachVolume, createVolume, measureVolume } from "../src/services/volumes";
import type { RebuildRequest } from "../src/specs/plan";
import type { BoxMount } from "../src/specs/types";
import { labelsFor, rootOwnerOf, WRITE_CHECK } from "../src/volumes/engine";
import { DEV_OWNER } from "../src/volumes/types";
import { rejectionOf, silenceLogs, testConfig } from "./support/app";

const enabled = process.env.MINIBOX_TEST_DOCKER === "1";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const IMAGE = process.env.MINIBOX_TEST_IMAGE ?? "alpine:3.20";
const LONG = 60_000;

const PREFIX_PATTERN = /^mbit[a-z0-9-]{3,40}$/;
const prefix = process.env.MINIBOX_TEST_PREFIX ?? `mbit${Date.now().toString(36)}`;
if (enabled && !PREFIX_PATTERN.test(prefix)) throw new Error(`MINIBOX_TEST_PREFIX must match ${PREFIX_PATTERN}`);
const runtime: Runtime = createDockerRuntime(SOCKET);
const cfg = testConfig({
  labelPrefix: prefix,
  dockerSocket: SOCKET,
  baseTemplateTag: `${prefix}-template:base`,
  dataDir: mkdtempSync(join(tmpdir(), "minibox-docker-test-")),
});
const host = createLocalHost(cfg, runtime);
const owned = { [prefix]: "true" };
const docker = new Docker({ socketPath: SOCKET });

/** CapBnd and NoNewPrivs each profile must produce inside a box. */
const EXPECTED_STATE: Record<BoxProfile, { capBnd: string; noNewPrivs: string }> = {
  standard: { capBnd: "00000000a00024fb", noNewPrivs: "0" },
  strict: { capBnd: "0000000000000000", noNewPrivs: "1" },
  relaxed: { capBnd: "00000000a80425fb", noNewPrivs: "0" },
};

const shortImageId = (id: string) => id.replace(/^sha256:/, "").slice(0, 12);

async function waitUntil(check: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

async function volumeExists(name: string): Promise<boolean> {
  return docker
    .getVolume(name)
    .inspect()
    .then(
      () => true,
      () => false,
    );
}

async function boxIds(): Promise<string[]> {
  return (await runtime.listContainers({ labels: owned })).map((c) => c.id).toSorted();
}

/** A line of a timestamped log: the engine's RFC 3339 time, then a space. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\S+ /;

async function drain(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
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

/**
 * How many processes in the box have a command line that matches `pattern` (a grep pattern, matched per line). Anchor
 * it with `^` and bracket a letter, as in `^[s]leep 317`, so the probe does not count its own command line.
 */
async function countProcesses(id: string, pattern: string): Promise<number> {
  const found = await shell(
    id,
    `for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done | grep -c '${pattern}' || true`,
  );
  return Number(found);
}

/** The exec service the app runs, over this test's runtime and output directory. */
function execService(): ExecManager {
  const redactor = createRedactor();
  return new ExecManager(new OutputStore(join(cfg.dataDir, "exec"), redactor), (text) => redactor.text(text));
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
    "pausing freezes a running container, and pulling a present image is a no-op",
    async () => {
      const name = `${prefix}-pause`;
      const { id } = await runtime.createContainer({ image: IMAGE, name, cmd: ["sleep", "300"], labels: owned });
      expect(await rejectionOf(runtime.pauseContainer(id))).toMatchObject({ kind: "conflict" });
      await runtime.startContainer(id);
      await runtime.pauseContainer(id);
      expect(await runtime.inspectContainer(id)).toMatchObject({ running: true, state: "paused" });
      expect(await rejectionOf(runtime.pauseContainer(id))).toMatchObject({ kind: "conflict" });
      await runtime.unpauseContainer(id);
      expect(await runtime.inspectContainer(id)).toMatchObject({ running: true, state: "running" });
      await runtime.unpauseContainer(id);
      expect(await runtime.inspectContainer(id)).toMatchObject({ running: true, state: "running" });
      await runtime.pullImage(IMAGE);
      await runtime.removeContainer(id, { force: true });
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
      await runtime.updateContainer(id, { pidsLimit: 128, restart: "no" });
      expect(await runtime.inspectContainer(id)).toMatchObject({ pidsLimit: 128, restart: "no" });

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
    "a stats call gives up when its signal aborts, so a sampler's timeout ends the engine request",
    async () => {
      const { id } = await runtime.createContainer({
        image: IMAGE,
        name: `${prefix}-stats-abort`,
        cmd: ["sleep", "300"],
        labels: owned,
      });
      try {
        await runtime.startContainer(id);
        const began = performance.now();
        const timedOut = await rejectionOf(runtime.containerStats(id, { signal: AbortSignal.timeout(20) }));
        expect((timedOut as Error).name).toBe("AbortError");
        expect(performance.now() - began).toBeLessThan(1000);
        const preAborted = await rejectionOf(runtime.containerStats(id, { signal: AbortSignal.abort() }));
        expect((preAborted as Error).name).toBe("AbortError");
        const stats = await runtime.containerStats(id, { signal: new AbortController().signal });
        expect(stats.memLimit).toBeGreaterThan(0);
      } finally {
        await runtime.removeContainer(id, { force: true });
      }
    },
    LONG,
  );

  test(
    "an inspect and a listing give up when their signal is already aborted, and answer when it is not",
    async () => {
      const { id } = await runtime.createContainer({
        image: IMAGE,
        name: `${prefix}-inspect-abort`,
        cmd: ["sleep", "300"],
        labels: owned,
      });
      try {
        await runtime.startContainer(id);
        const inspected = await rejectionOf(runtime.inspectContainer(id, { signal: AbortSignal.abort() }));
        expect((inspected as Error).name).toBe("AbortError");
        const listed = await rejectionOf(runtime.listContainers({ labels: owned }, { signal: AbortSignal.abort() }));
        expect((listed as Error).name).toBe("AbortError");

        const live = new AbortController().signal;
        expect((await runtime.inspectContainer(id, { signal: live })).running).toBe(true);
        expect((await runtime.listContainers({ labels: owned }, { signal: live })).map((c) => c.id)).toEqual([id]);
      } finally {
        await runtime.removeContainer(id, { force: true });
      }
    },
    LONG,
  );

  test(
    "containerDiff lists a file written in the writable layer",
    async () => {
      const { id } = await runtime.createContainer({
        image: IMAGE,
        name: `${prefix}-diff`,
        cmd: ["sleep", "300"],
        labels: owned,
      });
      expect(await runtime.containerDiff(id)).toEqual([]);
      await runtime.startContainer(id);
      try {
        const exec = await runtime.startExec(id, {
          cmd: ["sh", "-c", "echo hi > /tmp/mb-diff"],
          env: [],
          workingDir: "/",
        });
        await waitUntil(async () => !(await exec.inspect()).running, "the diff command to finish");
        expect(await runtime.containerDiff(id)).toContainEqual({ path: "/tmp/mb-diff", kind: "added" });
      } finally {
        await runtime.removeContainer(id, { force: true });
      }
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
    "exec without a TTY separates stdout and stderr, reports the exit code, and kill stops the process",
    async () => {
      const { id } = await runtime.createContainer({
        image: IMAGE,
        name: `${prefix}-exec-notty`,
        cmd: ["sleep", "300"],
        labels: owned,
        init: true,
      });
      await runtime.startContainer(id);
      try {
        const finished = await runtime.startExec(id, {
          cmd: ["sh", "-c", "echo out-text; echo err-text >&2; exit 3"],
          env: [],
          workingDir: "/",
          tty: false,
        });
        let stdout = "";
        let stderr = "";
        finished.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        finished.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        await waitUntil(async () => !(await finished.inspect()).running, "the non-tty command to finish");
        expect(await finished.inspect()).toMatchObject({ running: false, exitCode: 3 });
        expect(stdout).toContain("out-text");
        expect(stderr).toContain("err-text");

        const hanging = await runtime.startExec(id, {
          cmd: ["sh", "-c", "echo started; sleep 30"],
          env: [],
          workingDir: "/",
          tty: false,
        });
        let started = "";
        hanging.stdout.on("data", (chunk: Buffer) => {
          started += chunk.toString("utf8");
        });
        await waitUntil(async () => started.includes("started"), "the sleep command to print");
        await hanging.kill();
        await waitUntil(async () => !(await hanging.inspect()).running, "the sleep command to stop");
        expect((await hanging.inspect()).running).toBe(false);
      } finally {
        await runtime.removeContainer(id, { force: true });
      }
    },
    LONG,
  );

  test(
    "kill stops a command running as another uid and its children, from inside the box",
    async () => {
      const { id } = await runtime.createContainer({
        image: IMAGE,
        name: `${prefix}-exec-uid`,
        cmd: ["sleep", "300"],
        labels: owned,
        init: true,
      });
      await runtime.startContainer(id);
      const probe = async (cmd: string): Promise<string> => {
        const run = await runtime.startExec(id, { cmd: ["sh", "-c", cmd], env: [], workingDir: "/", tty: false });
        let out = "";
        run.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf8");
        });
        await waitUntil(async () => !(await run.inspect()).running, "the probe to finish");
        return out.trim();
      };
      try {
        const hanging = await runtime.startExec(id, {
          cmd: ["sh", "-c", "sleep 317 & echo started $(id -u); wait"],
          env: [],
          workingDir: "/",
          tty: false,
          user: "65534",
        });
        let started = "";
        hanging.stdout.on("data", (chunk: Buffer) => {
          started += chunk.toString("utf8");
        });
        await waitUntil(async () => started.includes("started 65534"), "the command to run as uid 65534");

        await hanging.kill();
        await waitUntil(async () => !(await hanging.inspect()).running, "the command to stop");
        expect(await hanging.inspect()).toMatchObject({ running: false, exitCode: 137 });
        await waitUntil(async () => (await probe("ps | grep -c '[s]leep 317' || true")) === "0", "the child to stop");
        // The probe runs through the exec wrapper too, so its own marker is the only one left.
        expect(await probe("ls -a /tmp | grep -c minibox-exec || true")).toBe("1");
        await expect(hanging.kill()).resolves.toBeUndefined();
      } finally {
        await runtime.removeContainer(id, { force: true });
      }
    },
    LONG,
  );

  test(
    "a command that deletes its own marker is stopped with its children",
    async () => {
      const { id } = await runtime.createContainer({
        image: IMAGE,
        name: `${prefix}-marker`,
        cmd: ["sleep", "300"],
        labels: owned,
        init: true,
      });
      await runtime.startContainer(id);
      try {
        const exec = await runtime.startExec(id, {
          cmd: [
            "sh",
            "-c",
            "test -e /tmp/.minibox-exec-*.$PPID && echo marked; rm -f /tmp/.minibox-exec-*.$PPID; echo started; sleep 317",
          ],
          env: [],
          workingDir: "/",
          tty: false,
        });
        let out = "";
        exec.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf8");
        });
        await waitUntil(async () => out.includes("started"), "the command to start");
        expect(out).toContain("marked");
        expect(await shell(id, `ls -a /tmp | grep minibox-exec | grep -vF ".$PPID" | grep -c . || true`)).toBe("0");

        await exec.kill();
        await waitUntil(async () => !(await exec.inspect()).running, "the command to stop");
        expect(await exec.inspect()).toMatchObject({ running: false, exitCode: 137 });
        expect(await countProcesses(id, "^[s]leep 317")).toBe(0);
      } finally {
        await runtime.removeContainer(id, { force: true });
      }
    },
    LONG,
  );

  test(
    "a command that overwrites its marker with another pid is stopped, and the process that pid names is left alone",
    async () => {
      const { id } = await runtime.createContainer({
        image: IMAGE,
        name: `${prefix}-decoy`,
        cmd: ["sleep", "300"],
        labels: owned,
        init: true,
      });
      await runtime.startContainer(id);
      try {
        const decoy = await runtime.startExec(id, {
          cmd: ["sh", "-c", "echo $$; exec sleep 600"],
          env: [],
          workingDir: "/",
          tty: false,
        });
        let decoyOut = "";
        decoy.stdout.on("data", (chunk: Buffer) => {
          decoyOut += chunk.toString("utf8");
        });
        await waitUntil(async () => decoyOut.includes("\n"), "the decoy to print its pid");
        const decoyPid = Number(decoyOut.trim());

        const victim = await runtime.startExec(id, {
          cmd: [
            "sh",
            "-c",
            `for m in /tmp/.minibox-exec-*.$PPID; do echo ${decoyPid} > "$m"; : > "\${m%.*}.${decoyPid}"; done; echo started; sleep 317`,
          ],
          env: [],
          workingDir: "/",
          tty: false,
        });
        let victimOut = "";
        victim.stdout.on("data", (chunk: Buffer) => {
          victimOut += chunk.toString("utf8");
        });
        await waitUntil(async () => victimOut.includes("started"), "the victim to overwrite its marker");

        await victim.kill();
        await waitUntil(async () => !(await victim.inspect()).running, "the victim to stop");
        expect(await victim.inspect()).toMatchObject({ running: false, exitCode: 137 });
        expect(await countProcesses(id, "^[s]leep 317")).toBe(0);

        expect((await decoy.inspect()).running).toBe(true);
        expect(await countProcesses(id, "^[s]leep 600")).toBe(1);
        await decoy.kill();
        await waitUntil(async () => !(await decoy.inspect()).running, "the decoy to stop");
      } finally {
        await runtime.removeContainer(id, { force: true });
      }
    },
    LONG,
  );

  test(
    "a sudo child that becomes root is stopped by the kill, which the exec user cannot do on its own",
    async () => {
      const restore = silenceLogs();
      try {
        const box = await boxes.createBox(host, {
          name: "sudo",
          image: IMAGE,
          cpus: 0.5,
          memoryMb: 64,
          profile: "standard",
        });
        try {
          // busybox su is setuid root and sets its real uid to 0 after a password check, as sudo does.
          expect(
            await shell(
              box.id,
              "mkdir -p /tmp/mb-suid && cp -L /bin/busybox /tmp/mb-suid/su && chown root:root /tmp/mb-suid/su && chmod 4755 /tmp/mb-suid/su && echo 'root:mbpass' | chpasswd >/dev/null 2>&1 && echo ready",
            ),
          ).toBe("ready");
          const command = "printf 'mbpass\\n' | /tmp/mb-suid/su -c 'echo started; sleep 317' root";
          const sleepUids = `for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null | grep -q '^sleep 317' && awk '/^Uid/{print $2, $3}' $p/status; done`;

          const service = execService();
          const run = await service.run(host, box, {
            cmd: command,
            cwd: "/",
            env: {},
            timeoutSec: 60,
            user: "65534",
            background: true,
          });
          await waitUntil(async () => (await countProcesses(box.id, "^[s]leep 317")) === 1, "the sudo child to start");
          expect(await shell(box.id, sleepUids)).toBe("0 0");

          await service.kill(run.execId);
          expect(await service.get(run.execId, 0)).toMatchObject({ status: "killed", exitCode: 137 });
          expect(await countProcesses(box.id, "^[s]leep 317")).toBe(0);

          const stuck = await runtime.startExec(box.id, {
            cmd: ["sh", "-c", command],
            env: [],
            workingDir: "/",
            tty: false,
            user: "65534",
            stopAs: "65534",
          });
          await waitUntil(async () => (await countProcesses(box.id, "^[s]leep 317")) === 1, "the second sudo child");
          expect(await rejectionOf(stuck.kill())).toMatchObject({ kind: "engine" });
          expect((await stuck.inspect()).running).toBe(true);
        } finally {
          await boxes.deleteBox(host, box.id, true);
        }
      } finally {
        restore();
      }
    },
    LONG,
  );

  test(
    "a timeout whose kill fails while the box is paused is retried until the exec stops",
    async () => {
      const restore = silenceLogs();
      try {
        const box = await boxes.createBox(host, {
          name: "retry",
          image: IMAGE,
          cpus: 0.5,
          memoryMb: 64,
          profile: "standard",
        });
        try {
          const service = execService();
          const run = await service.run(host, box, {
            cmd: "sleep 317",
            cwd: "/",
            env: {},
            timeoutSec: 3,
            user: "65534",
            background: true,
          });
          await waitUntil(async () => (await countProcesses(box.id, "^[s]leep 317")) === 1, "the sleep to start");
          const container = docker.getContainer(box.id);
          await container.pause();
          try {
            await waitUntil(
              async () => (await service.get(run.execId, 0)).timedOut,
              "the timeout to fire while the box is paused",
              10_000,
            );
            await Bun.sleep(300);
            expect(await service.get(run.execId, 0)).toMatchObject({ status: "running", timedOut: true });
          } finally {
            await container.unpause();
          }
          await waitUntil(
            async () => (await service.get(run.execId, 0)).status === "killed",
            "the timed-out exec to be stopped",
            15_000,
          );
          expect(await service.get(run.execId, 0)).toMatchObject({ status: "killed", exitCode: 137, timedOut: true });
        } finally {
          await boxes.deleteBox(host, box.id, true);
        }
      } finally {
        restore();
      }
    },
    LONG,
  );

  test(
    "kill stops a terminal exec and its children from inside the box",
    async () => {
      const { id } = await runtime.createContainer({
        image: IMAGE,
        name: `${prefix}-exec-tty-kill`,
        cmd: ["sleep", "300"],
        labels: owned,
        init: true,
      });
      await runtime.startContainer(id);
      try {
        const terminal = await runtime.startExec(id, {
          cmd: ["sh", "-c", "sleep 317 & echo started; wait"],
          env: ["TERM=xterm-256color"],
          workingDir: "/",
        });
        let started = "";
        terminal.stream.on("data", (chunk: Buffer) => {
          started += chunk.toString("utf8");
        });
        await waitUntil(async () => started.includes("started"), "the terminal command to print");

        await terminal.kill();
        await waitUntil(async () => !(await terminal.inspect()).running, "the terminal command to stop");
        terminal.stream.destroy();
        expect(await shell(id, "ps | grep -c '[s]leep 317' || true")).toBe("0");
        await expect(terminal.kill()).resolves.toBeUndefined();
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
    "a followed log gives the tail, then the lines a running container writes, then its final partial line",
    async () => {
      const { id } = await runtime.createContainer({
        image: IMAGE,
        name: `${prefix}-follow`,
        labels: owned,
        cmd: ["sh", "-c", "echo one; echo two; sleep 2; echo three; printf partial; sleep 1"],
      });
      try {
        await runtime.startContainer(id);
        await waitUntil(
          async () => (await runtime.containerLogs(id, { tail: 10, timestamps: false })).includes("two\n"),
          "the second line",
        );

        const followed = drain(runtime.followLogs(id, { tail: 1, timestamps: false }));
        expect(await settleWithin(followed, 15_000)).toEqual(["two", "three", "partial"]);

        const stopped = await drain(runtime.followLogs(id, { tail: 2, timestamps: true }));
        expect(stopped.map((line) => line.replace(TIMESTAMP, ""))).toEqual(["three", "partial"]);
        expect(stopped.every((line) => TIMESTAMP.test(line))).toBe(true);
      } finally {
        await runtime.removeContainer(id, { force: true });
      }
    },
    LONG,
  );

  test(
    "a followed log with since leaves out the lines stamped before it, and keeps the line stamped in its millisecond",
    async () => {
      const { id } = await runtime.createContainer({
        image: IMAGE,
        name: `${prefix}-since`,
        labels: owned,
        cmd: ["sh", "-c", "echo one; sleep 1; echo two; sleep 1; echo three"],
      });
      try {
        await runtime.startContainer(id);
        await waitUntil(
          async () => (await runtime.containerLogs(id, { tail: 10, timestamps: false })).includes("three\n"),
          "the last line",
        );
        const two = (await runtime.containerLogs(id, { tail: 10, timestamps: true }))
          .split("\n")
          .find((line) => line.endsWith(" two"));
        const since = new Date(Date.parse(two?.split(" ")[0] ?? ""));

        expect(await drain(runtime.followLogs(id, { tail: 10, timestamps: false, since }))).toEqual(["two", "three"]);
      } finally {
        await runtime.removeContainer(id, { force: true });
      }
    },
    LONG,
  );

  test(
    "a followed log that is aborted ends at once, and a missing container is not_found",
    async () => {
      const { id } = await runtime.createContainer({
        image: IMAGE,
        name: `${prefix}-tick`,
        labels: owned,
        cmd: ["sh", "-c", "while true; do echo tick; sleep 0.2; done"],
      });
      try {
        await runtime.startContainer(id);
        const controller = new AbortController();
        const seen: string[] = [];
        const consumer = (async () => {
          for await (const line of runtime.followLogs(id, { tail: 0, timestamps: false, signal: controller.signal })) {
            seen.push(line);
            controller.abort();
          }
          return "ended";
        })();

        expect(await settleWithin(consumer, 10_000)).toBe("ended");
        expect(seen).toEqual(["tick"]);
        expect(
          await rejectionOf(drain(runtime.followLogs("no-such-container-xyz", { tail: 1, timestamps: false }))),
        ).toMatchObject({
          kind: "not_found",
        });
      } finally {
        await runtime.removeContainer(id, { force: true });
      }
    },
    LONG,
  );

  test(
    "events since a second before a change replay it, so a subscriber that starts after the change misses nothing",
    async () => {
      const { id } = await runtime.createContainer({ image: IMAGE, name: `${prefix}-replay`, labels: owned });
      try {
        const since = Math.floor(Date.now() / 1000) - 1;
        await runtime.startContainer(id);
        const controller = new AbortController();
        const seen: string[] = [];
        const consumer = (async () => {
          for await (const event of runtime.events({ labels: owned, since }, controller.signal)) {
            if (event.id === id) seen.push(event.action);
          }
          return "ended";
        })();

        await waitUntil(async () => seen.includes("start"), "the replayed start event");
        controller.abort();
        expect(await settleWithin(consumer, 5000)).toBe("ended");
      } finally {
        await runtime.removeContainer(id, { force: true });
      }
    },
    LONG,
  );

  test(
    "a box is written to, snapshotted, restored from the snapshot, promoted to a template and deleted",
    async () => {
      const restore = silenceLogs();
      try {
        const alpha = await boxes.createBox(host, { name: "a", image: IMAGE, cpus: 0.5, memoryMb: 64 });
        expect(alpha).toMatchObject({ running: true });
        expect(alpha.volume).toMatch(/^vol_/);
        expect(await runtime.inspectVolume(alpha.volume)).toMatchObject({ name: alpha.volume });
        expect(
          await rejectionOf(boxes.createBox(host, { name: "a", image: IMAGE, cpus: 0.5, memoryMb: 64 })),
        ).toMatchObject({ status: 409, key: "box_exists" });
        expect((await runtime.inspectContainer(alpha.id)).running).toBe(true);
        expect(await shell(alpha.id, "echo snapshot-marker > /opt/marker")).toBe("");

        const { ref } = await createSnapshot(host, alpha.id, "base");
        expect(ref).toMatch(new RegExp(`^${prefix}-snap:base-`));

        const beta = await boxes.createBox(host, { name: "b", image: ref, cpus: 0.5, memoryMb: 64 });
        expect(beta).toMatchObject({ running: true, template: ref });
        expect(await shell(beta.id, "cat /opt/marker")).toBe("snapshot-marker");

        const promoted = await promoteSnapshot(host, ref, "gold", "Gold");
        expect(promoted.ref).toBe(`${prefix}-template:gold`);
        expect((await runtime.inspectImage(promoted.ref)).labels).toMatchObject({
          [`${prefix}.template`]: "true",
          [`${prefix}.snapshot`]: "false",
        });

        expect(await boxes.deleteBox(host, alpha.id, true)).toEqual({ name: "a", volumeDeleted: true, trash: null });
        expect(await boxes.deleteBox(host, beta.id, true)).toEqual({ name: "b", volumeDeleted: true, trash: null });
        expect(await rejectionOf(runtime.inspectContainer(alpha.id))).toMatchObject({ kind: "not_found" });
        expect(await rejectionOf(runtime.inspectVolume(alpha.volume))).toMatchObject({ kind: "not_found" });

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
    "a value given to a box reaches neither a template saved from it nor a box made from that template",
    async () => {
      const restore = silenceLogs();
      try {
        const alpha = await boxes.createBox(host, { name: "env-a", image: IMAGE, cpus: 0.5, memoryMb: 64 });
        const given = await rebuildBox(
          host,
          alpha.boxId,
          alpha.revision,
          { env: [{ name: "MB_SCRUB_PROBE", value: "s3cret-probe-value" }] },
          true,
        );
        expect(await shell(given.id, "echo $MB_SCRUB_PROBE")).toBe("s3cret-probe-value");

        const saved = await saveBoxAsTemplate(host, given.boxId, { name: "scrubbed" }, "owner");

        const image = await runtime.inspectImage(saved.ref);
        expect(image.env.some((entry) => entry.includes("s3cret-probe-value"))).toBe(false);
        expect(image.env).toContain("MB_SCRUB_PROBE=");

        const beta = await boxes.createBox(host, { name: "env-b", image: saved.ref, cpus: 0.5, memoryMb: 64 });
        expect(await shell(beta.id, 'echo "[$MB_SCRUB_PROBE]"')).toBe("[]");

        expect(await boxes.deleteBox(host, given.boxId, true)).toEqual({
          name: "env-a",
          volumeDeleted: true,
          trash: null,
        });
        expect(await boxes.deleteBox(host, beta.id, true)).toEqual({ name: "env-b", volumeDeleted: true, trash: null });
        await deleteTemplate(host, saved.ref);
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

  test(
    "rebuilds keep to the attachment rules, and a volume MiniBox created can be attached",
    async () => {
      const restore = silenceLogs();
      const plain = `${prefix}-plain`;
      const managed = `${prefix}-extra`;
      try {
        const box = await boxes.createBox(host, { name: "guard", image: IMAGE, cpus: 0.5, memoryMb: 64 });
        const workspace = { volume: box.volume, path: "/workspace", mode: "rw" as const };
        await docker.createVolume({ Name: plain });

        const refused = (request: RebuildRequest) => rejectionOf(rebuildBox(host, box.id, box.revision, request, true));
        expect(await refused({ mounts: [workspace, { volume: plain, path: "/plain", mode: "ro" }] })).toMatchObject({
          status: 403,
          key: "volume_unmanaged",
          params: { volume: plain },
        });
        expect(
          await refused({ mounts: [workspace, { volume: "minibox-data", path: "/data", mode: "ro" }] }),
        ).toMatchObject({ status: 403, key: "volume_reserved" });
        expect(await refused({ network: "bridge" })).toMatchObject({ status: 403, key: "network_not_managed" });
        expect(await refused({ network: "host" })).toMatchObject({ status: 403, key: "network_reserved" });
        expect((await runtime.inspectContainer(box.id)).running).toBe(true);
        expect(host.specs.read(box.boxId)).toMatchObject({ revision: box.revision, network: host.security.network });

        await runtime.createVolume(managed, { [host.keys.box]: "true", [host.keys.name]: "guard" });
        const rebuilt = await rebuildBox(
          host,
          box.id,
          box.revision,
          { mounts: [workspace, { volume: managed, path: "/extra", mode: "ro" }] },
          true,
        );
        const mounted = (await docker.getContainer(rebuilt.id).inspect()).Mounts.map((mount) => mount.Name);
        expect(mounted).toEqual(expect.arrayContaining([workspace.volume, managed]));
        expect((await runtime.inspectContainer(rebuilt.id)).running).toBe(true);
        await boxes.deleteBox(host, rebuilt.id, true);
      } finally {
        await docker
          .getVolume(plain)
          .remove()
          .catch(() => {});
        restore();
      }
    },
    LONG,
  );

  test(
    "a box that runs its template tag is rebuilt onto the image the tag names after the tag moves",
    async () => {
      const restore = silenceLogs();
      const repo = `${prefix}-template`;
      const tag = `${repo}:moving`;
      try {
        await docker.getImage(IMAGE).tag({ repo, tag: "moving" });
        const box = await boxes.createBox(host, { name: "moving", image: tag, cpus: 0.5, memoryMb: 64 });
        const before = (await runtime.inspectContainer(box.id)).imageId;

        await runtime.commitContainer(box.id, {
          repo,
          tag: "moving",
          pause: true,
          changes: [`LABEL ${prefix}.moved=true`],
        });
        const moved = (await runtime.inspectImage(tag)).id;
        expect(moved).not.toBe(before);

        const preview = await rejectionOf(rebuildBox(host, box.id, box.revision, { template: tag }, false));
        expect(preview).toMatchObject({
          status: 409,
          key: "rebuild_confirm_required",
          details: {
            preview: {
              changes: expect.arrayContaining([
                {
                  field: "template",
                  from: `${tag} (${shortImageId(before)})`,
                  to: `${tag} (${shortImageId(moved)})`,
                },
              ]),
            },
          },
        });
        expect((await runtime.inspectContainer(box.id)).imageId).toBe(before);

        const rebuilt = await rebuildBox(host, box.id, box.revision, { template: tag }, true);
        expect(rebuilt).toMatchObject({ template: tag, image: tag, running: true, drift: [] });
        expect((await runtime.inspectContainer(rebuilt.id)).imageId).toBe(moved);
        expect(host.specs.read(box.boxId)?.template).toEqual({ ref: tag, image: tag, digest: moved });

        const again = await rejectionOf(rebuildBox(host, rebuilt.boxId, rebuilt.revision, { template: tag }, true));
        expect(again).toMatchObject({ status: 400, key: "rebuild_empty" });

        await boxes.deleteBox(host, rebuilt.id, true);
      } finally {
        await runtime.removeImage(tag, { force: true }).catch(() => {});
        restore();
      }
    },
    LONG,
  );

  test(
    "a secret reaches the box's environment, stays out of the engine labels and the spec, and a rotated value needs a rebuild",
    async () => {
      const restore = silenceLogs();
      const first = "secret-first-value";
      const second = "secret-second-value";
      try {
        host.secrets.set("vault", first, new Date().toISOString());
        const box = await boxes.createBox(host, {
          name: "envbox",
          image: IMAGE,
          cpus: 0.5,
          memoryMb: 64,
          profile: "standard",
          env: [
            { name: "TOKEN", secretRef: "vault" },
            { name: "GREETING", value: "hi there" },
          ],
        });
        expect(await shell(box.id, 'echo "$TOKEN|$GREETING"')).toBe(`${first}|hi there`);

        const engine = await docker.getContainer(box.id).inspect();
        expect(JSON.stringify(engine.Config.Labels)).not.toContain(first);
        expect(JSON.stringify(host.specs.read(box.boxId))).not.toContain(first);
        expect(await runtime.inspectEnv(box.id)).toEqual(expect.arrayContaining([`TOKEN=${first}`]));

        expect(await rejectionOf(rebuildBox(host, box.id, box.revision, {}, true))).toMatchObject({
          status: 400,
          key: "rebuild_empty",
        });
        host.secrets.set("vault", second, new Date().toISOString());
        const rebuilt = await rebuildBox(host, box.id, box.revision, {}, true);
        expect(await shell(rebuilt.id, 'echo "$TOKEN"')).toBe(second);
        expect(JSON.stringify(rebuilt)).not.toContain(second);

        await boxes.deleteBox(host, rebuilt.id, true);
      } finally {
        host.secrets.remove("vault");
        restore();
      }
    },
    LONG,
  );

  test(
    "another box's workspace, the data volume, pool roots and reserved names are refused on the real engine",
    async () => {
      const restore = silenceLogs();
      const pool = `${prefix}-pool-nfs`;
      const absent = `${prefix}-pool-absent`;
      const fresh = `${prefix}-ws-fresh`;
      try {
        const alpha = await boxes.createBox(host, { name: "owner-a", image: IMAGE, cpus: 0.5, memoryMb: 64 });
        const beta = await boxes.createBox(host, { name: "owner-b", image: IMAGE, cpus: 0.5, memoryMb: 64 });
        await docker.createVolume({ Name: pool, Labels: { ...owned, [host.keys.internal]: "true" } });
        const attempt = (mounts: BoxMount[]) => rejectionOf(rebuildBox(host, beta.id, beta.revision, { mounts }, true));

        expect(await attempt([{ volume: alpha.volume, path: "/workspace", mode: "rw" }])).toMatchObject({
          status: 403,
          key: "volume_in_use",
          params: { volume: "owner-a-workspace" },
        });
        expect(await attempt([{ volume: "minibox-data", path: "/data", mode: "ro" }])).toMatchObject({
          status: 403,
          key: "volume_reserved",
          params: { volume: "minibox-data" },
        });
        expect(await attempt([{ volume: pool, path: "/pool", mode: "rw" }])).toMatchObject({
          status: 403,
          key: "volume_reserved",
          params: { volume: pool },
        });
        expect(await attempt([{ volume: absent, path: "/pool", mode: "rw" }])).toMatchObject({
          status: 403,
          key: "volume_reserved",
          params: { volume: absent },
        });
        expect(await attempt([{ volume: fresh, path: "/fresh", mode: "rw" }])).toMatchObject({
          status: 403,
          key: "volume_reserved",
          params: { volume: fresh },
        });

        expect(await volumeExists(absent)).toBe(false);
        expect(await volumeExists(fresh)).toBe(false);
        expect((await runtime.inspectContainer(beta.id)).running).toBe(true);
        expect(host.specs.read(beta.boxId)?.revision).toBe(beta.revision);
        await boxes.deleteBox(host, alpha.id, true);
        await boxes.deleteBox(host, beta.id, true);
      } finally {
        await docker
          .getVolume(pool)
          .remove()
          .catch(() => {});
        restore();
      }
    },
    LONG,
  );

  test(
    "deleting a box removes the volumes it owns and keeps the shared tools volume and another box's volumes",
    async () => {
      const restore = silenceLogs();
      try {
        const alpha = await boxes.createBox(host, { name: "del-alpha", image: IMAGE, cpus: 0.5, memoryMb: 64 });
        const beta = await boxes.createBox(host, { name: "del-beta", image: IMAGE, cpus: 0.5, memoryMb: 64 });
        const toolsOf = (boxId: string) =>
          host.specs.read(boxId)?.mounts.find((mount) => mount.path === "/opt/minibox/tools")?.volume ?? "";
        const tools = toolsOf(alpha.boxId);
        expect(toolsOf(beta.boxId)).toBe(tools);
        const owned = (host.specs.read(alpha.boxId)?.mounts ?? [])
          .map((mount) => mount.volume)
          .filter((name) => name !== tools);
        expect(owned).toHaveLength(3);

        expect(await boxes.deleteBox(host, alpha.id, true)).toEqual({
          name: "del-alpha",
          volumeDeleted: true,
          trash: null,
        });
        for (const name of owned) expect(await volumeExists(name)).toBe(false);
        expect(host.volumes.findByEngine(host.host.id, alpha.volume)).toBeNull();
        expect(await volumeExists(tools)).toBe(true);
        expect(await volumeExists(beta.volume)).toBe(true);

        expect(await boxes.deleteBox(host, beta.id, true)).toEqual({
          name: "del-beta",
          volumeDeleted: true,
          trash: null,
        });
        expect(await volumeExists(beta.volume)).toBe(false);
        expect(await volumeExists(tools)).toBe(true);
      } finally {
        restore();
      }
    },
    LONG,
  );

  test(
    "a create the engine refuses leaves no volume, record, container or spec behind",
    async () => {
      const restore = silenceLogs();
      const broken = { ...host, security: { ...host.security, runtime: `${prefix}-missing-runtime` } };
      const volumeNames = async () =>
        ((await docker.listVolumes({ filters: { label: [`${prefix}=true`] } })).Volumes ?? [])
          .map((volume) => volume.Name)
          .toSorted();
      const recordIds = () =>
        host.volumes
          .list()
          .map((volume) => volume.id)
          .toSorted();
      try {
        const volumesBefore = await volumeNames();
        const recordsBefore = recordIds();
        const boxesBefore = await boxIds();

        const error = await rejectionOf(
          boxes.createBox(broken, { name: "rollback", image: IMAGE, cpus: 0.5, memoryMb: 64 }),
        );
        expect(error).toBeInstanceOf(Error);
        expect(await volumeNames()).toEqual(volumesBefore);
        expect(recordIds()).toEqual(recordsBefore);
        expect(await boxIds()).toEqual(boxesBefore);
        expect(host.specs.findByName("rollback")).toBeNull();
      } finally {
        restore();
      }
    },
    LONG,
  );

  test(
    "a standalone volume the engine lost is refused by measure and attach, and the engine does not recreate it",
    async () => {
      const restore = silenceLogs();
      try {
        const box = await boxes.createBox(host, { name: "gone-owner", image: IMAGE, cpus: 0.5, memoryMb: 64 });
        const notes = await createVolume(host, { name: `${prefix}-notes`, role: null, createdBy: "owner" });
        expect(await volumeExists(notes.engineName)).toBe(true);
        await runtime.removeVolume(notes.engineName);

        expect(await rejectionOf(measureVolume(host, notes.id))).toMatchObject({
          status: 409,
          key: "volume_missing",
          params: { volume: notes.name },
        });
        expect(await volumeExists(notes.engineName)).toBe(false);

        expect(
          await rejectionOf(
            attachVolume(
              host,
              notes.id,
              { box: box.boxId, path: "/srv/notes", mode: "rw", revision: box.revision, confirm: true },
              null,
            ),
          ),
        ).toMatchObject({ status: 409, key: "volume_missing", params: { volume: notes.name } });
        expect(await volumeExists(notes.engineName)).toBe(false);
        expect((await runtime.inspectContainer(box.id)).running).toBe(true);
        await boxes.deleteBox(host, box.id, true);
      } finally {
        restore();
      }
    },
    LONG,
  );

  test(
    "a create after the engine lost the shared tools volume recreates it under the same record, labelled and handed to uid 1000",
    async () => {
      const restore = silenceLogs();
      const base = `${prefix}-template`;
      let second: boxes.Box | undefined;
      try {
        const { id: seed } = await runtime.createContainer({
          image: IMAGE,
          name: `${prefix}-tools-seed`,
          cmd: ["sleep", "300"],
          labels: owned,
        });
        await runtime.startContainer(seed);
        await runtime.commitContainer(seed, { repo: base, tag: "base", pause: true, changes: [] });
        await runtime.removeContainer(seed, { force: true });

        const first = await boxes.createBox(host, { name: "tools-first", image: IMAGE, cpus: 0.5, memoryMb: 64 });
        const toolsOf = (boxId: string) =>
          host.specs.read(boxId)?.mounts.find((mount) => mount.path === "/opt/minibox/tools")?.volume ?? "";
        const toolsEngine = toolsOf(first.boxId);
        const tools = host.volumes.findByEngine(host.host.id, toolsEngine);
        if (!tools) throw new Error("the shared tools record is missing");
        await boxes.deleteBox(host, first.id, false);
        await runtime.removeVolume(toolsEngine);
        expect(await volumeExists(toolsEngine)).toBe(false);

        second = await boxes.createBox(host, { name: "tools-second", image: IMAGE, cpus: 0.5, memoryMb: 64 });
        expect(toolsOf(second.boxId)).toBe(toolsEngine);
        expect(await volumeExists(toolsEngine)).toBe(true);
        expect((await docker.getVolume(toolsEngine).inspect()).Labels).toMatchObject(labelsFor(host, tools));
        expect(host.volumes.read(tools.id)).toEqual(tools);
        expect(await rootOwnerOf(host, toolsEngine)).toEqual({ uid: 1000, gid: 1000 });
        expect(
          await shell(second.id, "touch /opt/minibox/tools/probe 2>/dev/null && echo writable || echo read-only"),
        ).toBe("read-only");
        expect(host.activity.list()).toContainEqual(
          expect.objectContaining({ action: "volume.recreate", target: tools.name, ok: true }),
        );
      } finally {
        if (second) await boxes.deleteBox(host, second.id, true).catch(() => {});
        await runtime.removeImage(`${base}:base`, { force: true }).catch(() => {});
        restore();
      }
    },
    LONG,
  );

  test(
    "helpers return their output and exit code, and none is left behind",
    async () => {
      for (let i = 0; i < 5; i++) {
        expect(await runtime.runHelper({ image: IMAGE, cmd: ["sh", "-c", `echo run-${i}`] })).toEqual({
          exitCode: 0,
          logs: `run-${i}\n`,
        });
      }
      expect(await runtime.runHelper({ image: IMAGE, cmd: ["sh", "-c", "echo failed >&2; exit 3"] })).toEqual({
        exitCode: 3,
        logs: "failed\n",
      });
      expect(await runtime.runHelper({ image: IMAGE, cmd: ["sleep", "30"], timeoutSec: 1 })).toEqual({
        exitCode: 124,
        logs: "",
      });
      const leftover = (await docker.listContainers({ all: true })).filter((c) =>
        c.Names.some((name) => name.startsWith("/mbxhlp")),
      );
      expect(leftover).toEqual([]);
    },
    LONG,
  );

  test(
    "a helper has no network, a read-only root, only the capabilities it names, and cannot gain privileges",
    async () => {
      const probe = [
        "awk '/^(CapBnd|CapEff|NoNewPrivs):/ {print $1, $2}' /proc/self/status",
        "echo nics=$(ls /sys/class/net)",
        "touch /rootfile 2>/dev/null && echo rootfs=writable || echo rootfs=read-only",
        "touch /tmp/scratch 2>/dev/null && echo tmp=writable || echo tmp=read-only",
        "echo pids=$(cat /sys/fs/cgroup/pids.max)",
        "echo memory=$(cat /sys/fs/cgroup/memory.max)",
      ].join("; ");
      const root = await runtime.runHelper({
        image: IMAGE,
        user: "0:0",
        capAdd: ["CHOWN"],
        cmd: ["sh", "-c", probe],
      });
      expect(root.exitCode).toBe(0);
      const lines = root.logs.split("\n");
      for (const line of [
        "CapBnd: 0000000000000001",
        "CapEff: 0000000000000001",
        "NoNewPrivs: 1",
        "nics=lo",
        "rootfs=read-only",
        "tmp=writable",
        "pids=64",
        "memory=268435456",
      ]) {
        expect(lines).toContain(line);
      }

      const plain = await runtime.runHelper({ image: IMAGE, user: "1000:1000", cmd: ["sh", "-c", probe] });
      expect(plain.logs).toContain("CapBnd: 0000000000000000");
      expect(plain.logs).toContain("CapEff: 0000000000000000");
    },
    LONG,
  );

  test(
    "a root helper without DAC_OVERRIDE cannot write into a directory owned by someone else, and CHOWN still works",
    async () => {
      const volume = `${prefix}-helper-owner`;
      await runtime.createVolume(volume, owned);
      try {
        const mounts = [{ source: volume, target: "/mnt" }];
        const chown = await runtime.runHelper({
          image: IMAGE,
          user: "0:0",
          capAdd: ["CHOWN"],
          mounts,
          cmd: ["chown", "1000:1000", "/mnt"],
        });
        expect(chown.exitCode).toBe(0);

        const denied = await runtime.runHelper({ image: IMAGE, user: "0:0", mounts, cmd: ["mkdir", "/mnt/denied"] });
        expect(denied.exitCode).not.toBe(0);
        expect(denied.logs).toContain("Permission denied");

        const allowed = await runtime.runHelper({
          image: IMAGE,
          user: "0:0",
          capAdd: ["DAC_OVERRIDE"],
          mounts,
          cmd: ["sh", "-c", "mkdir /mnt/allowed && rmdir /mnt/allowed"],
        });
        expect(allowed).toEqual({ exitCode: 0, logs: "" });
        const owner = await runtime.runHelper({
          image: IMAGE,
          user: "1000:1000",
          mounts,
          cmd: ["stat", "-c", "%u:%g", "/mnt"],
        });
        expect(owner.logs.trim()).toBe("1000:1000");
      } finally {
        await docker
          .getVolume(volume)
          .remove()
          .catch(() => {});
      }
    },
    LONG,
  );

  test(
    "a helper that mounts an empty volume where the image has a directory leaves the volume's owner alone",
    async () => {
      const volume = `${prefix}-helper-nocopy`;
      await runtime.createVolume(volume, owned);
      try {
        const chown = await runtime.runHelper({
          image: IMAGE,
          user: "0:0",
          capAdd: ["CHOWN"],
          mounts: [{ source: volume, target: "/mnt/0" }],
          cmd: ["chown", "1000:1000", "/mnt/0"],
        });
        expect(chown.exitCode).toBe(0);

        // The image's /mnt is root-owned. Without NoCopy Docker would copy that over the still-empty volume here.
        const seen = await runtime.runHelper({
          image: IMAGE,
          user: "0:0",
          mounts: [{ source: volume, target: "/mnt" }],
          cmd: ["stat", "-c", "%u:%g", "/mnt"],
        });
        expect(seen).toEqual({ exitCode: 0, logs: "1000:1000\n" });
      } finally {
        await docker
          .getVolume(volume)
          .remove()
          .catch(() => {});
      }
    },
    LONG,
  );

  test(
    "measuring reads another owner's directory only with DAC_READ_SEARCH",
    async () => {
      const volume = `${prefix}-helper-measure`;
      await runtime.createVolume(volume, owned);
      try {
        const mounts = [{ source: volume, target: "/mnt" }];
        const setup = await runtime.runHelper({
          image: IMAGE,
          user: "0:0",
          capAdd: ["CHOWN"],
          mounts,
          cmd: ["sh", "-c", "mkdir /mnt/private && chmod 700 /mnt/private && chown 1000:1000 /mnt/private"],
        });
        expect(setup.exitCode).toBe(0);

        const blind = await runtime.runHelper({ image: IMAGE, user: "0:0", mounts, cmd: ["du", "-sb", "/mnt"] });
        expect(blind.exitCode).not.toBe(0);
        const reading = await runtime.runHelper({
          image: IMAGE,
          user: "0:0",
          capAdd: ["DAC_READ_SEARCH"],
          mounts,
          cmd: ["du", "-sb", "/mnt"],
        });
        expect(reading.exitCode).toBe(0);
        expect(reading.logs).toMatch(/^\d+\t\/mnt\n$/);
      } finally {
        await docker
          .getVolume(volume)
          .remove()
          .catch(() => {});
      }
    },
    LONG,
  );

  test(
    "the engine removes a helper container by itself once it exits",
    async () => {
      const name = `mbxhlp${prefix.slice(-8)}auto`;
      const exists = async (id: string) =>
        docker
          .getContainer(id)
          .inspect()
          .then(
            () => true,
            () => false,
          );
      const created = await docker.createContainer(toHelperOptions({ image: IMAGE, cmd: ["true"] }, name));
      const container = docker.getContainer(created.id);
      const exited = container.wait({ condition: "next-exit" });
      await container.start();
      await exited;
      await waitUntil(async () => !(await exists(created.id)), "the engine to remove the exited helper");
    },
    LONG,
  );
});

/** Counts the calls made through a runtime, by operation. The calls reach the engine unchanged. */
function countingRuntime(target: Runtime): {
  runtime: Runtime;
  count: (op: keyof Runtime) => number;
  reset: () => void;
} {
  const counts = new Map<string, number>();
  const runtime = new Proxy(target, {
    get(obj, prop) {
      const value: unknown = Reflect.get(obj, prop, obj);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        counts.set(String(prop), (counts.get(String(prop)) ?? 0) + 1);
        return Reflect.apply(value, obj, args);
      };
    },
  });
  return { runtime, count: (op) => counts.get(op) ?? 0, reset: () => counts.clear() };
}

/**
 * A stream replays the last second or so of events when it opens, and the cache applies them after its first listing.
 * Waiting that out keeps the replayed reads out of the counts.
 */
async function quiesce(sampler: HostSampler): Promise<void> {
  await Bun.sleep(1_500);
  await sampler.settle();
}

describe.skipIf(!enabled)("the box cache against a real engine", () => {
  test(
    "listing boxes and their usage costs the engine nothing, however many boxes exist",
    async () => {
      const restore = silenceLogs();
      const counter = countingRuntime(runtime);
      const reader = createLocalHost(cfg, counter.runtime, host.specs);
      const made: boxes.Box[] = [];
      const cachedRunning = (box: boxes.Box) => reader.sampler.find(box.boxId)?.running === true;
      const engineReads = () =>
        counter.count("listContainers") + counter.count("inspectContainer") + counter.count("containerStats");
      try {
        for (const name of ["cache-a", "cache-b", "cache-c"]) {
          made.push(await boxes.createBox(host, { name, image: IMAGE, cpus: 0.5, memoryMb: 64 }));
        }
        reader.sampler.start();
        await waitUntil(
          async () => reader.sampler.ready() && made.every(cachedRunning),
          "the first boxes in the cache",
        );
        await quiesce(reader.sampler);
        // Boxes that earlier tests left running are in the cache too, so the totals count from what it already holds.
        const known = reader.sampler.boxes({ withStats: false }).length;
        // A read of usage after an idle sampler samples once; the listings after it are served from that sample.
        await reader.sampler.sampleNow();
        counter.reset();
        for (let tab = 0; tab < 10; tab++) await boxes.listBoxes(reader, { withStats: true });
        expect(engineReads()).toBe(0);

        for (const name of ["cache-d", "cache-e", "cache-f", "cache-g", "cache-h"]) {
          made.push(await boxes.createBox(host, { name, image: IMAGE, cpus: 0.5, memoryMb: 64 }));
        }
        await waitUntil(async () => made.every(cachedRunning), "the new boxes in the cache");
        await quiesce(reader.sampler);
        counter.reset();

        await reader.sampler.sampleNow();
        const running = reader.sampler.boxes({ withStats: false }).filter((box) => box.running).length;
        expect(running).toBeGreaterThan(0);
        expect(counter.count("containerStats")).toBe(running);

        counter.reset();
        let listed: boxes.Box[] = [];
        for (let tab = 0; tab < 10; tab++) listed = await boxes.listBoxes(reader, { withStats: true });
        expect(listed).toHaveLength(known + 5);
        expect(engineReads()).toBe(0);
        expect(listed.filter((box) => box.running).every((box) => box.stats !== null)).toBe(true);
      } finally {
        reader.sampler.stop();
        for (const box of made) await boxes.deleteBox(host, box.id, true).catch(() => {});
        restore();
      }
    },
    LONG,
  );

  test(
    "a box stopped outside MiniBox reaches the cache through the engine's events, not a listing",
    async () => {
      const restore = silenceLogs();
      const counter = countingRuntime(runtime);
      const reader = createLocalHost(cfg, counter.runtime, host.specs);
      const made: boxes.Box[] = [];
      try {
        const box = await boxes.createBox(host, { name: "cache-stop", image: IMAGE, cpus: 0.5, memoryMb: 64 });
        made.push(box);
        reader.sampler.start();
        await waitUntil(async () => reader.sampler.find(box.boxId)?.running === true, "the box in the cache");
        counter.reset();

        await runtime.stopContainer(box.id, { timeoutSec: 1 });
        await waitUntil(async () => reader.sampler.find(box.boxId)?.running === false, "the stop in the cache");
        expect(counter.count("listContainers")).toBe(0);
        expect(counter.count("inspectContainer")).toBeGreaterThan(0);
      } finally {
        reader.sampler.stop();
        for (const box of made) await boxes.deleteBox(host, box.id, true).catch(() => {});
        restore();
      }
    },
    LONG,
  );
});

/** Ids of every container on the engine, MiniBox's or not. */
const allContainerIds = async (): Promise<string[]> => (await docker.listContainers({ all: true })).map((c) => c.Id);

describe.skipIf(!enabled)("volume root owners against a real engine", () => {
  const MOUNT = "/minibox-volume";

  test(
    "the root owner of a volume is read and set, and what the volume holds keeps its owners",
    async () => {
      const restore = silenceLogs();
      const volume = `${prefix}-owner`;
      try {
        await runtime.createVolume(volume, owned);
        const { id } = await runtime.createContainer({
          image: IMAGE,
          name: `${prefix}-owner`,
          cmd: ["sleep", "300"],
          labels: owned,
          mounts: [{ source: volume, target: MOUNT }],
        });
        expect(await runtime.volumeRootOwner(id, MOUNT)).toEqual({ uid: 0, gid: 0 });
        expect(await rejectionOf(runtime.volumeRootOwner(id, "/minibox-absent"))).toMatchObject({ kind: "not_found" });

        await runtime.startContainer(id);
        await shell(id, `mkdir ${MOUNT}/sub && touch ${MOUNT}/seed ${MOUNT}/sub/inner`);
        await runtime.setVolumeRootOwner(volume, { uid: 1000, gid: 1000 }, IMAGE);

        expect(await runtime.volumeRootOwner(id, MOUNT)).toEqual({ uid: 1000, gid: 1000 });
        expect(await shell(id, `stat -c '%u:%g %n' ${MOUNT} ${MOUNT}/seed ${MOUNT}/sub ${MOUNT}/sub/inner`)).toBe(
          [`1000:1000 ${MOUNT}`, `0:0 ${MOUNT}/seed`, `0:0 ${MOUNT}/sub`, `0:0 ${MOUNT}/sub/inner`].join("\n"),
        );
      } finally {
        restore();
      }
    },
    LONG,
  );

  test(
    "setting the owner of a volume that does not exist is not_found, and leaves no volume or helper behind",
    async () => {
      const missing = `${prefix}-missing`;
      const before = await allContainerIds();

      expect(await rejectionOf(runtime.setVolumeRootOwner(missing, { uid: 1000, gid: 1000 }, IMAGE))).toMatchObject({
        kind: "not_found",
      });
      expect(await rejectionOf(runtime.inspectVolume(missing))).toMatchObject({ kind: "not_found" });
      expect(await allContainerIds()).toEqual(before);
    },
    LONG,
  );

  test(
    "a helper that cannot run chown is an engine error, and the helper is removed",
    async () => {
      const restore = silenceLogs();
      const repo = `${prefix}-nochown`;
      const volume = `${prefix}-nochown`;
      try {
        const { id } = await runtime.createContainer({
          image: IMAGE,
          name: repo,
          cmd: ["sleep", "300"],
          labels: owned,
        });
        await runtime.startContainer(id);
        expect(await shell(id, "rm -f /bin/chown /usr/bin/chown; command -v chown || echo gone")).toBe("gone");
        await runtime.commitContainer(id, { repo, tag: "1", pause: true, changes: [] });
        await runtime.createVolume(volume, owned);

        const failed = await rejectionOf(runtime.setVolumeRootOwner(volume, { uid: 1000, gid: 1000 }, `${repo}:1`));
        expect(failed).toMatchObject({ kind: "engine" });
        const leftover = (await docker.listContainers({ all: true })).filter((c) =>
          c.Mounts.some((mount) => mount.Name === volume),
        );
        expect(leftover).toHaveLength(0);
      } finally {
        await runtime.removeImage(`${repo}:1`, { force: true }).catch(() => {});
        restore();
      }
    },
    LONG,
  );
});

describe.skipIf(!enabled)("the box user's write check against a real engine", () => {
  const MOUNT = "/mnt";

  test(
    "uid 1000 cannot write a new volume root, and can once the root is handed to uid 1000",
    async () => {
      const volume = `${prefix}-writable`;
      try {
        await runtime.createVolume(volume, owned);
        const check = () =>
          runtime.runHelper({
            image: IMAGE,
            user: DEV_OWNER,
            cmd: ["sh", "-c", WRITE_CHECK, "minibox", MOUNT],
            mounts: [{ source: volume, target: MOUNT }],
            labels: owned,
            timeoutSec: 30,
          });

        const refused = await check();
        expect(refused.exitCode).not.toBe(0);
        expect(refused.logs).toMatch(/permission denied/i);

        await runtime.setVolumeRootOwner(volume, { uid: 1000, gid: 1000 }, IMAGE);
        expect(await check()).toMatchObject({ exitCode: 0 });
      } finally {
        await runtime.removeVolume(volume).catch(() => {});
      }
    },
    LONG,
  );
});

describe.skipIf(!enabled)("workspace root owner on create and rebuild against a real engine", () => {
  const dev = `${prefix}-dev`;
  const devTemplate = `${dev}:1`;

  /** A dev template: user dev at uid and gid 1000, a /workspace that user owns, and the labels that name that owner. */
  async function buildDevTemplate(): Promise<void> {
    const { id } = await runtime.createContainer({
      image: IMAGE,
      name: `${prefix}-dev-builder`,
      cmd: ["sleep", "300"],
      labels: owned,
    });
    try {
      await runtime.startContainer(id);
      const built = await shell(
        id,
        "addgroup -g 1000 dev && adduser -D -u 1000 -G dev dev && mkdir /workspace && chown 1000:1000 /workspace && echo built",
      );
      expect(built).toBe("built");
      await runtime.commitContainer(id, {
        repo: dev,
        tag: "1",
        pause: true,
        changes: ['LABEL minibox.template.uid="1000"', 'LABEL minibox.template.gid="1000"', "USER dev"],
      });
    } finally {
      await runtime.removeContainer(id, { force: true });
    }
  }

  beforeAll(buildDevTemplate, LONG);
  afterAll(async () => {
    await runtime.removeImage(devTemplate, { force: true }).catch(() => {});
  });

  test(
    "a box created onto the dev template reuses a populated, root-owned workspace and hands its root to the template's owner",
    async () => {
      const restore = silenceLogs();
      const name = "reuse";
      const volume = `${prefix}-ws-${name}`;
      let box: boxes.Box | undefined;
      try {
        await runtime.createVolume(volume, { [host.keys.box]: "true", [host.keys.name]: name });
        const { id: holder } = await runtime.createContainer({
          image: IMAGE,
          name: `${prefix}-holder-${name}`,
          cmd: ["sleep", "300"],
          labels: owned,
          mounts: [{ source: volume, target: "/workspace" }],
        });
        await runtime.startContainer(holder);
        await shell(holder, "touch /workspace/seed");
        expect(await runtime.volumeRootOwner(holder, "/workspace")).toEqual({ uid: 0, gid: 0 });
        await runtime.removeContainer(holder, { force: true });

        box = await boxes.createBox(host, { name, image: devTemplate, cpus: 0.5, memoryMb: 64 });
        expect(await runtime.volumeRootOwner(box.id, "/workspace")).toEqual({ uid: 1000, gid: 1000 });
        expect(await shell(box.id, "id -u && touch /workspace/written && echo written")).toBe("1000\nwritten");
      } finally {
        if (box) await boxes.deleteBox(host, box.id, true).catch(() => {});
        restore();
      }
    },
    LONG,
  );

  test(
    "a fresh workspace volume takes the template's owner at copy-up, so create reads the root and sets nothing",
    async () => {
      const restore = silenceLogs();
      const counter = countingRuntime(runtime);
      const counted = createLocalHost(cfg, counter.runtime, host.specs);
      let box: boxes.Box | undefined;
      try {
        box = await boxes.createBox(counted, { name: "copy-up", image: devTemplate, cpus: 0.5, memoryMb: 64 });
        expect(counter.count("volumeRootOwner")).toBe(1);
        expect(counter.count("setVolumeRootOwner")).toBe(0);
        expect(await runtime.volumeRootOwner(box.id, "/workspace")).toEqual({ uid: 1000, gid: 1000 });
      } finally {
        if (box) await boxes.deleteBox(host, box.id, true).catch(() => {});
        restore();
      }
    },
    LONG,
  );

  test(
    "a rebuild onto the dev template hands the root of a populated, root-owned workspace to the template's owner",
    async () => {
      const restore = silenceLogs();
      let box: boxes.Box | undefined;
      try {
        box = await boxes.createBox(host, { name: "onto-dev", image: IMAGE, cpus: 0.5, memoryMb: 64 });
        await shell(box.id, "touch /workspace/seed");
        expect(await runtime.volumeRootOwner(box.id, "/workspace")).toEqual({ uid: 0, gid: 0 });

        const rebuilt = await rebuildBox(host, box.id, box.revision, { template: devTemplate }, true);
        box = rebuilt;
        expect(rebuilt).toMatchObject({ template: devTemplate, running: true });
        expect(await runtime.volumeRootOwner(rebuilt.id, "/workspace")).toEqual({ uid: 1000, gid: 1000 });
        expect(
          await shell(rebuilt.id, "id -u && touch /workspace/written && test -f /workspace/seed && echo kept"),
        ).toBe("1000\nkept");
      } finally {
        if (box) await boxes.deleteBox(host, box.id, true).catch(() => {});
        restore();
      }
    },
    LONG,
  );
});
