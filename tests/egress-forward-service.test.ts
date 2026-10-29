import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import { normalizeEgress } from "../src/egress/policy";
import type { HostCtx } from "../src/host/registry";
import { AppError } from "../src/lib/errors";
import { setLogSink } from "../src/lib/logger";
import type { HostForwardCheck } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { EgressForwardWatcher } from "../src/services/egress-forward";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

const FORWARDING: HostForwardCheck = { forwarding: true, detail: "iptables accepts br-000000000000" };
const DROPPED: HostForwardCheck = {
  forwarding: false,
  detail: "iptables FORWARD policy is DROP and no rule accepts br-000000000000",
};

let app: App;
let runtime: FakeRuntime;
let host: HostCtx;
let watcher: EgressForwardWatcher;
let restoreLogs: () => void;
let restoreSink: () => void;
let lines: string[];

beforeAll(() => {
  restoreLogs = silenceLogs();
});
afterAll(() => restoreLogs());

beforeEach(() => {
  ({ app, runtime } = createTestApp({ labelPrefix: "mbtest" }));
  host = app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, {
    [host.keys.template]: "true",
    [host.keys.templateName]: "base",
  });
  watcher = app.egressForward;
  lines = [];
  restoreSink = setLogSink((_level, line) => lines.push(line));
});

afterEach(() => {
  restoreSink();
});

const proxyOnly = () => normalizeEgress({ mode: "proxy-only", domains: ["example.com"] });

const newBox = (name: string, extra: Partial<Parameters<typeof boxes.createBox>[1]> = {}) =>
  boxes.createBox(host, { name, cpus: 1, memoryMb: 256, ...extra });

/** A `proxy-only` box, which creates the uplink its proxy sits on. */
async function gated(name = "gated") {
  return newBox(name, { egress: proxyOnly() });
}

const errors = () => lines.filter((line) => line.includes('"level":"error"'));
const forwardCalls = () => runtime.callsTo("checkHostForward").length;

describe("the pass reads the host only when it has something to read", () => {
  test("a host with no proxy-only box makes no engine call at all", async () => {
    await newBox("plain");
    await watcher.tick();
    expect(forwardCalls()).toBe(0);
    expect(watcher.stateOf(host.host.id)).toBeNull();
  });

  test("a proxy-only box makes one pass, which reads the uplink's bridge", async () => {
    await gated();
    await watcher.tick();
    expect(forwardCalls()).toBe(1);
    const call = runtime.callsTo("checkHostForward")[0];
    expect(call?.args[0]).toBe("mbtest");
    expect(String(call?.args[1])).toMatch(/^br-/);
    expect(call?.args[2]).toBe("240.0.0.0/24");
    expect(watcher.stateOf(host.host.id)).toMatchObject({ forwarding: true, boxes: ["gated"], skipped: null });
  });

  test("a second pass over rules that are fine makes no engine call", async () => {
    await gated();
    await watcher.tick();
    await watcher.tick();
    expect(forwardCalls()).toBe(1);
  });

  test("a box starting asks for a fresh reading, which is the moment the owner looks", async () => {
    await gated();
    await watcher.tick();
    await watcher.tick();
    watcher.boxStarted(host.host.id);
    await watcher.tick();
    expect(forwardCalls()).toBe(2);
  });

  test("a host coming back online asks for a fresh reading too", async () => {
    await gated();
    await watcher.tick();
    watcher.hostOnline(host.host.id);
    await watcher.tick();
    expect(forwardCalls()).toBe(2);
  });

  test("an agent host is skipped with a reason, and the reason is what the overview reads", async () => {
    host.host.transport = "agent";
    await gated();
    await watcher.tick();
    expect(forwardCalls()).toBe(0);
    expect(watcher.stateOf(host.host.id)).toMatchObject({
      forwarding: false,
      skipped: expect.stringContaining("agent"),
    });
  });
});

describe("when the passes happen", () => {
  test("start runs a pass soon after it, and stop ends the passes", async () => {
    await gated();
    const fresh = new EgressForwardWatcher({ hosts: app.hosts, everyMs: 40 });
    fresh.start();
    await Bun.sleep(80);
    expect(forwardCalls()).toBe(1);
    fresh.stop();
    await Bun.sleep(80);
    expect(forwardCalls()).toBe(1);
  });

  test("a proxy-only box starting asks for a pass, and an open box starting does not", async () => {
    await newBox("plain");
    await boxes.startBox(host, "plain");
    await watcher.tick();
    expect(forwardCalls()).toBe(0);
    await gated();
    await boxes.startBox(host, "gated");
    await watcher.tick();
    expect(forwardCalls()).toBe(1);
  });
});

