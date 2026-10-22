/**
 * The startup command against a real engine: it runs when a box is created, started, restarted and woken from idle sleep;
 * a command that fails does not stop a start; and a change made while the box is stopped applies at its next start.
 *
 *   bun run test:docker
 *
 * That script (scripts/docker-integration.ts) picks the label prefix and sweeps what the run left behind. To run this
 * file directly: MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbit<id> bun test tests/docker-startup-command.test.ts
 *
 * Boxes run the image built from tests/fixtures/tmux, which has bash, tmux and the dev user the command runs as.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Docker from "dockerode";

import { type App, createApp } from "../src/app";
import { createDockerRuntime } from "../src/docker/runtime";
import type { HostCtx } from "../src/host/registry";
import type { Runtime } from "../src/runtime";
import { type Box, createBox, getBox, restartBox, startBox, stopBox, wakeIfSleeping } from "../src/services/boxes";
import {
  clearStartupCommand,
  readStartupCommand,
  runStartupCommand,
  setStartupCommand,
  type StartupCommandState,
} from "../src/services/startup-command";
import { INIT_SESSION } from "../src/startup/command";
import { testConfig } from "./support/app";

const enabled = process.env.MINIBOX_TEST_DOCKER === "1";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const PREFIX_PATTERN = /^mbit[a-z0-9-]{3,40}$/;
const prefix = process.env.MINIBOX_TEST_PREFIX ?? `mbit${Date.now().toString(36)}`;
if (enabled && !PREFIX_PATTERN.test(prefix)) throw new Error(`MINIBOX_TEST_PREFIX must match ${PREFIX_PATTERN}`);
const FIXTURE = `${prefix}-tmux:fixture`;
const MARKS = "/workspace/marks.txt";
const owned = { [prefix]: "true" };
const runtime: Runtime = createDockerRuntime(SOCKET);
const docker = new Docker({ socketPath: SOCKET });

let app: App;
let host: HostCtx;

beforeAll(async () => {
  if (!enabled) return;
  const cfg = testConfig({
    labelPrefix: prefix,
    dockerSocket: SOCKET,
    baseTemplateTag: `${prefix}-template:base`,
    dataDir: mkdtempSync(join(tmpdir(), "minibox-startup-test-")),
  });
  app = createApp(cfg, "0.0.0-test", { runtime, eventsPath: ":memory:" });
  host = app.hosts.get();
  await runtime.buildImage({
    contextDir: join(import.meta.dir, "fixtures", "tmux"),
    dockerfile: "Dockerfile",
    tag: FIXTURE,
    labels: owned,
  });
}, 300_000);

afterAll(async () => {
  if (!enabled) return;
  app?.sessions.stop();
  for (const c of await runtime.listContainers({ labels: owned })) {
    await runtime.removeContainer(c.id, { force: true }).catch(() => {});
  }
  for (const img of await runtime.listImages({ labels: owned })) {
    await runtime.removeImage(img.id, { force: true }).catch(() => {});
  }
  const { Volumes } = await docker.listVolumes({ filters: { label: [`${prefix}=true`] } });
  for (const volume of Volumes ?? [])
    await docker
      .getVolume(volume.Name)
      .remove()
      .catch(() => {});
  if (host)
    await docker
      .getNetwork(host.security.network)
      .remove()
      .catch(() => {});
});

async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

/** Runs a shell snippet in the box as dev and returns what it printed. The exec is finished before this returns. */
async function shell(id: string, script: string): Promise<string> {
  const exec = await runtime.startExec(id, {
    cmd: ["sh", "-c", `${script}; echo MB_DONE`],
    env: ["TERM=dumb"],
    workingDir: "/",
    user: "dev",
  });
  let text = "";
  exec.stream.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  try {
    await waitFor(() => text.includes("MB_DONE"), "the command output");
    await waitFor(async () => !(await exec.inspect()).running, "the command to end");
  } finally {
    exec.stream.destroy();
  }
  return text.slice(0, text.indexOf("MB_DONE")).replace(/\r/g, "").trim();
}

/** The lines the command has written to the marker file, one per run. */
async function marks(box: Box): Promise<string[]> {
  return (await shell(box.id, `cat ${MARKS} 2>/dev/null || true`)).split("\n").filter(Boolean);
}

async function waitForMarks(box: Box, count: number): Promise<void> {
  await waitFor(async () => (await marks(box)).length >= count, `${count} run(s) of the command`);
}

async function stateOf(box: Box): Promise<StartupCommandState> {
  return readStartupCommand(host, box.boxId);
}

