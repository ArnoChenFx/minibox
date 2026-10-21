import { afterEach, describe, expect, mock, test } from "bun:test";

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
});
