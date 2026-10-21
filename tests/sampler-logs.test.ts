import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import type { LogEvent } from "../src/host/log-follow";
import { HostSampler, type SamplerOptions } from "../src/host/sampler";
import type { LabelKeys } from "../src/labels";
import { RuntimeError } from "../src/runtime";
import { deleteBox } from "../src/services/boxes";
import { createTestApp, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

let app: App;
let runtime: FakeRuntime;
let keys: LabelKeys;
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  ({ app, runtime } = createTestApp({ labelPrefix: "mbtest", metricsHistory: 10 }));
  keys = app.hosts.get().keys;
});

afterEach(() => {
  app.hosts.get().sampler.stop();
  restoreLogs();
});

async function waitFor(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

function seedBox(name: string, running: boolean): string {
  return runtime.seedContainer({
    image: app.cfg.baseTemplateTag,
    name: `mbtest-${name}`,
    labels: { [keys.box]: "true", [keys.name]: name },
    running,
  });
}

/** Starts the sampler and returns once its first listing is applied. */
async function started(): Promise<HostSampler> {
  const sampler = app.hosts.get().sampler;
  sampler.start();
  await waitFor(() => sampler.ready(), "the first listing");
  await sampler.settle();
  return sampler;
}

/** A sampler with short reconnect delays, so a test does not wait out the production backoff. */
function fastSampler(overrides: Partial<SamplerOptions> = {}): HostSampler {
  const host = app.hosts.get();
  host.sampler.stop();
  host.sampler = new HostSampler(
    () => host,
    { intervalMs: 60_000, history: 10, backoffMinMs: 5, backoffMaxMs: 20, ...overrides },
    app.bus,
  );
  return host.sampler;
}

function boxIdOf(sampler: HostSampler, name: string): string {
  const boxId = sampler.boxes({ withStats: false }).find((box) => box.name === name)?.boxId;
  if (!boxId) throw new Error(`no box named ${name}`);
  return boxId;
}

function listen(sampler: HostSampler, boxId: string): { events: LogEvent[] } {
  const events: LogEvent[] = [];
  sampler.logs.subscribe(boxId, (event) => events.push(event));
  return { events };
}

function bodies(events: LogEvent[]): string[] {
  return events.flatMap((event) =>
    event.kind === "line" ? [event.line.text.slice(event.line.text.indexOf(" ") + 1)] : [],
  );
}

function signalOf(index: number): AbortSignal | undefined {
  return (runtime.callsTo("followLogs")[index]?.args[1] as { signal?: AbortSignal } | undefined)?.signal;
}

describe("the log of a box, followed once by its host's sampler", () => {
  test("one follow serves every subscriber, and a box nobody reads is not followed", async () => {
    const alpha = seedBox("alpha", true);
    seedBox("beta", true);
    const sampler = await started();
    const boxId = boxIdOf(sampler, "alpha");
    expect(runtime.callsTo("followLogs")).toHaveLength(0);

    const heard = [listen(sampler, boxId), listen(sampler, boxId), listen(sampler, boxId)];
    await waitFor(() => runtime.callsTo("followLogs").length === 1, "the follow");
    runtime.appendLogs(alpha, "hello\n");
    await waitFor(() => heard.every((sub) => bodies(sub.events).length === 1), "the line at every subscriber");

    expect(runtime.callsTo("followLogs")).toHaveLength(1);
    expect(runtime.callsTo("followLogs")[0]?.args[0]).toBe(alpha);
    for (const sub of heard) expect(bodies(sub.events)).toEqual(["hello"]);
  });

  test("a stopped box is followed once, and followed again only when it starts", async () => {
    const gamma = seedBox("gamma", false);
    const sampler = await started();
    const sub = listen(sampler, boxIdOf(sampler, "gamma"));
    await waitFor(() => runtime.callsTo("followLogs").length === 1, "the follow of the stopped box");
    await Bun.sleep(30);
    expect(runtime.callsTo("followLogs")).toHaveLength(1);

    await runtime.startContainer(gamma);
    await waitFor(() => runtime.callsTo("followLogs").length === 2, "the follow after the start");
    runtime.appendLogs(gamma, "up\n");
    await waitFor(() => bodies(sub.events).length === 1, "the line after the start");
    expect(bodies(sub.events)).toEqual(["up"]);
  });

  test("a link that goes down pauses the follow, and the follow resumes once the link is live again", async () => {
    const delta = seedBox("delta", true);
    const sampler = fastSampler();
    sampler.start();
    await waitFor(() => sampler.ready(), "the first listing");
    const sub = listen(sampler, boxIdOf(sampler, "delta"));
    runtime.appendLogs(delta, "before\n");
    await waitFor(() => bodies(sub.events).length === 1, "the line before the drop");

    runtime.interruptEvents(new RuntimeError("unavailable", "connection reset"));
    await waitFor(() => !sampler.ready(), "the link going down");
    expect(signalOf(0)?.aborted).toBe(true);

    await waitFor(() => sampler.ready(), "the reconnect");
    await waitFor(() => runtime.callsTo("followLogs").length === 2, "the follow after the reconnect");
    runtime.appendLogs(delta, "after\n");
    await waitFor(() => bodies(sub.events).length === 2, "the line after the reconnect");
    expect(bodies(sub.events)).toEqual(["before", "after"]);
    expect(sub.events.map((event) => event.kind)).toEqual(["line", "line"]);
  });

  test("a box that is deleted closes its subscribers", async () => {
    seedBox("epsilon", true);
    const sampler = await started();
    const sub = listen(sampler, boxIdOf(sampler, "epsilon"));
    await waitFor(() => runtime.callsTo("followLogs").length === 1, "the follow");

    await deleteBox(app.hosts.get(), boxIdOf(sampler, "epsilon"), false);
    expect(sub.events.at(-1)).toEqual({ kind: "closed" });
  });

  test("stopping the sampler tells every subscriber it stopped, since the boxes still exist", async () => {
    seedBox("zeta", true);
    const sampler = await started();
    const sub = listen(sampler, boxIdOf(sampler, "zeta"));
    await waitFor(() => runtime.callsTo("followLogs").length === 1, "the follow");

    sampler.stop();
    expect(sub.events).toEqual([{ kind: "stopped" }]);
  });
});
