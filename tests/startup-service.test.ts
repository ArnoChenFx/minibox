import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import { msg } from "../src/lib/messages";
import type { ExecSpec } from "../src/runtime";
import { RuntimeError } from "../src/runtime";
import {
  type Box,
  createBox,
  getBox,
  restartBox,
  sleepBox,
  startBox,
  stopBox,
  wakeIfSleeping,
} from "../src/services/boxes";
import { rebuildBox } from "../src/services/rebuild";
import { reconcileHost } from "../src/services/reconcile";
import { finishSetup, runNow, scheduleStartup } from "../src/services/startup";
import {
  clearStartupCommand,
  readStartupCommand,
  runStartupCommand,
  setStartupCommand,
} from "../src/services/startup-command";
import type { BoxRecovery, BoxSpec } from "../src/specs/types";
import { digestOf, encodeCommand, INIT_SESSION, RUNNER_SCRIPT, TREE_SWEEP_SCRIPT } from "../src/startup/command";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

const STARTED_AT = "2026-10-22T12:00:00Z";
const EXITED_AT = "2026-10-22T12:00:03Z";

let app: App;
let runtime: FakeRuntime;
let host: HostCtx;
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  ({ app, runtime } = createTestApp({ labelPrefix: "mbtest" }));
  host = app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true", [host.keys.templateName]: "base" });
});

afterEach(() => restoreLogs());

async function newBox(name: string, startupCommand?: string): Promise<Box> {
  const box = await createBox(host, { name, cpus: 1, memoryMb: 256, startupCommand });
  await host.startup.settle();
  return box;
}

/** A box whose command waits for the setup task that runs after the create: its clone and its postCreateCommand. */
async function newClonedBox(name: string, startupCommand: string): Promise<Box> {
  const box = await createBox(host, { name, cpus: 1, memoryMb: 256, startupCommand, awaitsSetup: true });
  await host.startup.settle();
  return box;
}

/** A server started again on the same data directory and engine. Its startup launches are its own. */
function restartedServer(): HostCtx {
  return createTestApp({ labelPrefix: "mbtest", dataDir: app.cfg.dataDir }, runtime).app.hosts.get();
}

function specOf(boxId: string): BoxSpec {
  const spec = host.specs.read(boxId);
  if (!spec) throw new Error(`no spec for ${boxId}`);
  return spec;
}

/** The text of the command the container's init session was started with, decoded the way the runner decodes it. */
function runningText(containerId: string): string | undefined {
  const encoded = runtime.tmux.commandOf(containerId, INIT_SESSION)?.[4];
  return encoded === undefined ? undefined : Buffer.from(encoded, "base64").toString("utf8");
}

/** Every start of the container's init session, as the `new-session` exec that began it. */
function launchesOf(containerId: string): ExecSpec[] {
  return runtime
    .callsTo("startExec")
    .map((call) => call.args as [string, ExecSpec])
    .filter(([id, spec]) => id === containerId && spec.cmd.includes("new-session"))
    .map(([, spec]) => spec);
}

/** Every end of a run's process tree the container got: the user it ran as, and the pid of the pane it started from. */
function treeSweepsOf(containerId: string): { user: string; anchor: string }[] {
  return runtime
    .callsTo("startExec")
    .map((call) => call.args as [string, ExecSpec])
    .filter(([id, spec]) => id === containerId && spec.cmd.includes(TREE_SWEEP_SCRIPT))
    .map(([, spec]) => ({ user: spec.user ?? "", anchor: spec.cmd[4] ?? "" }));
}

function paneOption(containerId: string, option: string): string {
  return runtime.tmux
    .run(containerId, ["-u", "display-message", "-p", "-t", `=${INIT_SESSION}:`, `#{${option}}`])
    .stdout.trim();
}

function startedLine(command: string): string {
  return `[minibox] startup command started at ${STARTED_AT} (digest ${digestOf(command)})`;
}

function exitedLine(code: number): string {
  return `[minibox] startup command exited with code ${code} at ${EXITED_AT}`;
}

