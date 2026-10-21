import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AuditNote, Source } from "../src/events/types";
import type { HostCtx } from "../src/host/registry";
import type { AppError } from "../src/lib/errors";
import type { OperationContext, Principal } from "../src/operations/types";
import { type Box, getBox, stopBox } from "../src/services/boxes";
import { type Attachment, TerminalService } from "../src/services/terminals";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import type { FakeExec } from "./support/fake-runtime";

const OWNER: Principal = { type: "owner", id: "owner", name: "owner" };

interface Recorded {
  readonly hostId: string;
  readonly source: Source;
  readonly note: AuditNote;
}

function setup(takeoverIdleMs = 0) {
  const { app, runtime } = createTestApp({ labelPrefix: "mbtest" });
  const keys = app.hosts.get().keys;
  runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  const host: HostCtx = app.hosts.get();
  const ctx: OperationContext = { host, principal: OWNER, source: "rest", events: app.events, execs: app.execs };
  const recorded: Recorded[] = [];
  const terminals = new TerminalService({
    record: (hostId, source, note) => recorded.push({ hostId, source, note }),
    takeoverIdleMs,
  });
  return { app, runtime, host, ctx, terminals, recorded };
}

async function createBox(app: ReturnType<typeof setup>["app"], ctx: OperationContext): Promise<string> {
  const created = (await app.operations.run("box.create", ctx, { name: "alpha", cpus: 1, memoryMb: 256 })) as {
    box: { id: string };
  };
  return created.box.id;
}

async function runningBox(env: ReturnType<typeof setup>): Promise<Box> {
  return getBox(env.host, await createBox(env.app, env.ctx));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("terminal service: sessions", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("start creates a session marked with the origin of its caller", async () => {
    const env = setup();
    const box = await runningBox(env);

    const agent = await env.terminals.start(env.host, box, "work", "rest");
    expect(agent).toMatchObject({
      created: true,
      woke: false,
      session: { name: "work", origin: "agent", controller: "agent", takenOver: false },
    });

    const again = await env.terminals.start(env.host, box, "work", "ui");
    expect(again).toMatchObject({ created: false, session: { origin: "agent", controller: "agent" } });

    const human = await env.terminals.start(env.host, box, "mine", "ui");
    expect(human).toMatchObject({ created: true, session: { name: "mine", origin: "human", controller: "human" } });
  });

  test("list reports each session's origin, and a session made outside MiniBox counts as agent-driven", async () => {
    const env = setup();
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "work", "rest");
    await env.terminals.start(env.host, box, "mine", "ui");
    env.runtime.tmux.run(box.id, ["-u", "new-session", "-d", "-s", "bare", "--", "sh"]);

    const listed = await env.terminals.list(env.host, box);
    expect(Object.fromEntries(listed.map((s) => [s.name, [s.origin, s.controller]]))).toEqual({
      work: ["agent", "agent"],
      mine: ["human", "human"],
      bare: ["agent", "agent"],
    });
    expect(listed.every((s) => typeof s.createdAt === "number" && s.attached === 0)).toBe(true);
  });

  test("a stopped box lists no sessions and listing does not start it", async () => {
    const env = setup();
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "work", "rest");
    await stopBox(env.host, box.boxId);

    const stopped = await getBox(env.host, box.boxId);
    expect(await env.terminals.list(env.host, stopped)).toEqual([]);
    expect((await getBox(env.host, box.boxId)).running).toBe(false);
  });

  test("start wakes a stopped box, and the sessions of the old tmux server are gone", async () => {
    const env = setup();
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "work", "rest");
    await stopBox(env.host, box.boxId);

    const woken = await env.terminals.start(env.host, await getBox(env.host, box.boxId), "work", "rest");
    expect(woken).toMatchObject({ created: true, woke: true });
    expect((await getBox(env.host, box.boxId)).running).toBe(true);
  });

  test("read and send refuse a stopped box with a hint, and do not start it", async () => {
    const env = setup();
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "work", "rest");
    await stopBox(env.host, box.boxId);
    const stopped = await getBox(env.host, box.boxId);

    const read = await rejectionOf(env.terminals.read(env.host, stopped, "work", { lines: 5 }));
    expect(read).toMatchObject({ status: 404, key: "session_not_found" });
    expect((read as AppError).hintKey).toBe("session_box_stopped_hint");
    const sent = await rejectionOf(env.terminals.send(env.host, stopped, "work", { text: "x" }));
    expect((sent as AppError).hintKey).toBe("session_box_stopped_hint");
    expect((await getBox(env.host, box.boxId)).running).toBe(false);
  });

  test("an invalid session name is refused before any tmux command runs", async () => {
    const env = setup();
    const box = await runningBox(env);
    const before = env.runtime.callsTo("startExec").length;

    const error = await rejectionOf(env.terminals.start(env.host, box, "bad;name", "rest"));
    expect(error).toMatchObject({ status: 400, key: "session_name_invalid" });
    expect(env.runtime.callsTo("startExec").length).toBe(before);
  });

  test("a box without tmux reports a conflict that names the missing program", async () => {
    const env = setup();
    const box = await runningBox(env);
    env.runtime.tmuxMissing = true;

    const error = await rejectionOf(env.terminals.start(env.host, box, "work", "rest"));
    expect(error).toMatchObject({ status: 409, code: "conflict", key: "session_tmux_missing" });
  });

  test("an unknown session is reported as not found", async () => {
    const env = setup();
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "work", "rest");

    const error = await rejectionOf(env.terminals.read(env.host, box, "nope", { lines: 5 }));
    expect(error).toMatchObject({ status: 404, key: "session_not_found" });
  });

  test("close kills the session, ends its terminals, and drops it from the list", async () => {
    const env = setup();
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "work", "rest");
    const viewer = await env.terminals.attach(env.host, box, "work", { source: "ui" });

    await env.terminals.close(env.host, box, "work");
    expect(await viewer.exec.inspect()).toMatchObject({ running: false });
    expect(await env.terminals.list(env.host, box)).toEqual([]);
    await viewer.close();
  });
});

