import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StoredEvent } from "../src/events/store";
import type { AuditNote } from "../src/events/types";
import type { LinkFrame } from "../src/host/live";
import type { Outgoing } from "../src/notify/channels";
import { backoffMs, Notifications, type NotificationsOptions } from "../src/notify/service";
import { NotifyStore } from "../src/notify/store";
import { DeliveryError } from "../src/notify/transport";
import type { Notice, StoredChannel } from "../src/notify/types";
import { SecretStore } from "../src/secrets/store";
import { silenceLogs } from "./support/app";

const NOW = Date.UTC(2026, 9, 22, 10, 0, 0);
const DEDUP_MS = 5 * 60_000;

let dataDir: string;
let restoreLogs: () => void;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mbx-notify-service-"));
  restoreLogs = silenceLogs();
});

afterEach(() => {
  restoreLogs();
  rmSync(dataDir, { recursive: true, force: true });
});

function channelOf(patch: Partial<StoredChannel> = {}): StoredChannel {
  return {
    id: "ops",
    type: "webhook",
    name: "Ops",
    enabled: true,
    events: ["box.oom", "exec.failed", "host.offline"],
    boxes: [],
    url: "https://hooks.example.com/minibox",
    server: null,
    topic: null,
    chatId: null,
    createdAt: "2026-10-22T09:00:00.000Z",
    updatedAt: "2026-10-22T09:00:00.000Z",
    ...patch,
  };
}

const oomOf = (box: string): Notice => ({
  kind: "box.oom",
  title: `Box ran out of memory: ${box}`,
  box: { name: box, ids: [`bx_${box}`] },
  at: NOW,
});

/**
 * A notifier over a real store, with a transport the test controls. `outcomes` is consumed one send at a time: a number
 * is the status returned, an error is thrown. Once it runs out every send answers 200.
 */
function setup(overrides: Partial<NotificationsOptions> = {}, outcomes: (number | Error)[] = []) {
  const store = new NotifyStore(dataDir, {
    secrets: new SecretStore(dataDir, "notify"),
    onSecret: () => {},
  });
  store.load();
  const sent: Outgoing[] = [];
  const notes: AuditNote[] = [];
  const sleeps: number[] = [];
  const clock = { now: NOW };
  const notify = new Notifications({
    store,
    version: "0.6.0",
    allowPrivate: false,
    record: (note) => notes.push(note),
    transport: async (request) => {
      sent.push(request);
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return next ?? 200;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => clock.now,
    ...overrides,
  });
  return { store, notify, sent, notes, sleeps, clock };
}

function eventOf(patch: Partial<StoredEvent> & Pick<StoredEvent, "op">): StoredEvent {
  return {
    id: "01JSERVICE00000000000000A",
    ts: NOW,
    durationMs: 0,
    status: "ok",
    kind: "write",
    principal: { type: "system", id: "system", name: "system" },
    source: "system",
    hostId: "local",
    summary: "",
    seq: 1,
    tier: "activity",
    count: 1,
    ...patch,
  } as StoredEvent;
}

const frame = (hostId: string, state: LinkFrame["state"], error: string | null): LinkFrame => ({
  hostId,
  state,
  error,
  at: new Date(NOW).toISOString(),
});

/** The delivery records the notifier wrote, in the order it wrote them. */
function deliveriesOf(notes: AuditNote[]) {
  return notes.filter((note) => note.op === "notify.deliver");
}

describe("queuing notices", () => {
  test("notify returns before any channel answers, and idle waits for the answer", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: string[] = [];
    const { store, notify } = setup({
      transport: async (request) => {
        sent.push(request.url);
        await gate;
        return 200;
      },
    });
    store.save(channelOf());

    notify.notify(oomOf("alpha"));
    let idle = false;
    void notify.idle().then(() => {
      idle = true;
    });
    await Bun.sleep(10);
    expect(idle).toBe(false);

    release();
    await notify.idle();
    expect(idle).toBe(true);
    expect(sent).toEqual(["https://hooks.example.com/minibox"]);
  });

  test("a notice goes to each enabled channel that takes its kind, and to no other", async () => {
    const { store, notify, sent } = setup();
    store.save(channelOf({ id: "both" }));
    store.save(channelOf({ id: "off", enabled: false }));
    store.save(channelOf({ id: "exec-only", events: ["exec.failed"] }));

    notify.notify(oomOf("alpha"));
    await notify.idle();
    expect(sent).toHaveLength(1);
  });

  test("a box filter sends a channel only the boxes it names", async () => {
    const { store, notify, sent } = setup();
    store.save(channelOf({ id: "alpha-only", boxes: ["alpha"] }));

    notify.notify(oomOf("alpha"));
    notify.notify(oomOf("beta"));
    await notify.idle();
    expect(sent).toHaveLength(1);
  });

  test("the same notice is sent once per channel within the dedup window, and again after it", async () => {
    const { store, notify, sent, clock } = setup();
    store.save(channelOf({ id: "a" }));
    store.save(channelOf({ id: "b", createdAt: "2026-10-22T09:01:00.000Z" }));

    notify.notify(oomOf("alpha"));
    notify.notify(oomOf("alpha"));
    await notify.idle();
    expect(sent).toHaveLength(2);

    clock.now = NOW + DEDUP_MS - 1;
    notify.notify(oomOf("alpha"));
    await notify.idle();
    expect(sent).toHaveLength(2);

    clock.now = NOW + DEDUP_MS;
    notify.notify(oomOf("alpha"));
    await notify.idle();
    expect(sent).toHaveLength(4);
  });

  test("a dedup key decides which notices count as the same one", async () => {
    const { store, notify, sent } = setup();
    store.save(channelOf());

    notify.notify({ ...oomOf("alpha"), dedupKey: "fleet-oom" });
    notify.notify({ ...oomOf("beta"), dedupKey: "fleet-oom" });
    notify.notify(oomOf("gamma"));
    await notify.idle();
    expect(sent).toHaveLength(2);
  });

  test("a queue that is full records the notice as queue_full and keeps what is already queued", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store, notify, sent, notes } = setup({
      maxQueue: 1,
      concurrency: 1,
      transport: async (request) => {
        sent.push(request);
        await gate;
        return 200;
      },
    });
    store.save(channelOf());

    notify.notify(oomOf("alpha"));
    notify.notify(oomOf("beta"));
    notify.notify(oomOf("gamma"));
    expect(deliveriesOf(notes)).toEqual([
      expect.objectContaining({
        status: "error",
        detail: expect.objectContaining({ attempts: 0, error: "queue_full", notice: "box.oom" }),
      }),
    ]);

    release();
    await notify.idle();
    expect(sent).toHaveLength(2);
    expect(deliveriesOf(notes).map((note) => note.status)).toEqual(["error", "ok", "ok"]);
  });

  test("stop drops what is queued and ignores later notices, and idle resolves once the send in flight ends", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store, notify, sent } = setup({
      concurrency: 1,
      transport: async (request) => {
        sent.push(request);
        await gate;
        return 200;
      },
    });
    store.save(channelOf());

    notify.notify(oomOf("alpha"));
    notify.notify(oomOf("beta"));
    notify.stop();
    notify.notify(oomOf("gamma"));
    release();
    await notify.idle();
    expect(sent).toHaveLength(1);
  });

  test("a record hook that throws does not stop the delivery or reach the caller", async () => {
    const { store, notify, sent } = setup({
      record: () => {
        throw new Error("disk full");
      },
    });
    store.save(channelOf());

    expect(() => notify.notify(oomOf("alpha"))).not.toThrow();
    await notify.idle();
    expect(sent).toHaveLength(1);
  });
});

