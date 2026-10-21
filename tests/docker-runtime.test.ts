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
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Docker from "dockerode";

import { BOX_PROFILES, type BoxProfile } from "../src/box-profile";
import { createDockerRuntime } from "../src/docker/runtime";
import { OutputStore } from "../src/events/outputs";
import { createRedactor } from "../src/events/redact";
import { createLocalHost } from "../src/host/registry";
import type { HostSampler } from "../src/host/sampler";
import type { Runtime } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { ExecManager } from "../src/services/exec";
import { rebuildBox } from "../src/services/rebuild";
import { createSnapshot, deleteSnapshot } from "../src/services/snapshots";
import { deleteTemplate, promoteSnapshot } from "../src/services/templates";
import type { RebuildRequest } from "../src/specs/plan";
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

/** CapBnd and NoNewPrivs each profile must produce inside a box (docs/design.md §14). */
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
        expect(alpha).toMatchObject({ running: true, volume: `${prefix}-ws-a` });
        expect(await runtime.inspectVolume(`${prefix}-ws-a`)).toMatchObject({ name: `${prefix}-ws-a` });
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

        expect(await boxes.deleteBox(host, alpha.id, true)).toEqual({ name: "a", volumeDeleted: true });
        expect(await boxes.deleteBox(host, beta.id, true)).toEqual({ name: "b", volumeDeleted: true });
        expect(await rejectionOf(runtime.inspectContainer(alpha.id))).toMatchObject({ kind: "not_found" });
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

  test(
    "rebuilds keep to the attachment rules, and a volume MiniBox created can be attached",
    async () => {
      const restore = silenceLogs();
      const plain = `${prefix}-plain`;
      const managed = `${prefix}-extra`;
      try {
        const box = await boxes.createBox(host, { name: "guard", image: IMAGE, cpus: 0.5, memoryMb: 64 });
        const workspace = { volume: `${prefix}-ws-guard`, path: "/workspace", mode: "rw" as const };
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