describe("one error line when the condition appears, and silence after it", () => {
  test("a dropped uplink logs once, names the host and the boxes, and says what to do", async () => {
    runtime.forwardVerdict = DROPPED;
    await gated();
    await watcher.tick();
    expect(errors()).toHaveLength(1);
    const entry = JSON.parse(errors()[0] ?? "{}") as Record<string, unknown>;
    expect(entry).toMatchObject({ msg: "egress.forward_blocked", host: host.host.id, boxes: ["gated"] });
    expect(String(entry.action)).toContain("network-egress.md");
  });

  test("the passes after it stay quiet, so a condition that lasts does not spam the log", async () => {
    runtime.forwardVerdict = DROPPED;
    await gated();
    await watcher.tick();
    watcher.hostOnline(host.host.id);
    await watcher.tick();
    await watcher.tick();
    expect(errors()).toHaveLength(1);
  });

  test("a rule dropped while MiniBox runs is found by the next pass and logged once", async () => {
    await gated();
    await watcher.tick();
    expect(errors()).toHaveLength(0);
    runtime.forwardVerdict = DROPPED;
    watcher.hostOnline(host.host.id);
    await watcher.tick();
    expect(errors()).toHaveLength(1);
    expect(watcher.stateOf(host.host.id)?.forwarding).toBe(false);
  });

  test("a rule that comes back logs one line and clears the condition", async () => {
    runtime.forwardVerdict = DROPPED;
    await gated();
    await watcher.tick();
    runtime.forwardVerdict = FORWARDING;
    watcher.hostOnline(host.host.id);
    await watcher.tick();
    const restored = lines.filter((line) => line.includes("egress.forward_restored"));
    expect(restored).toHaveLength(1);
    expect(watcher.stateOf(host.host.id)?.forwarding).toBe(true);
  });
});

describe("the owner's repair, and nothing before it", () => {
  test("a pass never changes the host's firewall", async () => {
    runtime.forwardVerdict = DROPPED;
    await gated();
    await watcher.tick();
    expect(runtime.callsTo("allowHostForward")).toEqual([]);
  });

  test("a confirmed repair adds the rule for the bridge the check read, then reads again", async () => {
    runtime.forwardVerdict = DROPPED;
    await gated();
    await watcher.tick();
    runtime.forwardVerdict = FORWARDING;
    const state = await watcher.repair(host);
    expect(runtime.callsTo("allowHostForward")).toHaveLength(1);
    expect(runtime.callsTo("allowHostForward")[0]?.args).toEqual(["mbtest", state.bridge]);
    expect(state).toMatchObject({ forwarding: true, repaired: true });
  });

  test("a pass already reading the host is waited out, so the repair's answer is a reading taken after the rule", async () => {
    runtime.forwardVerdict = DROPPED;
    await gated();
    await watcher.tick();
    // The pass in flight when the repair runs read the rules as they were before it, and the repair's own pass reads
    // them as they are after it. Holding the first one makes that order visible: without the wait, the repair would
    // answer with the reading taken before the rule went in.
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const reads = [DROPPED, FORWARDING];
    let calls = 0;
    runtime.checkHostForward = async () => {
      const verdict = reads[calls] ?? FORWARDING;
      calls += 1;
      if (calls === 1) {
        entered.resolve();
        await gate.promise;
      }
      return verdict;
    };
    watcher.hostOnline(host.host.id);
    const pass = watcher.tick();
    await entered.promise;
    const repaired = watcher.repair(host);
    gate.resolve();
    await pass;
    expect(await repaired).toMatchObject({ forwarding: true, repaired: true });
  });

  test("a repair that did not work still reports the condition, so the warning stays", async () => {
    runtime.forwardVerdict = DROPPED;
    await gated();
    await watcher.tick();
    const state = await watcher.repair(host);
    expect(state.forwarding).toBe(false);
  });

  test("a host with no proxy-only box refuses the repair instead of touching the firewall", async () => {
    await newBox("plain");
    const error = await rejectionOf(watcher.repair(host));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 409, key: "egress_forward_no_boxes" });
    expect(runtime.callsTo("allowHostForward")).toEqual([]);
  });

  test("a host whose rules were never read refuses the repair, since the bridge is not known", async () => {
    await gated();
    const error = await rejectionOf(watcher.repair(host));
    expect(error).toMatchObject({ status: 409, key: "egress_forward_unchecked" });
    expect(runtime.callsTo("allowHostForward")).toEqual([]);
  });

  test("an agent host refuses the repair with the reason the check gave", async () => {
    host.host.transport = "agent";
    await gated();
    await watcher.tick();
    const error = await rejectionOf(watcher.repair(host));
    expect(error).toMatchObject({ status: 409, key: "egress_forward_unsupported" });
  });

  test("the repaired state is dropped when the next pass finds the rules right", async () => {
    runtime.forwardVerdict = DROPPED;
    await gated();
    await watcher.tick();
    await watcher.repair(host);
    runtime.forwardVerdict = FORWARDING;
    watcher.hostOnline(host.host.id);
    await watcher.tick();
    expect(watcher.stateOf(host.host.id)?.repaired).toBe(false);
  });
});

describe("a check that cannot run, and a host that went away", () => {
  test("a host whose uplink is missing is not reported as a firewall problem", async () => {
    // The box spec exists but its network does not, as after a `docker network prune` while MiniBox was down.
    await gated();
    for (const name of runtime.networks.keys()) runtime.networks.delete(name);
    runtime.forwardVerdict = DROPPED;
    await watcher.tick();
    expect(forwardCalls()).toBe(0);
    expect(errors()).toHaveLength(0);
  });

  test("forgetting a host drops its verdict, so a host id that comes back does not inherit it", async () => {
    runtime.forwardVerdict = DROPPED;
    await gated();
    await watcher.tick();
    expect(watcher.stateOf(host.host.id)).not.toBeNull();
    watcher.forget(host.host.id);
    expect(watcher.stateOf(host.host.id)).toBeNull();
  });

  test("the engine refusing the check is logged and leaves the last verdict alone", async () => {
    await gated();
    await watcher.tick();
    runtime.fail("checkHostForward", new Error("boom") as never);
    watcher.hostOnline(host.host.id);
    await watcher.tick();
    expect(lines.some((line) => line.includes("egress.forward_pass_failed"))).toBe(true);
    expect(watcher.stateOf(host.host.id)?.forwarding).toBe(true);
  });
});
