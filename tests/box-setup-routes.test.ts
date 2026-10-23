import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import { REDACTED } from "../src/events/redact";
import type { ExecSpec, HelperSpec } from "../src/runtime";
import { runPostCreate } from "../src/services/box-setup";
import { rejectionOf, silenceLogs, TEST_KEY } from "./support/app";
import { advance } from "./support/clock";
import { call, finishedTask, type Harness, mint, refused, startHarness } from "./support/tokens";

let harness: Harness;
let restoreLogs: () => void;
/** The repository files a clone brings in, keyed by path. A clone helper writes them into the volume it is given. */
let repo: Map<string, string>;

beforeEach(() => {
  restoreLogs = silenceLogs();
  harness = startHarness();
  repo = new Map();
  harness.runtime.helperHandler = (spec: HelperSpec) => {
    if (spec.cmd[0] === "sh") {
      const volume = spec.mounts?.[0]?.source ?? "";
      for (const [path, text] of repo) {
        harness.runtime.seedVolumeFile(volume, path, { type: "file", content: Buffer.from(text) });
      }
    }
    return { exitCode: 0, logs: "" };
  };
});

afterEach(() => {
  harness.stop();
  restoreLogs();
});

const REPO_URL = "https://github.com/org/app.git";
const POST_CREATE = '{"image": "alpine:3.20", "postCreateCommand": "npm install"}';

/** Declares a template named `name` from a devcontainer.json in the repository, through the REST API. */
async function declare(name: string, devcontainer: string): Promise<void> {
  repo.set(".devcontainer/devcontainer.json", devcontainer);
  const started = await call(harness.base, "/api/templates", {
    body: { name, source: { kind: "devcontainer", url: REPO_URL } },
  });
  expect(started.status).toBe(202);
  expect((await finishedTask(harness.base, started.json.taskId ?? "")).status).toBe("succeeded");
}

function create(body: Record<string, unknown>, token?: string) {
  return call(harness.base, "/api/boxes", { token, body: { cpus: 1, memoryMb: 256, ...body } });
}

async function boxNames(): Promise<string[]> {
  const listed = await call(harness.base, "/api/boxes");
  return (listed.json.boxes ?? []).map((box) => box.name);
}

/** The exec specs the engine was asked to start that run exactly `argv`. */
function execsRunning(argv: string[]): ExecSpec[] {
  return harness.runtime
    .callsTo("startExec")
    .map((entry) => entry.args[1] as ExecSpec)
    .filter((spec) => spec.cmd.length === argv.length && spec.cmd.every((part, i) => part === argv[i]));
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("the condition did not hold in time");
    await Bun.sleep(5);
  }
}

async function taskOutput(taskId: string): Promise<string> {
  const view = await call(harness.base, `/api/tasks/${taskId}`);
  return (view.json as unknown as { output?: string }).output ?? "";
}

