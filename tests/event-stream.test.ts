import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { FrameBuffer } from "../src/events/frames";
import { createRedactor } from "../src/events/redact";
import { EventStore, type StoredEvent } from "../src/events/store";
import { type EventStreamOptions, eventStream, type StreamStore } from "../src/events/stream";
import type { EventInput } from "../src/events/types";
import { ulid } from "../src/events/ulid";
import { Bus } from "../src/lib/bus";
import { SseReader } from "./support/sse";

const NOW = 1_750_000_000_000;
const MIB = 1024 * 1024;

interface Harness {
  readonly store: EventStore;
  readonly bus: Bus<{ event: StoredEvent }>;
  publish(overrides?: Partial<EventInput>): StoredEvent;
}

/** A store and a bus wired the way the app wires them: every append that is not merged is published. */
function harness(): Harness {
  const store = new EventStore(":memory:", createRedactor());
  const bus = new Bus<{ event: StoredEvent }>();
  return {
    store,
    bus,
    publish(overrides = {}) {
      const { event, merged } = store.append({
        id: ulid(),
        ts: NOW,
        durationMs: 1,
        status: "ok",
        op: "box.create",
        kind: "write",
        principal: { type: "owner", id: "owner", name: "owner" },
        source: "rest",
        hostId: "local",
        summary: "Create and start a box: alpha",
        target: { kind: "box", id: "c0ffee", name: "alpha" },
        ...overrides,
      });
      if (!merged) bus.publish("event", event);
      return event;
    },
  };
}

let readers: SseReader[] = [];
let stores: EventStore[] = [];

afterEach(async () => {
  for (const reader of readers) await reader.close();
  for (const store of stores) store.close();
  readers = [];
  stores = [];
});

function open(h: Harness, options: Partial<Omit<EventStreamOptions, "store" | "subscribe">> = {}): SseReader {
  stores.push(h.store);
  const stream = eventStream({
    store: h.store,
    subscribe: (listener) => h.bus.subscribe("event", listener),
    filter: {},
    ...options,
  });
  const reader = new SseReader(stream.getReader());
  readers.push(reader);
  return reader;
}

