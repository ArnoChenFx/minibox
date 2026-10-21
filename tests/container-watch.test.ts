import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AuditNote, Source } from "../src/events/types";
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

function setup() {
  const { app, runtime } = createTestApp({ labelPrefix: PREFIX });
  const recorded: Recorded[] = [];
  const watch = new ContainerWatch(app.hosts, (hostId, source, note) => recorded.push({ hostId, source, note }), {
    retryMinMs: 5,
    retryMaxMs: 20,
  });
  return { runtime, recorded, watch };
}

function containerEvent(action: string, id: string, attributes: Record<string, string> = BOX_LABELS): RuntimeEvent {
  return { type: "container", action, id, attributes, time: "2026-10-21T04:00:00Z" };
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(2);
  }
}

describe("container watch", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("start, stop and oom are recorded as container activity for the box, by the system", async () => {
    const { runtime, recorded, watch } = setup();
    watch.start();
    await waitFor(() => runtime.callsTo("events").length === 1, "the event stream");

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
    const { runtime, recorded, watch } = setup();
    watch.start();
    await waitFor(() => runtime.callsTo("events").length === 1, "the event stream");

    for (const action of ["create", "die", "kill", "destroy", "pause", "rename"]) {
      runtime.emitEvent(containerEvent(action, "c1"));
    }
    runtime.emitEvent(containerEvent("start", "c1"));
    await waitFor(() => recorded.length === 1, "the start that follows");
    watch.stop();

    expect(recorded.map((r) => r.note.op)).toEqual(["container.start"]);
  });

  test("containers that are not MiniBox boxes never reach the recorder", async () => {
    const { runtime, recorded, watch } = setup();
    watch.start();
    await waitFor(() => runtime.callsTo("events").length === 1, "the event stream");

    runtime.emitEvent(containerEvent("start", "other", { image: "nginx" }));
    runtime.emitEvent(containerEvent("start", "c1"));
    await waitFor(() => recorded.length === 1, "the box start");
    watch.stop();

    expect(recorded.map((r) => r.note.target?.id)).toEqual(["c1"]);
  });

  test("a box without a name label is named by its container", async () => {
    const { runtime, recorded, watch } = setup();
    watch.start();
    await waitFor(() => runtime.callsTo("events").length === 1, "the event stream");

    runtime.emitEvent(containerEvent("start", "c9", { [PREFIX]: "true", name: "minibox-legacy" }));
    await waitFor(() => recorded.length === 1, "the legacy box start");
    watch.stop();

    expect(recorded[0]?.note.target).toEqual({ kind: "box", id: "c9", name: "minibox-legacy" });
  });

  test("a failed stream is opened again after a pause", async () => {
    const { runtime, recorded, watch } = setup();
    runtime.fail("events", new RuntimeError("unavailable", "connect ECONNREFUSED fake-docker.sock"));
    watch.start();
    await waitFor(() => runtime.callsTo("events").length === 2, "the second subscription");

    runtime.emitEvent(containerEvent("start", "c1"));
    await waitFor(() => recorded.length === 1, "the event after the retry");
    watch.stop();

    expect(recorded.map((r) => r.note.op)).toEqual(["container.start"]);
  });

  test("stop ends the watch, so later events are not recorded", async () => {
    const { runtime, recorded, watch } = setup();
    watch.start();
    await waitFor(() => runtime.callsTo("events").length === 1, "the event stream");
    watch.stop();
    await Bun.sleep(10);

    runtime.emitEvent(containerEvent("start", "c1"));
    await Bun.sleep(10);

    expect(recorded).toEqual([]);
    expect(runtime.callsTo("events")).toHaveLength(1);
  });
});
