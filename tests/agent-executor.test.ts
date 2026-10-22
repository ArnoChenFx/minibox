import { describe, expect, test } from "bun:test";

import { AgentExecutor, type AgentSink } from "../src/agent/executor";
import type { AgentErrorInfo, ExecExit } from "../src/agent/protocol";
import { RuntimeError } from "../src/runtime";
import { FakeRuntime } from "./support/fake-runtime";

type Frame =
  | { type: "response"; id: string; ok: boolean; result?: unknown; error?: AgentErrorInfo }
  | { type: "item"; id: string; value: unknown }
  | { type: "data"; id: string; channel: "stdout" | "stderr"; text: string }
  | { type: "end"; id: string; error?: AgentErrorInfo; exit?: ExecExit };

function recorder() {
  const frames: Frame[] = [];
  const sink: AgentSink = {
    respond: (id, outcome) => frames.push({ type: "response", id, ...outcome } as Frame),
    item: (id, value) => frames.push({ type: "item", id, value }),
    data: (id, channel, bytes) => frames.push({ type: "data", id, channel, text: Buffer.from(bytes).toString() }),
    end: (id, error, exit) => frames.push({ type: "end", id, error, exit }),
  };
  return { sink, frames };
}

function responseTo(frames: Frame[], id: string): Extract<Frame, { type: "response" }> {
  const found = frames.find((frame): frame is Extract<Frame, { type: "response" }> => {
    return frame.type === "response" && frame.id === id;
  });
  if (!found) throw new Error(`no response to ${id}`);
  return found;
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(2);
  }
}

function setup() {
  const runtime = new FakeRuntime();
  const { sink, frames } = recorder();
  const executor = new AgentExecutor(runtime, sink);
  return { runtime, frames, executor };
}

describe("requests the agent runs", () => {
  test("a listed operation runs against the runtime and its result is sent back", async () => {
    const { executor, frames, runtime } = setup();
    await executor.request("r1", "ping", {});
    expect(responseTo(frames, "r1")).toMatchObject({ ok: true, result: {} });
    expect(runtime.ops()).toEqual(["ping"]);
  });

  test("a container listing passes its label filter through", async () => {
    const { executor, frames, runtime } = setup();
    runtime.seedContainer({ image: "alpine:3.20", name: "one", running: true, labels: { "mbtest.box": "true" } });
    await executor.request("r2", "listContainers", { labels: { "mbtest.box": "true" } });
    expect(responseTo(frames, "r2")).toMatchObject({ ok: true });
    expect((responseTo(frames, "r2") as { result: unknown[] }).result).toHaveLength(1);
  });

  test("an engine error keeps its kind and message", async () => {
    const { executor, frames, runtime } = setup();
    runtime.fail("inspectContainer", new RuntimeError("not_found", "no such box", "bx_missing"));
    await executor.request("r3", "inspectContainer", { id: "bx_missing" });
    expect(responseTo(frames, "r3")).toMatchObject({
      ok: false,
      error: { kind: "not_found", message: "no such box", detail: "bx_missing" },
    });
  });

  test("an operation outside the allowlist is refused as unsupported and never reaches the runtime", async () => {
    const { executor, frames, runtime } = setup();
    await executor.request("r4", "saveImage", { ref: "alpine:3.20" });
    expect(responseTo(frames, "r4")).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(runtime.ops()).not.toContain("saveImage");
  });

  test("an operation that is not in the protocol at all is refused as invalid", async () => {
    const { executor, frames, runtime } = setup();
    await executor.request("r5", "shell", { command: "cat /etc/shadow" });
    expect(responseTo(frames, "r5")).toMatchObject({
      ok: false,
      error: { kind: "invalid", message: "unknown operation shell" },
    });
    expect(runtime.ops()).toEqual([]);
  });

  test("arguments are checked before the runtime runs, and unknown keys are refused", async () => {
    const { executor, frames, runtime } = setup();
    await executor.request("r6", "inspectContainer", { id: "../etc", extra: true });
    expect(responseTo(frames, "r6")).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(runtime.ops()).toEqual([]);
  });

  test("a bind mount is refused, because an agent creates only named volumes", async () => {
    const { executor, frames, runtime } = setup();
    const spec = { image: "alpine:3.20", mounts: [{ source: "/etc", target: "/host-etc" }] };
    await executor.request("r7", "createContainer", { spec });
    expect(responseTo(frames, "r7")).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(runtime.ops()).toEqual([]);
  });

  test("a container on the host network is refused", async () => {
    const { executor, frames, runtime } = setup();
    await executor.request("r8", "createContainer", { spec: { image: "alpine:3.20", network: "host" } });
    expect(responseTo(frames, "r8")).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(runtime.ops()).toEqual([]);
  });

  test("a request id that is still in flight is refused, and the operation runs once", async () => {
    const { executor, frames, runtime } = setup();
    const held = runtime.hold("listContainers");
    const first = executor.request("r9", "listContainers", { labels: {} });
    await executor.request("r9", "listContainers", { labels: {} });
    expect(frames.filter((frame) => frame.type === "response" && frame.id === "r9")).toHaveLength(1);
    expect(frames).toEqual([
      {
        type: "response",
        id: "r9",
        ok: false,
        error: { kind: "invalid", message: "request id is in use", detail: "r9" },
      },
    ]);
    held.release();
    await first;
    expect(runtime.ops().filter((op) => op === "listContainers")).toHaveLength(1);
  });
});