describe("startup command: the launch", () => {
  test("a new box runs its command in the init session, as the runner, and keeps the pane when the run ends", async () => {
    const box = await newBox("alpha", "npm run dev");
    expect(runtime.tmux.commandOf(box.id, INIT_SESSION)).toEqual([
      "sh",
      "-c",
      RUNNER_SCRIPT,
      "minibox-startup",
      encodeCommand("npm run dev"),
      digestOf("npm run dev"),
    ]);
    expect(paneOption(box.id, "remain-on-exit")).toBe("on");
    expect(launchesOf(box.id)).toHaveLength(1);
  });

  test("the command reaches the shell unchanged, whatever characters it holds", async () => {
    const text = `cd app; echo "it's $HOME" | tee out.txt; exit 0\n`;
    const box = await newBox("beta", text);
    expect(runningText(box.id)).toBe(text);
    expect(runtime.tmux.commandOf(box.id, INIT_SESSION)?.[4]).not.toContain(";");
  });

  test("a box created without a command has no init session and reads as none", async () => {
    const box = await newBox("gamma");
    expect(runtime.tmux.sessionNames(box.id)).not.toContain(INIT_SESSION);
    expect(launchesOf(box.id)).toHaveLength(0);
    expect(await readStartupCommand(host, box.boxId)).toMatchObject({ status: "none", command: null, log: [] });
  });

  test("a box whose image cannot run tmux still starts, and reads as failed with the image as the reason", async () => {
    runtime.tmuxMissing = true;
    const box = await newBox("delta", "npm run dev");
    expect((await getBox(host, box.boxId)).running).toBe(true);
    expect(await readStartupCommand(host, box.boxId)).toMatchObject({
      status: "failed",
      command: "npm run dev",
      error: { key: "session_image_unsupported" },
    });
  });

  test("a launch that throws is kept as the failure, and the box still starts", async () => {
    const box = await newBox("epsilon");
    await setStartupCommand(host, box.boxId, { command: "npm run dev" });
    await stopBox(host, box.boxId);
    runtime.fail("startExec", new RuntimeError("engine", "exec refused by the engine"));
    await startBox(host, box.boxId);

    expect((await getBox(host, box.boxId)).running).toBe(true);
    expect(await readStartupCommand(host, box.boxId)).toMatchObject({
      status: "failed",
      error: { key: "startup_command_failed", params: { detail: "exec refused by the engine" } },
    });
  });

  test("a launch that runs past its budget finishes in the background, and the caller is not held", async () => {
    const box = await newBox("zeta", "npm run dev");
    const held = runtime.hold("startExec", (args) => (args[1] as ExecSpec).cmd.includes("new-session"));
    try {
      await runNow(host, box.boxId, 20);
      expect(await readStartupCommand(host, box.boxId)).toMatchObject({ status: "waiting", error: null });
    } finally {
      held.release();
    }
    await host.startup.settle();
    expect(await readStartupCommand(host, box.boxId)).toMatchObject({ status: "running" });
  });

  test("a live run reads as running, with its start time and the output so far", async () => {
    const box = await newBox("eta", "npm run dev");
    runtime.tmux.print(box.id, INIT_SESSION, `${startedLine("npm run dev")}\nready on 3000\n`);
    expect(await readStartupCommand(host, box.boxId)).toMatchObject({
      status: "running",
      exitCode: null,
      startedAt: STARTED_AT,
      stale: false,
      log: [startedLine("npm run dev"), "ready on 3000"],
    });
  });

  test("a run that has ended reads as exited, with its code, its exit time and its output", async () => {
    const box = await newBox("theta", "exit 3");
    runtime.tmux.print(box.id, INIT_SESSION, `${startedLine("exit 3")}\nboom\n${exitedLine(3)}\n`);
    runtime.tmux.exitPane(box.id, INIT_SESSION, 3);
    expect(await readStartupCommand(host, box.boxId)).toMatchObject({
      status: "exited",
      exitCode: 3,
      exitedAt: EXITED_AT,
      log: [startedLine("exit 3"), "boom", exitedLine(3)],
    });
  });
});