describe("retries and the record of each delivery", () => {
  test("a server error is retried with growing waits, then recorded once as failed with its attempts", async () => {
    const { store, notify, sleeps, notes } = setup({}, [500, 500, 500]);
    store.save(channelOf());

    notify.notify(oomOf("alpha"));
    await notify.idle();

    expect(sleeps).toEqual([1000, 2000]);
    expect(deliveriesOf(notes)).toEqual([
      expect.objectContaining({
        op: "notify.deliver",
        kind: "write",
        status: "error",
        target: { kind: "notify", id: "ops", name: "Ops" },
        error: { code: "delivery_failed", status: 502 },
        detail: expect.objectContaining({
          attempts: 3,
          httpStatus: 500,
          error: "http_500",
          notice: "box.oom",
          channel: "ops",
          type: "webhook",
          title: "Box ran out of memory: alpha",
        }),
      }),
    ]);
  });

  test("a 429 is retried, and a client error is not", async () => {
    const retried = setup({}, [429, 200]);
    retried.store.save(channelOf());
    retried.notify.notify(oomOf("alpha"));
    await retried.notify.idle();
    expect(deliveriesOf(retried.notes)).toEqual([
      expect.objectContaining({ status: "ok", detail: expect.objectContaining({ attempts: 2, httpStatus: 200 }) }),
    ]);

    const refused = setup({}, [400]);
    refused.store.save(channelOf());
    refused.notify.notify(oomOf("alpha"));
    await refused.notify.idle();
    expect(refused.sleeps).toEqual([]);
    expect(deliveriesOf(refused.notes)).toEqual([
      expect.objectContaining({ status: "error", detail: expect.objectContaining({ attempts: 1, error: "http_400" }) }),
    ]);
  });

  test("a timeout or a network failure is retried until a send gets through", async () => {
    const { store, notify, sleeps, notes } = setup({}, [
      new DeliveryError("timeout"),
      new DeliveryError("network"),
      200,
    ]);
    store.save(channelOf());

    notify.notify(oomOf("alpha"));
    await notify.idle();
    expect(sleeps).toEqual([1000, 2000]);
    expect(deliveriesOf(notes)).toEqual([
      expect.objectContaining({ status: "ok", detail: expect.objectContaining({ attempts: 3, error: null }) }),
    ]);
  });

  test("a failure that retrying cannot fix is recorded after one attempt", async () => {
    const { store, notify, sleeps, notes } = setup({}, [new DeliveryError("blocked_address")]);
    store.save(channelOf());

    notify.notify(oomOf("alpha"));
    await notify.idle();
    expect(sleeps).toEqual([]);
    expect(deliveriesOf(notes)).toEqual([
      expect.objectContaining({
        status: "error",
        detail: expect.objectContaining({ attempts: 1, httpStatus: null, error: "blocked_address" }),
      }),
    ]);
  });

  test("an unexpected error is recorded as unexpected, and does not stop another channel's delivery", async () => {
    const { store, notify, notes } = setup({}, [new Error("boom"), 200]);
    store.save(channelOf({ id: "broken" }));
    store.save(channelOf({ id: "fine", createdAt: "2026-10-22T09:01:00.000Z" }));

    notify.notify(oomOf("alpha"));
    await notify.idle();
    const byChannel = Object.fromEntries(
      deliveriesOf(notes).map((note) => [(note.detail as { channel: string }).channel, note]),
    );
    expect(byChannel.broken).toMatchObject({ status: "error", detail: { error: "unexpected", attempts: 1 } });
    expect(byChannel.fine).toMatchObject({ status: "ok", detail: { attempts: 1 } });
  });

  test("backoff doubles from one second and stops at its cap", () => {
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(2)).toBe(2000);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(10, 30_000)).toBe(30_000);
  });
});

