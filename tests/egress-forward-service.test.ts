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

const FORWARDING: HostForwardCheck = { forwarding: true, cause: null, detail: "iptables accepts br-000000000000" };
const DROPPED: HostForwardCheck = {
  forwarding: false,
  cause: "policy",
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

describe("a host that cannot be read does not fill the log", () => {
  test("a host that stays unreadable is logged once, and reading it again is said once", async () => {
    await gated();
    runtime.checkHostForward = async () => {
      throw new Error("helper failed");
    };
    for (let pass = 0; pass < 3; pass++) await watcher.tick();
    expect(errors().filter((line) => line.includes("egress.forward_pass_failed"))).toHaveLength(1);
    runtime.checkHostForward = async () => FORWARDING;
    await watcher.tick();
    await watcher.tick();
    expect(lines.filter((line) => line.includes("egress.forward_pass_recovered"))).toHaveLength(1);
  });

  test("an offline host is not read at all, and is read again once it is back", async () => {
    await gated();
    host.host.status = "offline";
    await watcher.tick();
    expect(forwardCalls()).toBe(0);
    expect(lines.filter((line) => line.includes("egress.forward"))).toEqual([]);
    host.host.status = "online";
    await watcher.tick();
    expect(forwardCalls()).toBe(1);
  });
});

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

  test("every pass reads a host that has a proxy-only box, so a rule that vanishes is noticed", async () => {
    // The reading is the only thing that can see a firewall reload: a host that is read once and then left alone keeps
    // its old verdict, which is how a broken host stayed reported as fine until the next box started.
    await gated();
    await watcher.tick();
    await watcher.tick();
    expect(forwardCalls()).toBe(2);
  });

  test("a rule dropped between two passes is found by the next pass, with nothing else asking for it", async () => {
    await gated();
    await watcher.tick();
    expect(watcher.stateOf(host.host.id)?.forwarding).toBe(true);
    runtime.forwardVerdict = DROPPED;
    await watcher.tick();
    expect(watcher.stateOf(host.host.id)).toMatchObject({ forwarding: false, cause: "policy" });
  });

  test("a box starting reads the host at once, which is the moment the owner looks", async () => {
    await gated();
    await watcher.tick();
    watcher.start();
    watcher.boxStarted(host.host.id);
    await Bun.sleep(10);
    watcher.stop();
    expect(forwardCalls()).toBe(2);
  });

  test("a host coming back online is read at once rather than at the next pass", async () => {
    await gated();
    await watcher.tick();
    watcher.start();
    watcher.hostOnline(host.host.id);
    await Bun.sleep(10);
    watcher.stop();
    expect(forwardCalls()).toBe(2);
  });

  test("a nudge before the watcher runs reads nothing, so no pass runs outside a start", async () => {
    await gated();
    watcher.boxStarted(host.host.id);
    await Bun.sleep(10);
    expect(forwardCalls()).toBe(0);
  });

  test("an agent host is skipped with a reason, and the reason is what the overview reads", async () => {
    host.host.transport = "agent";
    await gated();
    await watcher.tick();
    expect(forwardCalls()).toBe(0);
    expect(watcher.stateOf(host.host.id)).toMatchObject({
      forwarding: false,
      cause: null,
      skipped: expect.stringContaining("agent"),
    });
    // The reason reaches the log once, so an operator is not left guessing why the host never reports.
    expect(lines.filter((line) => line.includes("egress.forward_skipped"))).toHaveLength(1);
    await watcher.tick();
    expect(lines.filter((line) => line.includes("egress.forward_skipped"))).toHaveLength(1);
  });
});

describe("when the passes happen", () => {
  test("start runs a pass soon after it, and stop ends the passes", async () => {
    await gated();
    const fresh = new EgressForwardWatcher({ hosts: app.hosts, everyMs: 40 });
    fresh.start();
    await Bun.sleep(80);
    const first = forwardCalls();
    expect(first).toBeGreaterThanOrEqual(1);
    fresh.stop();
    const stopped = forwardCalls();
    await Bun.sleep(80);
    expect(forwardCalls()).toBe(stopped);
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

  test("a DROP the host's own rules make is refused: the repair will not undo a decision", async () => {
    // A host whose rules deliberately drop the uplink is doing what it was told. Adding MiniBox's rule there would
    // widen the host, which is the opposite of what the warning is for.
    runtime.forwardVerdict = { forwarding: false, cause: "rule", detail: "iptables drops traffic from br- by a rule" };
    await gated();
    await watcher.tick();
    await expect(watcher.repair(host)).rejects.toMatchObject({
      status: 409,
      key: "egress_forward_not_repairable_rule",
    });
    expect(runtime.callsTo("allowHostForward")).toEqual([]);
  });

  test("a drop behind a RETURN or a -g is refused too: a rule at the end of FORWARD would never be reached", async () => {
    runtime.forwardVerdict = {
      forwarding: false,
      cause: "unreachable",
      detail: "iptables FORWARD policy is DROP, and a RETURN or -g in FORWARD leaves br- to it",
    };
    await gated();
    await watcher.tick();
    await expect(watcher.repair(host)).rejects.toMatchObject({
      status: 409,
      key: "egress_forward_not_repairable_unreachable",
    });
    expect(runtime.callsTo("allowHostForward")).toEqual([]);
  });

  test("the chain a repair added is removed once the host has no proxy-only box left", async () => {
    // A leftover chain keeps accepting traffic the install no longer needs, and nobody would look for it there.
    runtime.forwardVerdict = DROPPED;
    const box = await gated();
    await watcher.tick();
    runtime.forwardVerdict = FORWARDING;
    await watcher.repair(host);
    expect(watcher.stateOf(host.host.id)?.installed).toBe(true);
    await boxes.deleteBox(host, box.boxId, true);
    await watcher.tick();
    expect(runtime.callsTo("allowHostForward").at(-1)?.args).toEqual(["mbtest", ""]);
    expect(watcher.stateOf(host.host.id)).toBeNull();
  });

  test("a host with no chain installed is never asked to remove one", async () => {
    const box = await gated();
    await watcher.tick();
    await boxes.deleteBox(host, box.boxId, true);
    await watcher.tick();
    expect(runtime.callsTo("allowHostForward")).toEqual([]);
  });

  test("a chain that cannot be removed is logged once and does not stop the pass", async () => {
    runtime.forwardVerdict = DROPPED;
    const box = await gated();
    await watcher.tick();
    runtime.forwardVerdict = FORWARDING;
    await watcher.repair(host);
    runtime.allowHostForward = async () => {
      throw new Error("engine gone");
    };
    await boxes.deleteBox(host, box.boxId, true);
    await watcher.tick();
    expect(lines.filter((line) => line.includes("egress.forward_rule_remove_failed"))).toHaveLength(1);
  });

  test("a reading that left a rule unread is refused too, since it is not a verdict", async () => {
    runtime.forwardVerdict = { forwarding: false, cause: null, detail: "iptables: a rule MiniBox does not read" };
    await gated();
    await watcher.tick();
    await expect(watcher.repair(host)).rejects.toMatchObject({
      status: 409,
      key: "egress_forward_not_repairable_unclear",
    });
    expect(runtime.callsTo("allowHostForward")).toEqual([]);
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