describe("startup command: starts, restarts and wakes", () => {
  test("a stop ends the init session, and the next start runs the command again; a start of a running box does not", async () => {
    const box = await newBox("iota", "make watch");
    await stopBox(host, box.boxId);
    expect(runtime.tmux.sessionNames(box.id)).toEqual([]);

    await startBox(host, box.boxId);
    expect(launchesOf(box.id)).toHaveLength(2);
    await startBox(host, box.boxId);
    expect(launchesOf(box.id)).toHaveLength(2);
  });

  test("a restart runs the command again", async () => {
    const box = await newBox("kappa", "make watch");
    await restartBox(host, box.boxId);
    expect(launchesOf(box.id)).toHaveLength(2);
    expect(runningText(box.id)).toBe("make watch");
  });

  test("a wake from idle sleep runs the command again", async () => {
    const box = await newBox("lambda", "make watch");
    await sleepBox(host, box.boxId, "idle");
    expect((await getBox(host, box.boxId)).running).toBe(false);

    expect((await wakeIfSleeping(host, box.boxId)).running).toBe(true);
    expect(launchesOf(box.id)).toHaveLength(2);
  });

  test("a stopped box reads as waiting, and reading it does not start it", async () => {
    const box = await newBox("mu", "make watch");
    await stopBox(host, box.boxId);
    expect(await readStartupCommand(host, box.boxId)).toMatchObject({ status: "waiting", command: "make watch" });
    expect((await getBox(host, box.boxId)).running).toBe(false);
  });
});

