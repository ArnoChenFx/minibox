import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import { hostFirewallChain } from "../src/docker/host-firewall";
import { type EgressPolicy, normalizeEgress } from "../src/egress/policy";
import type { HostCtx } from "../src/host/registry";
import { AppError } from "../src/lib/errors";
import { RuntimeError } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { type CheckpointView, forkCheckpoint, takeCheckpoint } from "../src/services/checkpoints";
import { sweepEgress } from "../src/services/egress";
import { reconcileHost } from "../src/services/reconcile";
import { newBoxId } from "../src/specs/revision";
import { createTestApp, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

let app: App;
let runtime: FakeRuntime;
let host: HostCtx;
let restoreLogs: () => void;

beforeAll(() => {
  restoreLogs = silenceLogs();
});
afterAll(() => restoreLogs());

function setup(overrides: Parameters<typeof createTestApp>[0] = {}) {
  const created = createTestApp({ labelPrefix: "mbtest", ...overrides });
  const hostCtx = created.app.hosts.get();
  created.runtime.seedImage(hostCtx.baseTemplateTag, {
    [hostCtx.keys.template]: "true",
    [hostCtx.keys.templateName]: "base",
  });
  return { app: created.app, runtime: created.runtime, host: hostCtx };
}

beforeEach(() => {
  ({ app, runtime, host } = setup());
});

const none = (): EgressPolicy => normalizeEgress({ mode: "none" });
const proxyOnly = (domains: string[] = ["example.com"]): EgressPolicy =>
  normalizeEgress({ mode: "proxy-only", domains });

const newBox = (name: string, extra: Partial<Parameters<typeof boxes.createBox>[1]> = {}) =>
  boxes.createBox(host, { name, cpus: 1, memoryMb: 256, ...extra });

const egressNetworkOf = (boxId: string) => `mbtest-egress-${boxId}`;
const UPLINK = "mbtest-egress-uplink";
const EGRESS_CALLS: ReadonlySet<string> = new Set([
  "connectNetwork",
  "setHostIngressBlock",
  "listNetworks",
  "followLogs",
]);

function proxiesOf(boxId: string) {
  return [...runtime.containers.values()].filter((c) => c.labels[host.keys.egressProxy] === boxId);
}

function subnetOf(boxId: string): string | undefined {
  return host.specs.read(boxId)?.egress?.subnet;
}

function egressNetworks(): string[] {
  return [...runtime.networks.keys()].filter((name) => name.startsWith("mbtest-egress-") && name !== UPLINK);
}

/** Lists the events of one operation once `count` of them are recorded, as the log is read in the background. */
async function eventsOf(op: string, count: number) {
  const deadline = Date.now() + 2000;
  for (;;) {
    const events = app.events.list({ op }, { limit: 50 }).events;
    if (events.length >= count || Date.now() > deadline) return events;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("box creation with egress", () => {
  test("an open box makes no egress call and leaves the host firewall alone", async () => {
    const box = await newBox("plain");

    expect(box.egress).toBeUndefined();
    expect(box.network).toBe("mbtest-boxes");
    const egressCalls = runtime.ops().filter((op) => EGRESS_CALLS.has(op));
    expect(egressCalls).toEqual([]);
    expect(runtime.hostIngressBlock).toEqual([]);
    expect(egressNetworks()).toEqual([]);
    expect(host.specs.read(box.boxId)?.egress).toBeUndefined();
  });

  test("none gets an internal network on a pool subnet, no proxy, and a host firewall block", async () => {
    const box = await newBox("sealed", { egress: none() });

    expect(box).toMatchObject({
      network: egressNetworkOf(box.boxId),
      egress: { mode: "none", presets: [], domains: [], allow: [] },
    });
    expect(runtime.networks.get(egressNetworkOf(box.boxId))).toMatchObject({
      internal: true,
      subnets: ["240.0.1.0/28"],
    });
    expect(proxiesOf(box.boxId)).toEqual([]);
    expect(runtime.hostIngressBlock).toEqual(["240.0.1.0/28"]);
    expect(runtime.hostIngressOwner).toBe("mbtest");

    const container = runtime.containers.get(box.id);
    expect(container?.spec.network).toBe(egressNetworkOf(box.boxId));
    expect(container?.spec.env ?? []).toEqual([]);
    expect(container?.spec.hardening?.capDrop).toContain("NET_RAW");
    expect(JSON.parse(container?.labels[host.keys.egress] ?? "null")).toMatchObject({
      mode: "none",
      subnet: "240.0.1.0/28",
    });
    expect(host.specs.read(box.boxId)?.egress).toMatchObject({ mode: "none", subnet: "240.0.1.0/28" });
  });

  test("creates that plan at the same time are given different subnets", async () => {
    const [first, second] = await Promise.all([
      newBox("twin-a", { egress: none() }),
      newBox("twin-b", { egress: none() }),
    ]);

    const subnets = [subnetOf(first.boxId), subnetOf(second.boxId)]
      .filter((subnet): subnet is string => subnet !== undefined)
      .toSorted();
    expect(subnets).toEqual(["240.0.1.0/28", "240.0.1.16/28"]);
    expect(egressNetworks()).toHaveLength(2);
    expect(runtime.hostIngressBlock).toEqual(subnets);
  });

  test("proxy-only gets a proxy on the uplink, joined to the box's network under the proxy alias", async () => {
    const box = await newBox("walled", { egress: proxyOnly(["example.com"]) });

    const [proxy] = proxiesOf(box.boxId);
    expect(proxy).toBeDefined();
    expect(proxy?.running).toBe(true);
    expect(proxy?.spec.network).toBe(UPLINK);
    expect(proxy?.spec.restart).toBe("unless-stopped");
    expect(proxy?.spec.env).toEqual(
      expect.arrayContaining(['MINIBOX_EGRESS_ALLOW=["example.com"]', "MINIBOX_EGRESS_PORT=3128"]),
    );
    expect(proxy?.extraEndpoints).toEqual([
      expect.objectContaining({ name: egressNetworkOf(box.boxId), aliases: ["minibox-proxy"] }),
    ]);
    expect(runtime.networks.get(UPLINK)).toMatchObject({ internal: false, subnets: ["240.0.0.0/24"] });

    const container = runtime.containers.get(box.id);
    expect(container?.spec.network).toBe(egressNetworkOf(box.boxId));
    expect(container?.spec.env).toEqual(
      expect.arrayContaining(["HTTPS_PROXY=http://minibox-proxy:3128", "HTTP_PROXY=http://minibox-proxy:3128"]),
    );
    expect(container?.spec.hardening?.capDrop).toContain("NET_RAW");
    expect(runtime.hostIngressBlock).toEqual(["240.0.1.0/28"]);
  });

  test("two egress boxes get separate subnets, and the firewall holds both", async () => {
    const first = await newBox("first", { egress: none() });
    const second = await newBox("second", { egress: proxyOnly() });

    expect(subnetOf(first.boxId)).toBe("240.0.1.0/28");
    expect(subnetOf(second.boxId)).toBe("240.0.1.16/28");
    expect(runtime.hostIngressBlock).toEqual(["240.0.1.0/28", "240.0.1.16/28"]);
  });

  test("a create that fails after its proxy started takes the proxy, network and firewall rule back", async () => {
    runtime.fail("startContainer", new RuntimeError("engine", "engine refused the proxy"));

    const failed = newBox("doomed", { egress: proxyOnly() });
    await expect(failed).rejects.toBeInstanceOf(AppError);
    await expect(failed).rejects.toMatchObject({ status: 502, code: "docker_error" });

    expect([...runtime.containers.values()].filter((c) => c.labels[host.keys.egressProxy])).toEqual([]);
    expect(egressNetworks()).toEqual([]);
    expect(runtime.hostIngressBlock).toEqual([]);
    expect(host.specs.findByName("doomed")).toBeNull();
  });
});

describe("stopping, starting and deleting an egress box", () => {
  test("stopping a proxy-only box stops its proxy, and starting it starts the proxy again", async () => {
    const box = await newBox("cycled", { egress: proxyOnly() });
    const [proxy] = proxiesOf(box.boxId);
    expect(proxy?.running).toBe(true);

    await boxes.stopBox(host, box.name);
    expect(proxiesOf(box.boxId)[0]?.running).toBe(false);

    await boxes.startBox(host, box.name);
    expect(proxiesOf(box.boxId)).toHaveLength(1);
    expect(proxiesOf(box.boxId)[0]?.running).toBe(true);
    expect(runtime.containers.get(box.id)?.running).toBe(true);
  });

  test("a stopped box whose network a prune removed starts on a fresh network with the same subnet", async () => {
    const box = await newBox("pruned", { egress: none() });
    await boxes.stopBox(host, box.name);
    runtime.pruneNetworks();
    expect(runtime.networks.has(egressNetworkOf(box.boxId))).toBe(false);

    const started = await boxes.startBox(host, box.name);

    expect(started.running).toBe(true);
    expect(runtime.networks.get(egressNetworkOf(box.boxId))).toMatchObject({ subnets: ["240.0.1.0/28"] });
    expect(runtime.hostIngressBlock).toEqual(["240.0.1.0/28"]);
  });

  test("a stopped proxy-only box whose uplink a prune removed starts with its proxy on a new uplink", async () => {
    const box = await newBox("uplinked", { egress: proxyOnly() });
    await boxes.stopBox(host, box.name);
    runtime.pruneNetworks();

    await boxes.startBox(host, box.name);

    expect(proxiesOf(box.boxId)[0]?.running).toBe(true);
    expect(runtime.networks.has(UPLINK)).toBe(true);
  });

  test("deleting a box removes its proxy and network, and releases its firewall source", async () => {
    const box = await newBox("gone", { egress: proxyOnly() });
    expect(runtime.hostIngressBlock).toEqual(["240.0.1.0/28"]);

    await boxes.deleteBox(host, box.name, true);

    expect(proxiesOf(box.boxId)).toEqual([]);
    expect(runtime.networks.has(egressNetworkOf(box.boxId))).toBe(false);
    expect(runtime.hostIngressBlock).toEqual([]);
    expect(host.specs.read(box.boxId)).toBeNull();
  });
});

describe("BLOCK_HOST_GATEWAY", () => {
  test("blocks the default network's subnets for open boxes, and the egress subnets too", async () => {
    ({ app, runtime, host } = setup({ blockHostGateway: true }));
    await runtime.ensureBridgeNetwork("mbtest-boxes", { interContainerComm: false, subnet: "172.30.0.0/16" });

    const plain = await newBox("plain");
    expect(plain.egress).toBeUndefined();
    expect(runtime.hostIngressBlock).toEqual(["172.30.0.0/16"]);

    await newBox("sealed", { egress: none() });
    expect(runtime.hostIngressBlock).toEqual(["172.30.0.0/16", "240.0.1.0/28"]);
  });

  test("with the flag off, the default network is not blocked", async () => {
    await runtime.ensureBridgeNetwork("mbtest-boxes", { interContainerComm: false, subnet: "172.30.0.0/16" });

    await newBox("plain");

    expect(runtime.hostIngressBlock).toEqual([]);
  });
});

describe("recovery and cleanup", () => {
  test("a claimed box gets its egress policy back from its container label", async () => {
    const box = await newBox("claimed", { egress: proxyOnly(["example.com"]) });
    const before = host.specs.read(box.boxId)?.egress;
    host.specs.remove(box.boxId);

    const report = await reconcileHost(host);

    expect(report.claimed).toEqual([box.boxId]);
    expect(host.specs.read(box.boxId)?.egress).toEqual(before);
    expect(report.egressRemoved).toEqual([]);
  });

  test("the sweep removes a proxy and a network that no spec names, and keeps the ones a spec names", async () => {
    const kept = await newBox("kept", { egress: none() });
    const orphanBox = newBoxId();
    const orphanNetwork = egressNetworkOf(orphanBox);
    await runtime.ensureBridgeNetwork(UPLINK, { interContainerComm: false, subnet: "240.0.0.0/24" });
    await runtime.ensureBridgeNetwork(orphanNetwork, {
      interContainerComm: true,
      internal: true,
      subnet: "240.0.5.0/28",
    });
    const orphanProxy = await runtime.createContainer({
      name: `mbtest-egress-proxy-${orphanBox}`,
      image: host.baseTemplateTag,
      cmd: ["sleep", "infinity"],
      labels: { [host.keys.egressProxy]: orphanBox },
      network: UPLINK,
      restart: "unless-stopped",
    });
    await runtime.startContainer(orphanProxy.id);

    const removed = await sweepEgress(host);

    expect(removed.toSorted()).toEqual([`mbtest-egress-proxy-${orphanBox}`, orphanNetwork].toSorted());
    expect(runtime.networks.has(orphanNetwork)).toBe(false);
    expect(runtime.networks.has(egressNetworkOf(kept.boxId))).toBe(true);
    expect(runtime.networks.has(UPLINK)).toBe(true);
  });

  test("a fork of a box with egress keeps the policy on a new network with its own subnet", async () => {
    const box = await newBox("source", { egress: proxyOnly(["example.com"]) });
    const view: CheckpointView = await takeCheckpoint(
      host,
      box.name,
      { pinned: false, include: { system: false, volumes: [] }, consistency: "live" },
      "owner",
    );
    expect(view.spec?.egress).toEqual({
      mode: "proxy-only",
      presets: [],
      domains: ["example.com"],
      allow: ["example.com"],
    });

    const forked = await forkCheckpoint(
      host,
      view.id,
      { name: "forked", cpus: 1, memoryMb: 256, copyHome: false },
      "owner",
    );

    expect(forked.boxId).not.toBe(box.boxId);
    expect(forked.egress).toEqual({
      mode: "proxy-only",
      presets: [],
      domains: ["example.com"],
      allow: ["example.com"],
    });
    expect(forked.network).toBe(egressNetworkOf(forked.boxId));
    expect(subnetOf(forked.boxId)).toBe("240.0.1.16/28");
    expect(proxiesOf(forked.boxId)[0]?.running).toBe(true);
  });
});

describe("proxy log events", () => {
  test("the lines a proxy writes become egress events for its box, and the start line is not an event", async () => {
    const box = await newBox("logged", { egress: proxyOnly(["example.com"]) });
    const [proxy] = proxiesOf(box.boxId);
    if (!proxy) throw new Error("no proxy");

    runtime.appendLogs(
      proxy.id,
      [
        '{"v":1,"ts":1,"e":"allowed","host":"example.com","port":443,"scheme":"https","up":12,"down":345,"ms":9}',
        '{"v":1,"ts":2,"e":"denied","host":"evil.example.net","port":443,"reason":"not_allowed"}',
        '{"v":1,"ts":3,"e":"failed","host":"example.com","port":443,"reason":"upstream"}',
        '{"v":1,"ts":4,"e":"listening","port":3128,"allow":1}',
        "",
      ].join("\n"),
    );

    const [allowed] = await eventsOf("egress.allowed", 1);
    const [denied] = await eventsOf("egress.denied", 1);
    const [failed] = await eventsOf("egress.failed", 1);
    expect(allowed).toMatchObject({
      status: "ok",
      summary: "Egress to example.com:443 allowed",
      target: { kind: "box", id: box.id, name: "logged" },
      tier: "activity",
    });
    expect(allowed?.detail).toEqual({ host: "example.com", port: 443, scheme: "https", up: 12, down: 345, ms: 9 });
    expect(denied).toMatchObject({ status: "denied", tier: "audit", summary: "Egress to evil.example.net:443 denied" });
    expect(denied?.detail).toEqual({ host: "evil.example.net", port: 443, reason: "not_allowed" });
    expect(failed).toMatchObject({ status: "error", summary: "Egress to example.com:443 failed" });
    expect(app.events.list({ op: "egress.listening" }, { limit: 10 }).events).toEqual([]);
  });

  test("a reconcile reads the logs of proxies already running, as after a MiniBox restart", async () => {
    const box = await newBox("resumed", { egress: proxyOnly(["example.com"]) });
    const [proxy] = proxiesOf(box.boxId);
    if (!proxy) throw new Error("no proxy");
    host.egress.stopAll();

    await reconcileHost(host);
    runtime.appendLogs(
      proxy.id,
      '{"v":1,"ts":1,"e":"denied","host":"evil.example.net","port":443,"reason":"not_allowed"}\n',
    );

    const [denied] = await eventsOf("egress.denied", 1);
    expect(denied).toMatchObject({ status: "denied", target: { kind: "box", id: box.id, name: "resumed" } });
  });
});

describe("host firewall after a reboot", () => {
  test("a reconcile sends the source list again although the store says the host holds it", async () => {
    const box = await newBox("rebooted", { egress: none() });
    const subnet = subnetOf(box.boxId) ?? "";
    expect(runtime.hostIngressBlock).toEqual([subnet]);
    runtime.hostIngressBlock = [];

    await reconcileHost(host);

    expect(runtime.hostIngressBlock).toEqual([subnet]);
  });

  test("a reconcile on a host that needs no block and holds none makes no firewall call", async () => {
    await newBox("plain");

    await reconcileHost(host);

    expect(runtime.ops().filter((op) => op === "setHostIngressBlock")).toEqual([]);
  });
});

describe("host firewall chains", () => {
  test("each install has its own chain, named within iptables' limit", () => {
    const chain = hostFirewallChain("minibox");
    expect(chain).toMatch(/^MINIBOX-EGRESS-[0-9a-f]{8}$/);
    expect(chain.length).toBeLessThanOrEqual(28);
    expect(hostFirewallChain("minibox")).toBe(chain);
    expect(hostFirewallChain("mbit-test")).not.toBe(chain);
  });
});