describe("eventStream", () => {
  test("a first connection gets the retry hint, then only the events published after it", async () => {
    const h = harness();
    h.publish({ summary: "before the connection" });
    const sse = open(h);
    expect((await sse.next()).retry).toBe(3000);
    const live = h.publish({ summary: "after the connection" });
    expect(await sse.next()).toMatchObject({ id: live.seq, data: { summary: "after the connection" } });
  });

  test("a reconnecting client is replayed the events after its Last-Event-ID, oldest first", async () => {
    const h = harness();
    h.publish();
    const second = h.publish();
    const third = h.publish();
    const fourth = h.publish();
    const sse = open(h, { lastId: second.seq });
    expect((await sse.next()).retry).toBe(3000);
    expect(await sse.next()).toMatchObject({ id: third.seq });
    expect(await sse.next()).toMatchObject({ id: fourth.seq });
    const live = h.publish();
    expect(await sse.next()).toMatchObject({ id: live.seq });
  });

  test("replay and live delivery both follow the filter", async () => {
    const h = harness();
    const created = h.publish({ op: "box.create" });
    h.publish({ op: "box.delete" });
    const sse = open(h, { filter: { op: "box.create" }, lastId: 0 });
    expect((await sse.next()).retry).toBe(3000);
    expect(await sse.next()).toMatchObject({ id: created.seq });
    h.publish({ op: "box.delete" });
    const again = h.publish({ op: "box.create" });
    expect(await sse.next()).toMatchObject({ id: again.seq });
  });

  test("a client that missed more than the replay limit is asked to reload the list, then carries on", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) h.publish();
    const sse = open(h, { lastId: 0, replayLimit: 2 });
    expect((await sse.next()).retry).toBe(3000);
    expect(await sse.next()).toMatchObject({ event: "reset", data: { after: 3 } });
    const live = h.publish();
    expect(await sse.next()).toMatchObject({ id: live.seq });
  });

  test("a client that falls behind by more than the pending limit is reset, and the frames it missed are dropped", async () => {
    const h = harness();
    const sse = open(h, { pendingLimit: 3 });
    expect((await sse.next()).retry).toBe(3000);
    for (let i = 0; i < 4; i++) h.publish();
    const fifth = h.publish();
    expect(await sse.next()).toMatchObject({ event: "reset", data: { after: 4 } });
    expect(await sse.next()).toMatchObject({ id: fifth.seq });
  });

  test("an idle stream sends a heartbeat comment so that proxies keep the connection open", async () => {
    const h = harness();
    const sse = open(h, { heartbeatMs: 5 });
    expect((await sse.next()).retry).toBe(3000);
    expect(await sse.next()).toMatchObject({ comment: "keep-alive" });
  });

  test("cancelling the reader removes the bus subscription, and later events are not queued", async () => {
    const h = harness();
    const sse = open(h);
    await sse.next();
    expect(h.bus.listenerCount("event")).toBe(1);
    await sse.close();
    expect(h.bus.listenerCount("event")).toBe(0);
    h.publish();
  });

  test("an aborted request signal ends the stream and removes the bus subscription", async () => {
    const h = harness();
    const controller = new AbortController();
    const sse = open(h, { signal: controller.signal });
    await sse.next();
    controller.abort();
    expect(h.bus.listenerCount("event")).toBe(0);
    await expect(sse.next()).rejects.toThrow("the stream closed");
  });

  test("a signal that is already aborted closes the stream without subscribing", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const sse = open(h, { signal: controller.signal });
    expect(h.bus.listenerCount("event")).toBe(0);
    await expect(sse.next()).rejects.toThrow("the stream closed");
  });

  test("onEnd runs once when the signal aborts the stream", async () => {
    const h = harness();
    const controller = new AbortController();
    const onEnd = mock(() => {});
    const sse = open(h, { signal: controller.signal, onEnd });
    await sse.next();
    controller.abort();
    await expect(sse.next()).rejects.toThrow("the stream closed");
    await sse.close();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test("onEnd runs once when the reader cancels the stream", async () => {
    const h = harness();
    const onEnd = mock(() => {});
    const sse = open(h, { onEnd });
    await sse.next();
    await sse.close();
    await sse.close();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test("a stream that fails while it starts releases its subscriptions and runs onEnd once", async () => {
    const h = harness();
    const live = fakeLive();
    const onEnd = mock(() => {});
    const failing: StreamStore = {
      head: () => 0,
      after: () => {
        throw new Error("store unavailable");
      },
    };
    stores.push(h.store);
    expect(() =>
      eventStream({
        store: failing,
        subscribe: (listener) => h.bus.subscribe("event", listener),
        filter: {},
        lastId: 0,
        live: live.source,
        onEnd,
      }),
    ).toThrow("store unavailable");
    expect(h.bus.listenerCount("event")).toBe(0);
    expect(live.listeners()).toBe(0);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test("a stream whose read throws ends with that error, runs onEnd once, and releases its subscriptions", async () => {
    const h = harness();
    const live = fakeLive();
    const onEnd = mock(() => {});
    const take = spyOn(FrameBuffer.prototype, "take").mockImplementationOnce(() => {
      throw new Error("frames unavailable");
    });
    try {
      const sse = open(h, { live: live.source, onEnd });
      await expect(sse.next()).rejects.toThrow("frames unavailable");
    } finally {
      take.mockRestore();
    }
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(h.bus.listenerCount("event")).toBe(0);
    expect(live.listeners()).toBe(0);
  });
});

/**
 * A live source whose frames a test sends by hand. Each `sync` is numbered, so a test can tell the snapshots apart.
 * With `syncBytes`, each `sync` carries that much padding, as a sync of many boxes does.
 */
function fakeLive(syncBytes = 0) {
  const senders = new Set<(frame: string, key?: string) => void>();
  let generation = 0;
  const padding = syncBytes > 0 ? "x".repeat(syncBytes) : undefined;
  return {
    listeners: () => senders.size,
    source: {
      sync: () => {
        generation += 1;
        const body = padding === undefined ? { generation } : { generation, padding };
        return `event: sync\ndata: ${JSON.stringify(body)}\n\n`;
      },
      subscribe: (send: (frame: string, key?: string) => void) => {
        senders.add(send);
        return () => {
          senders.delete(send);
        };
      },
    },
    send(frame: string, key?: string) {
      for (const send of senders) send(frame, key);
    },
  };
}

describe("eventStream with live state", () => {
  test("the sync frame follows the retry hint and the replay, and the live frames follow it", async () => {
    const h = harness();
    const first = h.publish({ summary: "stored before the stream" });
    const live = fakeLive();
    const sse = open(h, { lastId: 0, live: live.source });
    expect((await sse.next()).retry).toBe(3000);
    expect(await sse.next()).toMatchObject({ id: first.seq });
    expect(await sse.next()).toEqual({ event: "sync", data: { generation: 1 } });
  });

  test("live frames arrive in the order they are sent, and carry no id", async () => {
    const h = harness();
    const live = fakeLive();
    const sse = open(h, { live: live.source });
    await sse.next();
    await sse.next();
    live.send('event: box\ndata: {"n":1}\n\n');
    live.send('event: sample\ndata: {"n":2}\n\n');
    expect(await sse.next()).toEqual({ event: "box", data: { n: 1 } });
    expect(await sse.next()).toEqual({ event: "sample", data: { n: 2 } });
  });

  test("when frames overflow, the queue is cleared, then a reset and a fresh sync are sent", async () => {
    const h = harness();
    const live = fakeLive();
    const sse = open(h, { live: live.source, pendingLimit: 3 });
    await sse.next();
    await sse.next();
    for (let n = 0; n < 4; n++) live.send(`event: box\ndata: {"n":${n}}\n\n`);
    expect(await sse.next()).toMatchObject({ event: "reset", data: { after: 0 } });
    expect(await sse.next()).toEqual({ event: "sync", data: { generation: 2 } });
    live.send('event: box\ndata: {"n":4}\n\n');
    expect(await sse.next()).toEqual({ event: "box", data: { n: 4 } });
  });

  test("cancelling the reader removes the live subscription", async () => {
    const h = harness();
    const live = fakeLive();
    const sse = open(h, { live: live.source });
    await sse.next();
    await sse.next();
    expect(live.listeners()).toBe(1);
    await sse.close();
    expect(live.listeners()).toBe(0);
  });

  test("a slow reader is sent the latest sample and host frame, not each one in turn", async () => {
    const h = harness();
    const live = fakeLive();
    const sse = open(h, { live: live.source });
    await Bun.sleep(0);
    for (const n of [1, 2, 3]) live.send(`event: sample\ndata: {"n":${n}}\n\n`, "sample:local");
    for (const n of [1, 2]) live.send(`event: host\ndata: {"n":${n}}\n\n`, "host:local");
    live.send('event: box\ndata: {"n":9}\n\n');

    expect((await sse.next()).retry).toBe(3000);
    expect(await sse.next()).toEqual({ event: "sync", data: { generation: 1 } });
    expect(await sse.next()).toEqual({ event: "sample", data: { n: 3 } });
    expect(await sse.next()).toEqual({ event: "host", data: { n: 2 } });
    expect(await sse.next()).toEqual({ event: "box", data: { n: 9 } });
  });

  test("a slow reader past its byte budget is reset, then sent a fresh sync", async () => {
    const h = harness();
    const live = fakeLive();
    const sse = open(h, { live: live.source, pendingBytes: 1000 });
    await Bun.sleep(0);
    const large = `event: box\ndata: "${"x".repeat(300)}"\n\n`;
    for (let n = 0; n < 4; n++) live.send(large);

    expect((await sse.next()).retry).toBe(3000);
    expect(await sse.next()).toEqual({ event: "sync", data: { generation: 1 } });
    expect(await sse.next()).toMatchObject({ event: "reset" });
    expect(await sse.next()).toEqual({ event: "sync", data: { generation: 2 } });
    live.send('event: box\ndata: {"n":4}\n\n');
    expect(await sse.next()).toEqual({ event: "box", data: { n: 4 } });
  });

  test("a sync frame over the byte budget is sent whole, and the live frames behind it are not reset", async () => {
    const h = harness();
    const live = fakeLive(2 * MIB);
    const sse = open(h, { live: live.source });
    for (let n = 0; n < 5; n++) live.send(`event: box\ndata: {"n":${n}}\n\n`);

    expect((await sse.next()).retry).toBe(3000);
    expect(await sse.next()).toMatchObject({ event: "sync", data: { generation: 1 } });
    for (let n = 0; n < 5; n++) expect(await sse.next()).toEqual({ event: "box", data: { n } });
  });

  test("a client more than twice a sync frame behind is reset once, then carries on from a fresh sync", async () => {
    const h = harness();
    const live = fakeLive(2 * MIB);
    const sse = open(h, { live: live.source });
    await Bun.sleep(0);
    const large = `event: box\ndata: "${"x".repeat((3 * MIB) / 2)}"\n\n`;
    for (let n = 0; n < 3; n++) live.send(large);

    expect((await sse.next()).retry).toBe(3000);
    expect(await sse.next()).toMatchObject({ event: "sync", data: { generation: 1 } });
    expect(await sse.next()).toMatchObject({ event: "reset", data: { after: 0 } });
    expect(await sse.next()).toMatchObject({ event: "sync", data: { generation: 2 } });
    live.send('event: box\ndata: {"n":4}\n\n');
    expect(await sse.next()).toEqual({ event: "box", data: { n: 4 } });
  });
});