/** Creates a box that runs `command` at every start. The command is run as dev, in /workspace. */
async function newBox(name: string, command: string): Promise<Box> {
  return createBox(host, { name, image: FIXTURE, cpus: 0.5, memoryMb: 128, startupCommand: command });
}

describe.skipIf(!enabled)("startup command on a real engine", () => {
  test("it runs when the box is created, started, restarted and woken from idle sleep", async () => {
    const box = await newBox("init-cycle", `echo first >> ${MARKS}; sleep 600`);
    await waitForMarks(box, 1);
    expect(await stateOf(box)).toMatchObject({ status: "running", command: `echo first >> ${MARKS}; sleep 600` });
    expect((await getBox(host, box.boxId)).running).toBe(true);

    await stopBox(host, box.boxId);
    expect(await stateOf(box)).toMatchObject({ status: "waiting" });
    await startBox(host, box.boxId);
    await waitForMarks(box, 2);

    await restartBox(host, box.boxId);
    await waitForMarks(box, 3);

    await stopBox(host, box.boxId, "idle");
    await wakeIfSleeping(host, box.boxId);
    await waitForMarks(box, 4);

    expect(await marks(box)).toEqual(["first", "first", "first", "first"]);
    expect(await stateOf(box)).toMatchObject({ status: "running" });
    expect(await shell(box.id, `tmux -u has-session -t '=${INIT_SESSION}' 2>/dev/null && echo yes || echo no`)).toBe(
      "yes",
    );
  });

  test("a command that fails does not stop the box starting, and its exit code and output are kept", async () => {
    const box = await newBox("init-fail", "echo before-the-failure; exit 7");
    expect((await getBox(host, box.boxId)).running).toBe(true);
    await waitFor(async () => (await stateOf(box)).status === "exited", "the failing run to end");
    expect(await stateOf(box)).toMatchObject({
      status: "exited",
      exitCode: 7,
      log: expect.arrayContaining(["before-the-failure"]),
    });

    await stopBox(host, box.boxId);
    await startBox(host, box.boxId);
    expect((await getBox(host, box.boxId)).running).toBe(true);
    await waitFor(async () => (await stateOf(box)).status === "exited", "the second failing run to end");
    expect(await stateOf(box)).toMatchObject({ status: "exited", exitCode: 7 });
  });

  test("a command set or removed while the box is stopped takes effect at its next start", async () => {
    const box = await newBox("init-edit", `echo old >> ${MARKS}; sleep 600`);
    await waitForMarks(box, 1);

    await stopBox(host, box.boxId);
    const before = await stateOf(box);
    const changed = await setStartupCommand(host, box.boxId, {
      command: `echo new >> ${MARKS}; sleep 600`,
      expectedRevision: before.revision,
    });
    expect((await getBox(host, box.boxId)).running).toBe(false);
    expect(changed).toMatchObject({ status: "waiting", command: `echo new >> ${MARKS}; sleep 600` });

    await startBox(host, box.boxId);
    await waitForMarks(box, 2);
    expect(await marks(box)).toEqual(["old", "new"]);

    await stopBox(host, box.boxId);
    const cleared = await clearStartupCommand(host, box.boxId, (await stateOf(box)).revision);
    expect(cleared).toMatchObject({ command: null, status: "none" });

    await startBox(host, box.boxId);
    await Bun.sleep(500);
    expect(await marks(box)).toEqual(["old", "new"]);
    expect(await stateOf(box)).toMatchObject({ command: null, status: "none" });
    expect(await shell(box.id, `tmux -u has-session -t '=${INIT_SESSION}' 2>/dev/null && echo yes || echo no`)).toBe(
      "no",
    );
  });

  test("applying a change to a running box runs the new command at once, and run runs it again", async () => {
    const box = await newBox("init-apply", `echo one >> ${MARKS}; sleep 600`);
    await waitForMarks(box, 1);

    const current = await stateOf(box);
    const applied = await setStartupCommand(host, box.boxId, {
      command: `echo two >> ${MARKS}; sleep 600`,
      applyNow: true,
      expectedRevision: current.revision,
    });
    expect(applied).toMatchObject({ command: `echo two >> ${MARKS}; sleep 600` });
    await waitForMarks(box, 2);

    await runStartupCommand(host, box.boxId);
    await waitForMarks(box, 3);
    expect(await marks(box)).toEqual(["one", "two", "two"]);
    expect(await stateOf(box)).toMatchObject({ status: "running" });
  });
});