describe("startup command: set, clear and apply now", () => {
  test("a change made while the box is stopped takes effect at the next start", async () => {
    const box = await newBox("nu", "echo one");
    await stopBox(host, box.boxId);

    const changed = await setStartupCommand(host, box.boxId, { command: "echo two" });
    expect(changed).toMatchObject({ status: "waiting", command: "echo two" });
    expect(launchesOf(box.id)).toHaveLength(1);

    await startBox(host, box.boxId);
    expect(runningText(box.id)).toBe("echo two");
  });

  test("a removal made while the box is asleep means nothing runs at the next wake", async () => {
    const box = await newBox("xi", "echo one");
    await sleepBox(host, box.boxId, "idle");

    expect(await clearStartupCommand(host, box.boxId)).toMatchObject({ status: "none", command: null });
    await wakeIfSleeping(host, box.boxId);
    expect(runtime.tmux.sessionNames(box.id)).not.toContain(INIT_SESSION);
    expect(launchesOf(box.id)).toHaveLength(1);
  });

  test("a change while the box runs does not restart the run, and the run reads as stale", async () => {
    const box = await newBox("omicron", "echo one");
    runtime.tmux.print(box.id, INIT_SESSION, `${startedLine("echo one")}\nready\n`);

    const changed = await setStartupCommand(host, box.boxId, { command: "echo two" });
    expect(launchesOf(box.id)).toHaveLength(1);
    expect(changed).toMatchObject({ status: "running", stale: true, command: "echo two" });
  });

  test("apply now restarts a running box's command with the new text", async () => {
    const box = await newBox("pi", "echo one");

    const changed = await setStartupCommand(host, box.boxId, { command: "echo two", applyNow: true });
    expect(launchesOf(box.id)).toHaveLength(2);
    expect(runningText(box.id)).toBe("echo two");
    expect(changed).toMatchObject({ status: "running", stale: false });
  });

  test("apply now on a stopped box stores the command and starts nothing", async () => {
    const box = await newBox("rho", "echo one");
    await stopBox(host, box.boxId);

    const changed = await setStartupCommand(host, box.boxId, { command: "echo two", applyNow: true });
    expect(changed).toMatchObject({ status: "waiting", command: "echo two" });
    expect(launchesOf(box.id)).toHaveLength(1);
  });

  test("removing the command leaves a run that is going until the box stops", async () => {
    const box = await newBox("sigma", "sleep 3600");

    expect(await clearStartupCommand(host, box.boxId)).toMatchObject({ status: "none", command: null });
    expect(runtime.tmux.sessionNames(box.id)).toContain(INIT_SESSION);

    await stopBox(host, box.boxId);
    await startBox(host, box.boxId);
    expect(runtime.tmux.sessionNames(box.id)).not.toContain(INIT_SESSION);
  });

  test("run again relaunches a running box's command, and refuses a stopped box or a box with no command", async () => {
    const box = await newBox("tau", "echo one");
    await runStartupCommand(host, box.boxId);
    expect(launchesOf(box.id)).toHaveLength(2);

    await stopBox(host, box.boxId);
    expect(await rejectionOf(runStartupCommand(host, box.boxId))).toMatchObject({
      status: 409,
      key: "startup_command_box_stopped",
    });

    const bare = await newBox("upsilon");
    expect(await rejectionOf(runStartupCommand(host, bare.boxId))).toMatchObject({
      status: 409,
      key: "startup_command_none",
    });
  });

  test("a change sent with an older revision is refused, and the stored command stays", async () => {
    const box = await newBox("phi", "echo one");

    const error = await rejectionOf(
      setStartupCommand(host, box.boxId, { command: "echo two", expectedRevision: box.revision + 1 }),
    );
    expect(error).toMatchObject({ status: 412, key: "revision_mismatch" });
    expect((await readStartupCommand(host, box.boxId)).command).toBe("echo one");
  });

  test("setting the text it already has changes nothing, not even the revision", async () => {
    const box = await newBox("chi", "echo one");
    const before = specOf(box.boxId);

    await setStartupCommand(host, box.boxId, { command: "echo one" });
    expect(specOf(box.boxId)).toEqual(before);
  });

  test("each change is one revision, and the text it replaced is kept in history", async () => {
    const box = await newBox("psi", "echo one");
    const before = specOf(box.boxId);

    await setStartupCommand(host, box.boxId, { command: "echo two" });
    const afterSet = specOf(box.boxId);
    expect(afterSet.revision).toBe(before.revision + 1);
    expect(afterSet.history?.[0]).toMatchObject({ revision: before.revision, spec: { startupCommand: "echo one" } });

    await clearStartupCommand(host, box.boxId);
    const afterClear = specOf(box.boxId);
    expect(afterClear.revision).toBe(before.revision + 2);
    expect(afterClear.startupCommand).toBeUndefined();
  });

  test("a refused text never reaches the spec, and the error says which rule it broke", async () => {
    const box = await newBox("omega", "echo one");
    const before = specOf(box.boxId);

    expect(await rejectionOf(setStartupCommand(host, box.boxId, { command: "  \n" }))).toMatchObject({
      status: 400,
      key: "startup_command_empty",
    });
    expect(await rejectionOf(setStartupCommand(host, box.boxId, { command: "x".repeat(4097) }))).toMatchObject({
      status: 400,
      key: "startup_command_too_long",
    });
    expect(await rejectionOf(setStartupCommand(host, box.boxId, { command: "echo\u0000" }))).toMatchObject({
      status: 400,
      key: "startup_command_control",
    });
    expect(specOf(box.boxId)).toEqual(before);
  });

  test("setting or removing the command clears only its own reset note on a recovered box", async () => {
    const box = await newBox("alpha2");
    const recovery: BoxRecovery = {
      source: "claim",
      at: new Date().toISOString(),
      needsReset: ["startupCommand", "env"],
      observedRestart: "no",
    };
    host.specs.write({ ...specOf(box.boxId), recovery });

    await setStartupCommand(host, box.boxId, { command: "echo one" });
    expect(specOf(box.boxId).recovery?.needsReset).toEqual(["env"]);

    host.specs.write({ ...specOf(box.boxId), recovery: { ...recovery, needsReset: ["startupCommand"] } });
    await clearStartupCommand(host, box.boxId);
    expect(specOf(box.boxId).recovery).toBeNull();
  });
});

