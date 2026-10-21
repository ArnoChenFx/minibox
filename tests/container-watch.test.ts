import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import type { AuditNote, Source } from "../src/events/types";
import { HostSampler } from "../src/host/sampler";
import { RuntimeError, type RuntimeEvent } from "../src/runtime";
import { ContainerWatch } from "../src/services/container-watch";
import { createTestApp, silenceLogs } from "./support/app";

interface Recorded {
  readonly hostId: string;
  readonly source: Source;
  readonly note: AuditNote;
}

const PREFIX = "mbtest";
const BOX_LABELS = { [PREFIX]: "true", [`${PREFIX}.name`]: "alpha" };

let restoreLogs: () => void;
let running: App | null = null;
let eventSeq = 0;

function setup() {
  const { app, runtime } = createTestApp({ labelPrefix: PREFIX });
  running = app;
  const recorded: Recorded[] = [];
  const watch = new ContainerWatch(app.hosts, (hostId, source, _principal, note) =>
    recorded.push({ hostId, source, note }),
  );
  return { app, runtime, recorded, watch };
}

/** Starts the host's sampler with short reconnect delays, and returns once its listing is in the cache. */
async function listen(app: App): Promise<void> {
  const host = app.hosts.get();
  host.sampler.stop();
  host.sampler = new HostSampler(
    () => host,
    { intervalMs: 60_000, history: 10, backoffMinMs: 5, backoffMaxMs: 20 },
    app.bus,
  );
  host.sampler.start();
  await waitFor(() => host.sampler.ready(), "the first listing");
  await host.sampler.settle();
}

function containerEvent(action: string, id: string, attributes: Record<string, string> = BOX_LABELS): RuntimeEvent {
  eventSeq += 1;
  return {
    type: "container",
    action,
    id,
    attributes,
    time: "2026-10-21T04:00:00Z",
    timeNano: Date.now() * 1_000_000 + eventSeq,
  };
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(2);
  }
}

describe("container watch", () => {
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => {
    running?.hosts.get().sampler.stop();
    running = null;
    restoreLogs();
  });

  test("start, stop and oom are recorded as container activity for the box, by the system", async () => {
    const { app, runtime, recorded, watch } = setup();
    await listen(app);
    watch.start();

    runtime.emitEvent(containerEvent("start", "c1"));
    runtime.emitEvent(containerEvent("stop", "c1"));
    runtime.emitEvent(containerEvent("oom", "c1"));
    await waitFor(() => recorded.length === 3, "three container events");
    watch.stop();

    expect(recorded.map((r) => r.note.op)).toEqual(["container.start", "container.stop", "container.oom"]);
    expect(recorded.every((r) => r.source === "system" && r.note.status === "ok" && r.note.kind === "write")).toBe(
      true,
    );
    expect(recorded[2]?.note.target).toEqual({ kind: "box", id: "c1", name: "alpha" });
    expect(recorded[2]?.note.summary).toBe("Container ran out of memory: alpha");
  });

  test("other container actions are not recorded", async () => {
    const { app, runtime, recorded, watch } = setup();
    await listen(app);
    watch.start();

    for (const action of ["create", "die", "kill", "destroy", "pause", "rename"]) {
      runtime.emitEvent(containerEvent(action, "c1"));
    }
    runtime.emitEvent(containerEvent("start", "c1"));
    await waitFor(() => recorded.length === 1, "the start that follows");
    watch.stop();

    expect(recorded.map((r) => r.note.op)).toEqual(["container.start"]);
  });

  test("containers that are not MiniBox boxes never reach the recorder", async () => {
    const { app, runtime, recorded, watch } = setup();
    await listen(app);
    watch.start();

    runtime.emitEvent(containerEvent("start", "other", { image: "nginx" }));
    runtime.emitEvent(containerEvent("start", "c1"));
    await waitFor(() => recorded.length === 1, "the box start");
    watch.stop();

    expect(recorded.map((r) => r.note.target?.id)).toEqual(["c1"]);
  });

  test("a box without a name label is named by its container", async () => {
    const { app, runtime, recorded, watch } = setup();
    await listen(app);
    watch.start();

    runtime.emitEvent(containerEvent("start", "c9", { [PREFIX]: "true", name: "minibox-legacy" }));
    await waitFor(() => recorded.length === 1, "the legacy box start");
    watch.stop();

    expect(recorded[0]?.note.target).toEqual({ kind: "box", id: "c9", name: "minibox-legacy" });
  });

  test("an event the engine replays is recorded once", async () => {
    const { app, runtime, recorded, watch } = setup();
    await listen(app);
    watch.start();

    const start = containerEvent("start", "c1");
    runtime.emitEvent(start);
    await waitFor(() => recorded.length === 1, "the start");
    runtime.emitEvent({ ...start });
    runtime.emitEvent(containerEvent("stop", "c1"));
    await waitFor(() => recorded.length === 2, "the stop after the replay");
    watch.stop();

    expect(recorded.map((r) => r.note.op)).toEqual(["container.start", "container.stop"]);
  });

  test("when the stream is reopened, it resumes from the newest event, and a replay of that event is not recorded", async () => {
    const { app, runtime, recorded, watch } = setup();
    await listen(app);
    watch.start();

    const start = containerEvent("start", "c1");
    runtime.emitEvent(start);
    await waitFor(() => recorded.length === 1, "the start");

    runtime.interruptEvents(new RuntimeError("unavailable", "connect ECONNREFUSED fake-docker.sock"));
    await waitFor(() => runtime.callsTo("events").length === 2, "the stream reopened");
    const since = (runtime.callsTo("events")[1]?.args[0] as { since?: number } | undefined)?.since;
    expect(since).toBe(Math.floor(start.timeNano / 1_000_000_000));

    runtime.emitEvent({ ...start });
    runtime.emitEvent(containerEvent("oom", "c1"));
    await waitFor(() => recorded.length === 2, "the oom after the reopen");
    watch.stop();

    expect(recorded.map((r) => r.note.op)).toEqual(["container.start", "container.oom"]);
  });

  test("stop ends the watch, so later events are not recorded", async () => {
    const { app, runtime, recorded, watch } = setup();
    await listen(app);
    watch.start();
    watch.stop();

    runtime.emitEvent(containerEvent("start", "c1"));
    await Bun.sleep(10);

    expect(recorded).toEqual([]);
    expect(runtime.callsTo("events")).toHaveLength(1);
  });
});