describe("test sends", () => {
  test("a test is one attempt that reports the answer, ignores the kinds the channel takes, and is never deduplicated", async () => {
    const { store, notify, sent, sleeps, notes } = setup({}, [500, 200]);
    store.save(channelOf({ id: "ops", events: ["exec.failed"] }));

    const first = await notify.test("ops");
    expect(first).toEqual({ ok: false, status: 500, attempts: 1, error: "http_500" });
    expect(sleeps).toEqual([]);

    const second = await notify.test("ops");
    expect(second).toEqual({ ok: true, status: 200, attempts: 1, error: null });
    expect(sent).toHaveLength(2);
    expect(deliveriesOf(notes).map((note) => (note.detail as { notice: string }).notice)).toEqual([
      "notify.test",
      "notify.test",
    ]);
  });

  test("a test of a channel that does not exist is an error", async () => {
    const { notify } = setup();
    await expect(notify.test("missing")).rejects.toThrow("no notification channel missing");
  });
});

describe("what a notice may carry", () => {
  test("the title and body pass the redactor, and are cut to size before they go out", async () => {
    const { store, notify, sent, notes } = setup({
      redact: (text) => text.replaceAll("hook-secret-token", "[hidden]"),
    });
    store.save(channelOf());

    notify.notify({
      kind: "exec.failed",
      title: "Command failed in hook-secret-token",
      body: `${"y".repeat(600)}hook-secret-token`,
      at: NOW,
    });
    await notify.idle();

    expect(sent).toHaveLength(1);
    const payload = JSON.parse(sent[0]?.body ?? "{}") as { title: string; body: string };
    expect(payload.title).toBe("Command failed in [hidden]");
    expect(payload.body).toHaveLength(500);
    expect(sent[0]?.body).not.toContain("hook-secret-token");
    expect(JSON.stringify(deliveriesOf(notes))).not.toContain("hook-secret-token");
  });

  test("a stored signing secret reaches the receiver only as a signature, never in the body, headers or record", async () => {
    const { store, notify, sent, notes } = setup();
    store.save(channelOf());
    store.setSecret("ops", "signing-secret-value-1");

    notify.notify(oomOf("alpha"));
    await notify.idle();

    expect(sent).toHaveLength(1);
    const request = sent[0];
    expect(request?.body).not.toContain("signing-secret-value-1");
    expect(request?.headers["x-minibox-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(JSON.stringify(deliveriesOf(notes))).not.toContain("signing-secret-value-1");
  });
});

describe("events and host state", () => {
  test("an event that calls for a notice is queued, and any other event is ignored", async () => {
    const { store, notify, sent } = setup();
    store.save(channelOf());

    notify.onEvent(eventOf({ op: "exec.start", target: { kind: "box", id: "cid", name: "alpha" } }));
    notify.onEvent(eventOf({ op: "notify.deliver", status: "error", detail: {} }));
    await notify.idle();
    expect(sent).toHaveLength(0);

    notify.onEvent(
      eventOf({
        op: "exec.finish",
        target: { kind: "box", id: "cid", name: "alpha" },
        detail: { boxId: "bx_alpha", exitCode: 2, timedOut: false },
      }),
    );
    await notify.idle();
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? "{}")).toMatchObject({ kind: "exec.failed", body: "Exit code 2." });
  });

  test("a host that goes down after it was live is an outage, and a host first seen down is not", async () => {
    const { store, notify, sent } = setup();
    store.save(channelOf());
    notify.onLink(frame("h1", "live", null));
    notify.onLink(frame("h1", "down", "connection refused"));
    notify.onLink(frame("h1", "down", null));
    notify.onLink(frame("h2", "down", "connection refused"));
    await notify.idle();

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? "{}")).toMatchObject({
      kind: "host.offline",
      title: "Host h1 is offline",
      body: "connection refused",
      host: "h1",
    });
  });
});