describe("a box created from a template with a postCreateCommand", () => {
  test("answers 201 with a setup task, and the command runs once as dev in /workspace", async () => {
    await declare("dev", POST_CREATE);

    const created = await create({ name: "alpha", template: "mbtest-template:dev" });

    expect(created.status).toBe(201);
    const taskId = created.json.setup?.taskId ?? "";
    expect(taskId).not.toBe("");
    expect((await finishedTask(harness.base, taskId)).status).toBe("succeeded");
    expect(execsRunning(["/bin/sh", "-c", "npm install"])).toEqual([
      {
        cmd: ["/bin/sh", "-c", "npm install"],
        env: [],
        workingDir: "/workspace",
        user: "dev",
        stopAs: "root",
        tty: false,
      },
    ]);
    expect(await taskOutput(taskId)).toContain("Running postCreateCommand in /workspace\n");
  });

  test("with a repository, the clone runs before the command, and both are the one setup task", async () => {
    await declare("dev", POST_CREATE);

    const created = await create({ name: "alpha", template: "mbtest-template:dev", repo: { url: REPO_URL } });

    expect(created.status).toBe(201);
    expect(created.json.clone?.taskId).toBe(created.json.setup?.taskId);
    expect((await finishedTask(harness.base, created.json.setup?.taskId ?? "")).status).toBe("succeeded");
    const clone = harness.runtime.calls.findIndex(
      (entry) => entry.op === "runHelper" && (entry.args[0] as HelperSpec).cmd[2]?.includes("credential.helper="),
    );
    const command = harness.runtime.calls.findIndex(
      (entry) => entry.op === "startExec" && (entry.args[1] as ExecSpec).cmd.join(" ") === "/bin/sh -c npm install",
    );
    expect(clone).toBeGreaterThanOrEqual(0);
    expect(command).toBeGreaterThan(clone);
  });

  test("the command's output reaches the task log line by line, and the owner's access key in it is redacted", async () => {
    await declare("dev", POST_CREATE);
    harness.runtime.execScript = { stdout: `installed\nkey ${TEST_KEY}\n`, stderr: "warn\n", code: 0 };
    const created = await create({ name: "alpha", template: "mbtest-template:dev" });
    const taskId = created.json.setup?.taskId ?? "";

    expect((await finishedTask(harness.base, taskId)).status).toBe("succeeded");

    const output = await taskOutput(taskId);
    expect(output).toContain("installed\n");
    expect(output).toContain("warn\n");
    expect(output).toContain(`key ${REDACTED}`);
    expect(output).not.toContain(TEST_KEY);
  });

  test("a command that exits non-zero fails the setup task with post_create_failed, and the box is kept", async () => {
    await declare("dev", POST_CREATE);
    harness.runtime.execScript = { stdout: "", stderr: "npm ERR! code E404\n", code: 2 };
    const created = await create({ name: "alpha", template: "mbtest-template:dev" });
    const taskId = created.json.setup?.taskId ?? "";

    const done = await finishedTask(harness.base, taskId);

    expect(done.status).toBe("failed");
    expect(done.error?.key).toBe("post_create_failed");
    expect(await taskOutput(taskId)).toContain("npm ERR! code E404");
    expect(await boxNames()).toContain("alpha");
  });

  test("cancelling the setup while the command runs stops the command, and the box is kept", async () => {
    await declare("dev", POST_CREATE);
    harness.runtime.execScript = null;
    const created = await create({ name: "alpha", template: "mbtest-template:dev" });
    const taskId = created.json.setup?.taskId ?? "";
    await until(() => execsRunning(["/bin/sh", "-c", "npm install"]).length === 1);

    await call(harness.base, `/api/tasks/${taskId}/cancel`, { method: "POST" });

    expect((await finishedTask(harness.base, taskId)).status).toBe("cancelled");
    await harness.app.tasks.drain();
    expect(harness.runtime.execs.at(-1)?.killed).toBe(true);
    expect(await boxNames()).toContain("alpha");
  });

  test("a token with the exec and port:expose scopes creates the box, and its setup runs", async () => {
    await declare("dev", '{"image": "alpine:3.20", "postCreateCommand": "npm install", "forwardPorts": [3000]}');
    const operator = mint(harness.app, { name: "operator", preset: "operator" });

    const reply = await create({ name: "alpha", template: "mbtest-template:dev" }, operator.secret);

    expect(reply.status).toBe(201);
    expect((await finishedTask(harness.base, reply.json.setup?.taskId ?? "")).status).toBe("succeeded");
  });

  test("a token without the exec scope is refused before any box is made", async () => {
    await declare("dev", POST_CREATE);
    const token = mint(harness.app, {
      name: "no-exec",
      scopes: ["box:read", "box:write", "volume:read", "volume:write", "port:expose"],
    });
    const before = await boxNames();

    const reply = await create({ name: "alpha", template: "mbtest-template:dev" }, token.secret);

    expect(refused(reply)).toEqual({ status: 403, key: "template_command_forbidden" });
    expect(await boxNames()).toEqual(before);
  });
});