describe("terminal service: reads", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("read returns the window, and since returns only what is new after the cursor", async () => {
    const env = setup();
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "work", "rest");

    const first = await env.terminals.read(env.host, box, "work", { lines: 50 });
    expect(first).toMatchObject({ session: "work", reset: false, truncated: false, lines: [], controller: "agent" });
    expect(first.cursor).toMatch(/^[0-9a-f]{12}\.1$/);

    await env.terminals.send(env.host, box, "work", { text: "echo one\n" });
    const second = await env.terminals.read(env.host, box, "work", { lines: 50, since: first.cursor });
    expect(second).toMatchObject({ reset: false, lines: ["echo one"] });
    expect(second.cursor).toBe(first.cursor.replace(/\d+$/, "2"));

    await env.terminals.send(env.host, box, "work", { text: "two\n" });
    const third = await env.terminals.read(env.host, box, "work", { lines: 50, since: second.cursor });
    expect(third).toMatchObject({ reset: false, lines: ["two"] });
  });

  test("a line that was still being typed comes back in full once it grows", async () => {
    const env = setup();
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "work", "rest");
    await env.terminals.send(env.host, box, "work", { text: "x" });
    const first = await env.terminals.read(env.host, box, "work", { lines: 10 });
    expect(first.lines).toEqual(["x"]);

    await env.terminals.send(env.host, box, "work", { text: "y" });
    const next = await env.terminals.read(env.host, box, "work", { lines: 10, since: first.cursor });
    expect(next).toMatchObject({ reset: false, lines: ["xy"] });
  });

  test("a cursor that cannot be continued resets to the current window", async () => {
    const env = setup();
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "work", "rest");
    await env.terminals.send(env.host, box, "work", { text: "a\nb\n" });
    const first = await env.terminals.read(env.host, box, "work", { lines: 10 });
    await env.terminals.send(env.host, box, "work", { text: "c\n" });
    await env.terminals.read(env.host, box, "work", { lines: 10, since: first.cursor });

    const stale = await env.terminals.read(env.host, box, "work", { lines: 10, since: first.cursor });
    expect(stale).toMatchObject({ reset: true, lines: ["a", "b", "c"] });
    const unknown = await env.terminals.read(env.host, box, "work", { lines: 10, since: "not-a-cursor" });
    expect(unknown).toMatchObject({ reset: true, lines: ["a", "b", "c"] });
  });

  test("truncated tells the reader the window was cut to the requested number of lines", async () => {
    const env = setup();
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "work", "rest");
    await env.terminals.send(env.host, box, "work", { text: "a\nb\nc\n" });

    const read = await env.terminals.read(env.host, box, "work", { lines: 2 });
    expect(read).toMatchObject({ truncated: true, lines: ["b", "c"] });
  });

  test("concurrent reads of one session are serialized and each gets its own cursor", async () => {
    const env = setup();
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "work", "rest");

    const [a, b] = await Promise.all([
      env.terminals.read(env.host, box, "work", { lines: 5 }),
      env.terminals.read(env.host, box, "work", { lines: 5 }),
    ]);
    expect(new Set([a.cursor, b.cursor]).size).toBe(2);
    expect(a.cursor.split(".")[0]).toBe(b.cursor.split(".")[0]);
  });
});