describe("startup command: rebuilds and the record", () => {
  test("a rebuild of a running box runs the command in the new container, and the old one is gone", async () => {
    const box = await newBox("beta2", "echo one");

    const rebuilt = await rebuildBox(host, box.boxId, box.revision, { env: [{ name: "FOO", value: "bar" }] }, true);
    expect(rebuilt.id).not.toBe(box.id);
    expect(runtime.tmux.sessionNames(box.id)).toEqual([]);
    expect(runningText(rebuilt.id)).toBe("echo one");
    expect(launchesOf(rebuilt.id)).toHaveLength(1);
  });

  test("a rebuild of a stopped box does not run the command", async () => {
    const box = await newBox("gamma2", "echo one");
    await stopBox(host, box.boxId);

    const current = await getBox(host, box.boxId);
    const rebuilt = await rebuildBox(host, box.boxId, current.revision, { env: [{ name: "FOO", value: "bar" }] }, true);
    expect(rebuilt.running).toBe(false);
    expect(launchesOf(rebuilt.id)).toHaveLength(0);
  });

  test("the command is kept in the spec, and a box a caller reads does not carry it", async () => {
    const box = await newBox("delta2", "export TOKEN=sekret-value; npm run dev");
    const read = await getBox(host, box.boxId);
    expect(read).not.toHaveProperty("startupCommand");
    expect(JSON.stringify(read)).not.toContain("sekret-value");
    expect(specOf(box.boxId).startupCommand).toBe("export TOKEN=sekret-value; npm run dev");
  });
});

describe("startup command: a launch that is already running", () => {
  test("asking for the launch again while the run is going does not run the command twice", async () => {
    const box = await newBox("dup", "echo one");
    scheduleStartup(host, box.boxId);
    scheduleStartup(host, box.boxId);
    await host.startup.settle();
    expect(launchesOf(box.id)).toHaveLength(1);
  });
});

describe("startup command: create does not wait for the launch", () => {
  test("a create with a command returns while its launch is held, and reads as waiting until the launch lands", async () => {
    const held = runtime.hold("startExec", (args) => (args[1] as ExecSpec).cmd.includes("new-session"));
    let boxId = "";
    try {
      const created = await Promise.race([
        createBox(host, { name: "held", cpus: 1, memoryMb: 256, startupCommand: "npm run dev" }),
        Bun.sleep(1000).then(() => null),
      ]);
      expect(created).not.toBeNull();
      boxId = created?.boxId ?? "";
      expect(await readStartupCommand(host, boxId)).toMatchObject({ status: "waiting", error: null });
    } finally {
      held.release();
    }
    await host.startup.settle();
    expect(await readStartupCommand(host, boxId)).toMatchObject({ status: "running", command: "npm run dev" });
  });
});

