import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { FrameBuffer } from "../src/events/frames";
import { Bus } from "../src/lib/bus";
import { type TaskStreamOptions, taskStream } from "../src/tasks/stream";
import type { TaskStreamEvent } from "../src/tasks/types";
import { SseReader } from "./support/sse";

let readers: SseReader[] = [];

afterEach(async () => {
  for (const reader of readers) await reader.close();
  readers = [];
});

const emptyStore = { after: () => [], oldest: () => 0, head: () => 0 };

const log = (seq: number): TaskStreamEvent => ({
  taskId: "task",
  seq,
  ts: seq,
  kind: "log",
  text: "x".repeat(300),
});

function open(options: Partial<Omit<TaskStreamOptions, "store" | "subscribe" | "taskId">> = {}): SseReader {
  const bus = new Bus<{ task: TaskStreamEvent }>();
  const stream = taskStream({
    taskId: "task",
    store: emptyStore,
    subscribe: (listener) => bus.subscribe("task", listener),
    ...options,
  });
  const reader = new SseReader(stream.getReader());
  readers.push(reader);
  return reader;
}

describe("taskStream", () => {
  test("onEnd runs once when the signal aborts the stream", async () => {
    const controller = new AbortController();
    const onEnd = mock(() => {});
    const sse = open({ signal: controller.signal, onEnd });
    await sse.next();
    controller.abort();
    await expect(sse.next()).rejects.toThrow("the stream closed");
    await sse.close();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test("onEnd runs once when the reader cancels the stream", async () => {
    const onEnd = mock(() => {});
    const sse = open({ onEnd });
    await sse.next();
    await sse.close();
    await sse.close();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test("onEnd runs straight away for a signal that is already aborted", () => {
    const onEnd = mock(() => {});
    open({ signal: AbortSignal.abort(), onEnd });
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test("a reader past its byte budget is reset, and carries on from the newest event", async () => {
    const bus = new Bus<{ task: TaskStreamEvent }>();
    const stream = taskStream({
      taskId: "task",
      store: emptyStore,
      subscribe: (listener) => bus.subscribe("task", listener),
      pendingBytes: 1000,
    });
    const sse = new SseReader(stream.getReader());
    readers.push(sse);
    await Bun.sleep(0);
    for (let seq = 1; seq <= 4; seq++) bus.publish("task", log(seq));

    expect((await sse.next()).retry).toBe(3000);
    expect(await sse.next()).toMatchObject({ event: "reset", data: { after: 3 } });
    expect(await sse.next()).toMatchObject({ id: 4 });
  });

  test("a stream whose read throws ends with that error, runs onEnd once, and releases its subscription", async () => {
    const bus = new Bus<{ task: TaskStreamEvent }>();
    const onEnd = mock(() => {});
    const take = spyOn(FrameBuffer.prototype, "take").mockImplementationOnce(() => {
      throw new Error("frames unavailable");
    });
    const stream = taskStream({
      taskId: "task",
      store: emptyStore,
      subscribe: (listener) => bus.subscribe("task", listener),
      onEnd,
    });
    const sse = new SseReader(stream.getReader());
    readers.push(sse);
    try {
      await expect(sse.next()).rejects.toThrow("frames unavailable");
    } finally {
      take.mockRestore();
    }
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount("task")).toBe(0);
  });

  test("a stream that fails while it starts releases its subscription and runs onEnd once", async () => {
    const bus = new Bus<{ task: TaskStreamEvent }>();
    const onEnd = mock(() => {});
    const failing = {
      oldest: () => 0,
      head: () => 0,
      after: () => {
        throw new Error("store unavailable");
      },
    };
    expect(() =>
      taskStream({
        taskId: "task",
        store: failing,
        subscribe: (listener) => bus.subscribe("task", listener),
        after: 0,
        onEnd,
      }),
    ).toThrow("store unavailable");
    expect(bus.listenerCount("task")).toBe(0);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