describe("exec", () => {
  test("a command exec sends its output on each channel and then its exit state", async () => {
    const { executor, frames, runtime } = setup();
    const containerId = runtime.seedContainer({ image: "alpine:3.20", name: "box", running: true });
    runtime.execScript = { stdout: "hello\n", stderr: "warn\n", code: 3 };
    await executor.request("x1", "startExec", {
      containerId,
      spec: { cmd: ["sh", "-c", "echo"], env: [], workingDir: "/", tty: false },
    });
    expect(responseTo(frames, "x1")).toMatchObject({ ok: true, result: { execId: expect.any(String) } });
    await until(() => frames.some((frame) => frame.type === "end" && frame.id === "x1"));
    const output = frames.filter((frame) => frame.type === "data" && frame.id === "x1");
    expect(output).toEqual(
      expect.arrayContaining([
        { type: "data", id: "x1", channel: "stdout", text: "hello\n" },
        { type: "data", id: "x1", channel: "stderr", text: "warn\n" },
      ]),
    );
    const end = frames.find((frame) => frame.type === "end" && frame.id === "x1");
    expect(end).toMatchObject({ exit: { running: false, exitCode: 3 } });
  });

  test("a session call on an exec that has ended answers not_found", async () => {
    const { executor, frames } = setup();
    await executor.request("x2", "execInspect", { session: "no-such-session" });
    expect(responseTo(frames, "x2")).toMatchObject({ ok: false, error: { kind: "not_found" } });
  });

  test("closing the executor detaches an open exec and sends no end for it", async () => {
    const { executor, frames, runtime } = setup();
    const containerId = runtime.seedContainer({ image: "alpine:3.20", name: "shell", running: true });
    await executor.request("x3", "startExec", { containerId, spec: { cmd: ["sh"], env: [], workingDir: "/" } });
    const opened = responseTo(frames, "x3").result as { execId: string };
    executor.close();
    await Bun.sleep(10);
    expect(frames.some((frame) => frame.type === "end" && frame.id === "x3")).toBe(false);
    expect(opened.execId).toBeString();
  });
});

describe("streams", () => {
  test("an events stream sends each event as an item, and cancelling it ends the stream", async () => {
    const { executor, frames, runtime } = setup();
    await executor.request("e1", "events", { filter: {} });
    expect(responseTo(frames, "e1")).toMatchObject({ ok: true });
    await Bun.sleep(5);
    const event = {
      type: "container",
      action: "start",
      id: "c1",
      attributes: {},
      time: "2026-10-22T00:00:00.000Z",
      timeNano: 1,
    };
    runtime.emitEvent(event);
    await until(() => frames.some((frame) => frame.type === "item" && frame.id === "e1"));
    expect(frames.find((frame) => frame.type === "item")).toEqual({ type: "item", id: "e1", value: event });
    executor.cancel("e1");
    await until(() => frames.some((frame) => frame.type === "end" && frame.id === "e1"));
    expect(frames.find((frame) => frame.type === "end" && frame.id === "e1")).toMatchObject({ error: undefined });
  });
});

describe("volumes", () => {
  test("setting a volume's root owner passes the owner through to the runtime", async () => {
    const { executor, frames, runtime } = setup();
    runtime.seedImage("alpine:3.20");
    await executor.request("v1", "createVolume", { name: "data", labels: {} });
    await executor.request("v2", "setVolumeRootOwner", {
      volume: "data",
      owner: { uid: 1000, gid: 1000 },
      image: "alpine:3.20",
    });
    expect(responseTo(frames, "v2")).toMatchObject({ ok: true });
    expect(runtime.volumeOwners.get("data")).toEqual({ uid: 1000, gid: 1000 });
  });
});