describe("startup command: waiting for the box setup", () => {
  test("a box whose setup is pending runs nothing until the setup ends, and then runs the command", async () => {
    const box = await newClonedBox("clone-ok", "npm run dev");
    expect(launchesOf(box.id)).toHaveLength(0);
    expect(await readStartupCommand(host, box.boxId)).toMatchObject({
      status: "cloning",
      command: "npm run dev",
      error: null,
    });

    await finishSetup(host, box.boxId, null);
    await host.startup.settle();
    expect(runningText(box.id)).toBe("npm run dev");
    expect(specOf(box.boxId).startupAwaitsSetup).toBeUndefined();
  });

  test("a setup that fails keeps the command from starting, and the status says so", async () => {
    const box = await newClonedBox("clone-bad", "npm run dev");
    await finishSetup(host, box.boxId, msg("startup_command_clone_failed"));
    await host.startup.settle();

    expect(launchesOf(box.id)).toHaveLength(0);
    expect(await readStartupCommand(host, box.boxId)).toMatchObject({
      status: "failed",
      error: { key: "startup_command_clone_failed" },
    });
  });

  test("a postCreateCommand that failed keeps the command back, and the status names the failed setup", async () => {
    const box = await newClonedBox("setup-bad", "npm run dev");
    await finishSetup(host, box.boxId, msg("startup_command_setup_failed"));
    await host.startup.settle();

    expect(launchesOf(box.id)).toHaveLength(0);
    expect(await readStartupCommand(host, box.boxId)).toMatchObject({
      status: "failed",
      error: { key: "startup_command_setup_failed" },
    });
    // The command still runs at the box's next start, as a failed clone's does.
    await stopBox(host, box.boxId);
    await startBox(host, box.boxId);
    expect(runningText(box.id)).toBe("npm run dev");
    expect(specOf(box.boxId).startupFailure).toBeUndefined();
  });

  test("the command runs again only after the setup ends: a start while the setup runs launches nothing", async () => {
    const box = await newClonedBox("setup-late", "npm run dev");
    await startBox(host, box.boxId);
    expect(launchesOf(box.id)).toHaveLength(0);

    await finishSetup(host, box.boxId, null);
    await host.startup.settle();
    expect(runningText(box.id)).toBe("npm run dev");
  });

  test("a failed setup is kept on the spec, so a restarted server still reports it", async () => {
    const box = await newClonedBox("clone-kept", "npm run dev");
    await finishSetup(host, box.boxId, msg("startup_command_clone_failed"));

    expect(await readStartupCommand(restartedServer(), box.boxId)).toMatchObject({
      status: "failed",
      error: { key: "startup_command_clone_failed" },
    });
  });

  test("a setup that ends while the box is stopped runs the command at the box's next start", async () => {
    const box = await newClonedBox("clone-stopped", "npm run dev");
    await stopBox(host, box.boxId);
    await finishSetup(host, box.boxId, null);
    await host.startup.settle();
    expect(launchesOf(box.id)).toHaveLength(0);

    await startBox(host, box.boxId);
    expect(runningText(box.id)).toBe("npm run dev");
  });

  test("a setup cut short by a restart is reported when the server reconciles, and the command does not start", async () => {
    const box = await newClonedBox("clone-cut", "npm run dev");
    const restarted = restartedServer();

    await reconcileHost(restarted);
    await restarted.startup.settle();

    expect(launchesOf(box.id)).toHaveLength(0);
    expect(await readStartupCommand(restarted, box.boxId)).toMatchObject({
      status: "failed",
      error: { key: "startup_command_clone_unfinished" },
    });
    expect(restarted.specs.read(box.boxId)?.startupAwaitsSetup).toBeUndefined();
  });

  test("a spec on disk with the old startupAwaitsClone field still holds the command back", async () => {
    const box = await newClonedBox("clone-old-field", "npm run dev");
    const specPath = join(host.specs.dir(), `${box.boxId}.json`);
    const onDisk = JSON.parse(readFileSync(specPath, "utf8")) as Record<string, unknown>;
    delete onDisk.startupAwaitsSetup;
    onDisk.startupAwaitsClone = true;
    writeFileSync(specPath, `${JSON.stringify(onDisk, null, 2)}\n`);

    const restarted = restartedServer();
    await reconcileHost(restarted);
    await restarted.startup.settle();

    expect(launchesOf(box.id)).toHaveLength(0);
    expect(await readStartupCommand(restarted, box.boxId)).toMatchObject({
      status: "failed",
      error: { key: "startup_command_clone_unfinished" },
    });
    expect(restarted.specs.read(box.boxId)?.startupAwaitsSetup).toBeUndefined();
  });

  test("a start after a restart that cut the setup short reports it, and does not launch the command", async () => {
    const box = await newClonedBox("clone-start", "npm run dev");
    await stopBox(host, box.boxId);

    const restarted = restartedServer();
    await startBox(restarted, box.boxId);

    expect(launchesOf(box.id)).toHaveLength(0);
    expect(await readStartupCommand(restarted, box.boxId)).toMatchObject({
      status: "failed",
      error: { key: "startup_command_clone_unfinished" },
    });
  });

  test("a stopped box whose setup a restart cut short reads as failed at once, not as setting up", async () => {
    const box = await newClonedBox("clone-stopped-cut", "npm run dev");
    await stopBox(host, box.boxId);

    expect(await readStartupCommand(restartedServer(), box.boxId)).toMatchObject({
      status: "failed",
      error: { key: "startup_command_clone_unfinished" },
    });
  });
});