describe("a box created from a template that forwards ports", () => {
  test("the forwarded ports are manual ports of the box, and a host name among the entries is not forwarded", async () => {
    await declare("web", '{"image": "alpine:3.20", "forwardPorts": [3000, "db:5432", 8080]}');

    const created = await create({ name: "alpha", template: "mbtest-template:web" });

    expect(created.status).toBe(201);
    expect((await finishedTask(harness.base, created.json.setup?.taskId ?? "")).status).toBe("succeeded");
    const listed = await call(harness.base, `/api/boxes/${created.json.box?.boxId ?? ""}/ports`);
    const ports = (listed.json.ports ?? []).map((entry) => `${entry.port}:${entry.source}`).toSorted();
    expect(ports).toEqual(["3000:manual", "8080:manual"]);
  });

  test("the ports are forwarded before the command runs, and the log says so in that order", async () => {
    await declare("dev", '{"image": "alpine:3.20", "postCreateCommand": "npm install", "forwardPorts": [3000]}');

    const created = await create({ name: "alpha", template: "mbtest-template:dev" });
    const taskId = created.json.setup?.taskId ?? "";
    await finishedTask(harness.base, taskId);

    const output = await taskOutput(taskId);
    expect(output.indexOf("Forwarded port 3000\n")).toBeGreaterThanOrEqual(0);
    expect(output.indexOf("Forwarded port 3000\n")).toBeLessThan(output.indexOf("Running postCreateCommand"));
  });

  test("a token without the port:expose scope is refused before any box is made", async () => {
    await declare("web", '{"image": "alpine:3.20", "forwardPorts": [3000]}');
    const token = mint(harness.app, {
      name: "no-ports",
      scopes: ["box:read", "box:write", "exec", "volume:read", "volume:write"],
    });

    const reply = await create({ name: "alpha", template: "mbtest-template:web" }, token.secret);

    expect(refused(reply)).toEqual({ status: 403, key: "template_ports_forbidden" });
    expect(await boxNames()).not.toContain("alpha");
  });
});

describe("a box created from a template with no setup", () => {
  test("a template that asks for neither a command nor a port starts no setup task", async () => {
    await declare("plain", '{"image": "alpine:3.20", "containerEnv": {"A": "1"}}');

    const created = await create({ name: "alpha", template: "mbtest-template:plain" });

    expect(created.status).toBe(201);
    expect(created.json.setup).toBeUndefined();
    expect(execsRunning(["/bin/sh", "-c", "npm install"])).toEqual([]);
  });

  test("a box with no template starts no setup task", async () => {
    const created = await create({ name: "alpha" });

    expect(created.status).toBe(201);
    expect(created.json.setup).toBeUndefined();
  });
});

describe("running the command past its time limit", () => {
  test("the command is stopped with post_create_timeout once the limit passes, and the box is kept", async () => {
    const created = await create({ name: "alpha" });
    const boxId = created.json.box?.boxId ?? "";
    harness.runtime.execScript = null;
    jest.useFakeTimers();
    try {
      const outcome = runPostCreate(
        harness.app.hosts.get(),
        boxId,
        ["sleep", "infinity"],
        () => undefined,
        new AbortController().signal,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      const state = { settled: false };
      void outcome.then(() => {
        state.settled = true;
      });
      for (let steps = 0; !state.settled; steps++) {
        if (steps > 5000) throw new Error("the command was not stopped by the time limit");
        await advance(1000);
      }

      expect(await outcome).toMatchObject({ status: 409, key: "post_create_timeout" });
      expect(harness.runtime.execs.at(-1)?.killed).toBe(true);
      expect(await boxNames()).toContain("alpha");
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("running the command of a box that is not running", () => {
  test("a box stopped before its command runs is refused with post_create_box_stopped, and nothing is started", async () => {
    const created = await create({ name: "alpha" });
    const boxId = created.json.box?.boxId ?? "";
    await call(harness.base, `/api/boxes/${boxId}/stop`, { method: "POST" });

    const error = await rejectionOf(
      runPostCreate(harness.app.hosts.get(), boxId, ["true"], () => undefined, new AbortController().signal),
    );

    expect(error).toMatchObject({ status: 409, key: "post_create_box_stopped" });
    expect(harness.runtime.callsTo("startExec")).toEqual([]);
  });
});