describe("terminal service: input", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("keys are sent as tmux key names and text as literal bytes", async () => {
    const env = setup();
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "work", "rest");

    expect(await env.terminals.send(env.host, box, "work", { keys: ["Enter"] })).toEqual({ keys: 1, bytes: 0 });
    expect(await env.terminals.send(env.host, box, "work", { text: "héllo" })).toEqual({ keys: 0, bytes: 6 });
    expect(env.runtime.tmux.paneText(box.id, "work")).toBe("\nhéllo");
  });

  test("text with leading dashes and semicolons is typed literally", async () => {
    const env = setup();
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "work", "rest");

    await env.terminals.send(env.host, box, "work", { text: "-l ; done" });
    expect(env.runtime.tmux.paneText(box.id, "work")).toBe("-l ; done");
  });

  test("an empty send does nothing", async () => {
    const env = setup();
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "work", "rest");

    expect(await env.terminals.send(env.host, box, "work", { text: "" })).toEqual({ keys: 0, bytes: 0 });
    expect(env.runtime.tmux.paneText(box.id, "work")).toBe("");
  });
});

describe("terminal service: takeover", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("the console opens an agent session read-only, and a takeover gives the human input and refuses the agent", async () => {
    const env = setup();
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "work", "rest");

    const viewer = await env.terminals.attach(env.host, box, "work", { source: "ui" });
    expect(viewer.view()).toMatchObject({ controller: "agent", canType: false, canTakeOver: true, canRelease: false });
    expect(viewer.write("ignored")).toBe(false);
    expect(env.runtime.tmux.paneText(box.id, "work")).toBe("");

    expect(env.terminals.takeOver(viewer)).toBe(true);
    expect(env.terminals.takeOver(viewer)).toBe(false);
    expect(viewer.view()).toMatchObject({ controller: "human", takenOver: true, canType: true, canRelease: true });
    expect(viewer.write("hi")).toBe(true);
    expect(env.runtime.tmux.paneText(box.id, "work")).toBe("hi");

    const refused = await rejectionOf(env.terminals.send(env.host, box, "work", { text: "agent" }));
    expect(refused).toMatchObject({
      status: 409,
      code: "taken_over",
      key: "session_taken_over",
      retryable: true,
      details: { session: "work" },
    });
    expect((refused as AppError).hintKey).toBe("session_taken_over_hint");
    expect(env.runtime.tmux.paneText(box.id, "work")).toBe("hi");

    const read = await env.terminals.read(env.host, box, "work", { lines: 10 });
    expect(read).toMatchObject({ controller: "human", lines: ["hi"] });

    expect(env.terminals.release(viewer)).toBe(true);
    expect(env.terminals.release(viewer)).toBe(false);
    expect(viewer.write("x")).toBe(false);
    expect(await env.terminals.send(env.host, box, "work", { text: "back" })).toEqual({ keys: 0, bytes: 4 });
    expect(env.runtime.tmux.paneText(box.id, "work")).toBe("hiback");
  });

  test("a bearer or CLI attachment is read-only: it cannot take over, release, or type", async () => {
    const env = setup();
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "mine", "ui");

    const human = await env.terminals.attach(env.host, box, "mine", { source: "ui" });
    expect(human.write("typed")).toBe(true);

    const bearer = await env.terminals.attach(env.host, box, "mine", { source: "rest" });
    expect(bearer.view()).toMatchObject({ canType: false, canTakeOver: false, canRelease: false });
    expect(env.terminals.takeOver(bearer)).toBe(false);
    expect(env.terminals.release(bearer)).toBe(false);
    expect(bearer.write("x")).toBe(false);
    expect(env.runtime.tmux.paneText(box.id, "mine")).toBe("typed");
  });

  test("a session a human created is held by the human, and is not returned on its own", async () => {
    const env = setup(40);
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "mine", "ui");

    await sleep(120);
    expect(await env.terminals.read(env.host, box, "mine", { lines: 5 })).toMatchObject({ controller: "human" });
    const refused = await rejectionOf(env.terminals.send(env.host, box, "mine", { text: "x" }));
    expect(refused).toMatchObject({ code: "taken_over" });
  });

  test("a takeover returns to the agent after the idle timeout, recorded as the system's return", async () => {
    const env = setup(60);
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "work", "rest");
    const viewer = await env.terminals.attach(env.host, box, "work", { source: "ui" });
    env.terminals.takeOver(viewer);

    await sleep(180);
    expect(await env.terminals.read(env.host, box, "work", { lines: 5 })).toMatchObject({ controller: "agent" });
    const release = env.recorded.find((r) => r.note.op === "session.release");
    expect(release).toMatchObject({
      source: "system",
      note: { status: "ok", detail: { session: "work", by: "idle" } },
    });
    expect(env.terminals.release(viewer)).toBe(false);
  });

  test("typing keeps a takeover alive, and the idle timer counts from the last keystroke", async () => {
    const env = setup(120);
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "work", "rest");
    const viewer = await env.terminals.attach(env.host, box, "work", { source: "ui" });
    env.terminals.takeOver(viewer);

    for (let i = 0; i < 5; i++) {
      await sleep(50);
      expect(viewer.write("a")).toBe(true);
    }
    expect(await env.terminals.read(env.host, box, "work", { lines: 5 })).toMatchObject({ controller: "human" });

    await sleep(300);
    expect(await env.terminals.read(env.host, box, "work", { lines: 5 })).toMatchObject({ controller: "agent" });
  });

  test("with no idle timeout a takeover lasts until it is released", async () => {
    const env = setup(0);
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "work", "rest");
    const viewer = await env.terminals.attach(env.host, box, "work", { source: "ui" });
    env.terminals.takeOver(viewer);

    await sleep(80);
    expect(await env.terminals.read(env.host, box, "work", { lines: 5 })).toMatchObject({ controller: "human" });
    env.terminals.release(viewer);
    expect(await env.terminals.read(env.host, box, "work", { lines: 5 })).toMatchObject({ controller: "agent" });
  });
});