describe("startup command: a failure outlives the server", () => {
  test("a launch that failed is reported by a restarted server, and a later run clears it", async () => {
    const box = await newBox("persist", "npm run dev");
    await stopBox(host, box.boxId);
    runtime.fail("startExec", new RuntimeError("engine", "exec refused by the engine"));
    await startBox(host, box.boxId);

    const restarted = restartedServer();
    expect(await readStartupCommand(restarted, box.boxId)).toMatchObject({
      status: "failed",
      error: { key: "startup_command_failed", params: { detail: "exec refused by the engine" } },
    });

    await runStartupCommand(restarted, box.boxId);
    expect(specOf(box.boxId).startupFailure).toBeUndefined();
    expect(await readStartupCommand(restarted, box.boxId)).toMatchObject({ status: "running", error: null });
  });
});

describe("startup command: a container the engine starts while MiniBox is down", () => {
  test("its command runs once the server reconciles, and a later reconcile does not run it again", async () => {
    const box = await newBox("omega", "npm run dev");
    expect(launchesOf(box.id)).toHaveLength(1);
    await runtime.restartContainer(box.id, { timeoutSec: 1 });
    expect(runtime.tmux.sessionNames(box.id)).not.toContain(INIT_SESSION);

    const restarted = restartedServer();
    await reconcileHost(restarted);
    await restarted.startup.settle();
    expect(launchesOf(box.id)).toHaveLength(2);
    expect(runningText(box.id)).toBe("npm run dev");
    expect(await readStartupCommand(restarted, box.boxId)).toMatchObject({ status: "running", error: null });

    await reconcileHost(restarted);
    await restarted.startup.settle();
    expect(launchesOf(box.id)).toHaveLength(2);
  });

  test("a reconcile of a container whose command is still running launches nothing", async () => {
    const box = await newBox("psi", "make watch");

    await reconcileHost(restartedServer());
    expect(launchesOf(box.id)).toHaveLength(1);
  });
});

describe("startup command: a rebuild's launch", () => {
  test("a rebuild returns once the new container runs the command, without waiting out the launch budget", async () => {
    const box = await newBox("beta3", "echo one");

    const began = Date.now();
    const rebuilt = await rebuildBox(host, box.boxId, box.revision, { env: [{ name: "FOO", value: "bar" }] }, true);
    expect(Date.now() - began).toBeLessThan(2500);
    expect(await readStartupCommand(host, rebuilt.boxId)).toMatchObject({ status: "running", error: null });
  });

  test("a rebuild whose new container cannot run the command records why on the rebuilt box", async () => {
    const box = await newBox("gamma3", "echo one");

    runtime.tmuxMissing = true;
    const rebuilt = await rebuildBox(host, box.boxId, box.revision, { env: [{ name: "FOO", value: "bar" }] }, true);
    expect(await readStartupCommand(host, rebuilt.boxId)).toMatchObject({
      status: "failed",
      error: { key: "session_image_unsupported" },
    });
    expect(specOf(box.boxId).startupFailure).toMatchObject({
      containerId: rebuilt.id,
      key: "session_image_unsupported",
    });
  });
});

describe("startup command: the processes a run leaves", () => {
  test("a run ends its process tree from its pane's pid, as root in a standard box", async () => {
    const box = await newBox("sweep-standard", "npm run dev");
    expect(treeSweepsOf(box.id)).toEqual([]);
    const pane = paneOption(box.id, "pane_pid");

    await runStartupCommand(host, box.boxId);

    expect(treeSweepsOf(box.id)).toEqual([{ user: "root", anchor: pane }]);
  });

  test("a strict box ends its process tree as dev, since all of its processes belong to dev", async () => {
    const box = await createBox(host, {
      name: "sweep-strict",
      cpus: 1,
      memoryMb: 256,
      startupCommand: "npm run dev",
      profile: "strict",
    });
    await host.startup.settle();
    const pane = paneOption(box.id, "pane_pid");

    await runStartupCommand(host, box.boxId);

    expect(treeSweepsOf(box.id)).toEqual([{ user: "dev", anchor: pane }]);
  });
});