describe("terminal service: attachments", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("opening records the session, and closing ends the attach process and records bytes once", async () => {
    const env = setup();
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "work", "rest");

    const viewer: Attachment = await env.terminals.attach(env.host, box, "work", { source: "ui" });
    expect(env.recorded.at(-1)).toMatchObject({
      source: "ui",
      note: { op: "terminal.open", status: "ok", target: { kind: "box", id: box.id }, detail: { session: "work" } },
    });

    env.terminals.takeOver(viewer);
    expect(viewer.write("abc")).toBe(true);
    viewer.resize({ cols: 80, rows: 24 });
    expect((viewer.exec as FakeExec).sizes).toEqual([{ cols: 80, rows: 24 }]);
    expect(await viewer.exec.inspect()).toMatchObject({ running: true });

    await viewer.close();
    expect(await viewer.exec.inspect()).toMatchObject({ running: false });
    expect(env.runtime.tmux.paneText(box.id, "work")).toBe("abc");
    expect(env.recorded.at(-1)).toMatchObject({
      note: { op: "terminal.close", status: "ok", detail: { session: "work", bytesIn: 3 } },
    });

    await viewer.close();
    expect(env.recorded.filter((r) => r.note.op === "terminal.close")).toHaveLength(1);
    expect(viewer.write("late")).toBe(false);
  });

  test("the attach process lives in the box as dev and carries the terminal environment", async () => {
    const env = setup();
    const box = await runningBox(env);
    await env.terminals.start(env.host, box, "work", "rest");

    const viewer = await env.terminals.attach(env.host, box, "work", { source: "ui" });
    expect((viewer.exec as FakeExec).spec).toMatchObject({
      cmd: ["tmux", "-u", "attach-session", "-t", "=work"],
      user: "dev",
      tty: true,
      workingDir: "/workspace",
    });
    await viewer.close();
  });
});
