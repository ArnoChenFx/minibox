import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import { type EgressPolicy, normalizeEgress } from "../src/egress/policy";
import type { HostCtx } from "../src/host/registry";
import { AppError } from "../src/lib/errors";
import { RuntimeError } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { rebuildBox } from "../src/services/rebuild";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

let app: App;
let runtime: FakeRuntime;
let host: HostCtx;
let restoreLogs: () => void;

beforeAll(() => {
  restoreLogs = silenceLogs();
});
afterAll(() => restoreLogs());

function setup() {
  const created = createTestApp({ labelPrefix: "mbtest" });
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

const open = (): EgressPolicy => normalizeEgress({ mode: "open" });
const none = (): EgressPolicy => normalizeEgress({ mode: "none" });
const proxyOnly = (domains: string[] = ["example.com"]): EgressPolicy =>
  normalizeEgress({ mode: "proxy-only", domains });

const newBox = (name: string, extra: Partial<Parameters<typeof boxes.createBox>[1]> = {}) =>
  boxes.createBox(host, { name, cpus: 1, memoryMb: 256, ...extra });

const egressNetworkOf = (boxId: string) => `mbtest-egress-${boxId}`;
const UPLINK = "mbtest-egress-uplink";

function subnetOf(boxId: string): string | undefined {
  return host.specs.read(boxId)?.egress?.subnet;
}

function proxiesOf(boxId: string) {
  return [...runtime.containers.values()].filter((c) => c.labels[host.keys.egressProxy] === boxId);
}

/** The changes a rebuild that is refused for want of confirm previews. */
async function changesOf(promise: Promise<unknown>): Promise<{ field: string; from: string; to: string }[]> {
  const error = await rejectionOf(promise);
  expect(error).toBeInstanceOf(AppError);
  if (!(error instanceof AppError)) throw new Error("expected AppError");
  expect(error).toMatchObject({ status: 409, key: "rebuild_confirm_required" });
  return (error.details as { preview: { changes: { field: string; from: string; to: string }[] } }).preview.changes;
}

/** Lists the events of one operation once `count` of them are recorded, as the proxy log is read in the background. */
async function eventsOf(op: string, count: number) {
  const deadline = Date.now() + 2000;
  for (;;) {
    const events = app.events.list({ op }, { limit: 50 }).events;
    if (events.length >= count || Date.now() > deadline) return events;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("rebuilding a box onto another egress policy", () => {
  test("open to none is previewed, then moves the box to a private network with no route out", async () => {
    const box = await newBox("plain");
    const creates = runtime.callsTo("createContainer").length;

    const changes = await changesOf(rebuildBox(host, box.boxId, box.revision, { egress: none() }, false));
    expect(changes).toContainEqual({ field: "egress", from: "open", to: "none" });
    expect(runtime.callsTo("createContainer")).toHaveLength(creates);

    const rebuilt = await rebuildBox(host, box.boxId, box.revision, { egress: none() }, true);

    expect(rebuilt).toMatchObject({
      network: egressNetworkOf(box.boxId),
      egress: { mode: "none", presets: [], domains: [], allow: [] },
    });
    expect(subnetOf(box.boxId)).toBe("240.0.1.0/28");
    const container = runtime.containers.get(rebuilt.id);
    expect(container?.running).toBe(true);
    expect(container?.spec.network).toBe(egressNetworkOf(box.boxId));
    expect(container?.spec.hardening?.capDrop).toContain("NET_RAW");
    expect(container?.spec.env ?? []).toEqual([]);
    expect(JSON.parse(container?.labels[host.keys.egress] ?? "null")).toMatchObject({
      mode: "none",
      subnet: "240.0.1.0/28",
    });
    expect(runtime.networks.get(egressNetworkOf(box.boxId))).toMatchObject({
      internal: true,
      subnets: ["240.0.1.0/28"],
    });
    expect(runtime.hostIngressBlock).toEqual(["240.0.1.0/28"]);
    expect(runtime.containers.has(box.id)).toBe(false);
  });

  test("none to proxy-only keeps the subnet, and the new proxy joins the box's network under the alias", async () => {
    const box = await newBox("sealed", { egress: none() });

    const rebuilt = await rebuildBox(host, box.boxId, box.revision, { egress: proxyOnly(["example.com"]) }, true);

    expect(rebuilt.egress).toMatchObject({ mode: "proxy-only", allow: ["example.com"] });
    expect(subnetOf(box.boxId)).toBe("240.0.1.0/28");
    const [proxy] = proxiesOf(box.boxId);
    expect(proxy?.running).toBe(true);
    expect(proxy?.extraEndpoints).toEqual([
      expect.objectContaining({ name: egressNetworkOf(box.boxId), aliases: ["minibox-proxy"] }),
    ]);
    expect(runtime.containers.get(rebuilt.id)?.spec.env).toEqual(
      expect.arrayContaining(["HTTPS_PROXY=http://minibox-proxy:3128", "HTTP_PROXY=http://minibox-proxy:3128"]),
    );
    expect(runtime.networks.get(egressNetworkOf(box.boxId))).toMatchObject({ subnets: ["240.0.1.0/28"] });
    expect(runtime.hostIngressBlock).toEqual(["240.0.1.0/28"]);
  });

  test("an allowlist change replaces the proxy, and the old proxy is gone", async () => {
    const box = await newBox("walled", { egress: proxyOnly(["example.com"]) });
    const [old] = proxiesOf(box.boxId);

    const changes = await changesOf(
      rebuildBox(host, box.boxId, box.revision, { egress: proxyOnly(["example.org"]) }, false),
    );
    expect(changes).toContainEqual({ field: "egress", from: "proxy-only: example.com", to: "proxy-only: example.org" });

    const rebuilt = await rebuildBox(host, box.boxId, box.revision, { egress: proxyOnly(["example.org"]) }, true);

    const proxies = proxiesOf(box.boxId);
    expect(proxies).toHaveLength(1);
    expect(proxies[0]?.id).not.toBe(old?.id);
    expect(runtime.containers.has(old?.id ?? "")).toBe(false);
    expect(proxies[0]?.running).toBe(true);
    expect(proxies[0]?.spec.env).toEqual(expect.arrayContaining(['MINIBOX_EGRESS_ALLOW=["example.org"]']));
    expect(rebuilt.egress?.allow).toEqual(["example.org"]);
  });

  test("proxy-only to open drops the proxy and the private network, and releases the firewall source", async () => {
    const box = await newBox("unwalled", { egress: proxyOnly() });

    const rebuilt = await rebuildBox(host, box.boxId, box.revision, { egress: open() }, true);

    expect(rebuilt.egress).toBeUndefined();
    expect(rebuilt.network).toBe("mbtest-boxes");
    expect(runtime.containers.get(rebuilt.id)?.spec.network).toBe("mbtest-boxes");
    expect(proxiesOf(box.boxId)).toEqual([]);
    expect(runtime.networks.has(egressNetworkOf(box.boxId))).toBe(false);
    expect(runtime.networks.has(UPLINK)).toBe(true);
    expect(runtime.hostIngressBlock).toEqual([]);
  });

  test("proxy-only to none drops only the proxy, and keeps the network and its firewall source", async () => {
    const box = await newBox("narrowed", { egress: proxyOnly() });

    const rebuilt = await rebuildBox(host, box.boxId, box.revision, { egress: none() }, true);

    expect(rebuilt.egress).toMatchObject({ mode: "none" });
    expect(subnetOf(box.boxId)).toBe("240.0.1.0/28");
    expect(proxiesOf(box.boxId)).toEqual([]);
    expect(runtime.networks.get(egressNetworkOf(box.boxId))).toMatchObject({ subnets: ["240.0.1.0/28"] });
    expect(runtime.hostIngressBlock).toEqual(["240.0.1.0/28"]);
  });

  test("a rebuild that changes only env keeps the proxy, and its events name the new container", async () => {
    const box = await newBox("steady", { egress: proxyOnly(["example.com"]) });
    const [proxy] = proxiesOf(box.boxId);
    if (!proxy) throw new Error("no proxy");

    const rebuilt = await rebuildBox(host, box.boxId, box.revision, { env: [{ name: "FOO", value: "bar" }] }, true);

    expect(proxiesOf(box.boxId).map((p) => p.id)).toEqual([proxy.id]);
    runtime.appendLogs(
      proxy.id,
      '{"v":1,"ts":1,"e":"denied","host":"evil.example.net","port":443,"reason":"not_allowed"}\n',
    );
    const [denied] = await eventsOf("egress.denied", 1);
    expect(denied?.target).toMatchObject({ kind: "box", id: rebuilt.id, name: "steady" });
  });

  test("a stopped proxy-only box rebuilt stays stopped, and its proxy stays stopped", async () => {
    const box = await newBox("sleepy", { egress: proxyOnly() });
    const stopped = await boxes.stopBox(host, box.boxId);

    const rebuilt = await rebuildBox(host, box.boxId, stopped.revision, { env: [{ name: "FOO", value: "bar" }] }, true);

    expect(rebuilt.running).toBe(false);
    expect(runtime.containers.get(rebuilt.id)?.running).toBe(false);
    expect(proxiesOf(box.boxId).every((proxy) => !proxy.running)).toBe(true);
  });

  test("the same policy as before changes nothing, so the rebuild is refused as empty", async () => {
    const box = await newBox("same", { egress: proxyOnly(["example.com"]) });

    const error = await rejectionOf(
      rebuildBox(host, box.boxId, box.revision, { egress: proxyOnly(["example.com"]) }, true),
    );

    expect(error).toMatchObject({ status: 400, key: "rebuild_empty" });
    expect(host.specs.read(box.boxId)?.revision).toBe(box.revision);
  });
});

describe("refusals", () => {
  test("egress and network cannot be set in one rebuild", async () => {
    const box = await newBox("plain");

    const error = await rejectionOf(
      rebuildBox(host, box.boxId, box.revision, { egress: none(), network: "mbtest-boxes" }, true),
    );

    expect(error).toMatchObject({ status: 400, key: "egress_needs_network" });
    expect(host.specs.read(box.boxId)?.egress).toBeUndefined();
  });

  test("a box with egress cannot be rebuilt onto another network, and changes nothing", async () => {
    const box = await newBox("sealed", { egress: none() });

    const error = await rejectionOf(rebuildBox(host, box.boxId, box.revision, { network: "mbtest-boxes" }, true));

    expect(error).toMatchObject({ status: 400, key: "egress_needs_network" });
    expect(host.specs.read(box.boxId)).toMatchObject({ revision: box.revision, egress: { mode: "none" } });
    expect(runtime.containers.get(box.id)?.running).toBe(true);
  });
});

describe("a failed egress rebuild puts the box back", () => {
  test("a new proxy that cannot start restores the old proxy, the container and the firewall rule", async () => {
    const box = await newBox("walled", { egress: proxyOnly(["example.com"]) });
    const [oldProxy] = proxiesOf(box.boxId);
    runtime.fail("startContainer", new RuntimeError("engine", "engine refused the proxy"));

    const failed = rebuildBox(host, box.boxId, box.revision, { egress: proxyOnly(["example.org"]) }, true);

    await expect(failed).rejects.toMatchObject({ status: 502, code: "docker_error" });
    expect(host.specs.read(box.boxId)).toMatchObject({
      revision: box.revision,
      containerId: box.id,
      egress: { allow: ["example.com"], subnet: "240.0.1.0/28" },
    });
    expect(runtime.containers.get(box.id)?.running).toBe(true);
    expect(
      [...runtime.containers.values()].filter((c) => c.labels[host.keys.id] === box.boxId).map((c) => c.id),
    ).toEqual([box.id]);
    const proxies = proxiesOf(box.boxId);
    expect(proxies).toHaveLength(1);
    expect(proxies[0]?.id).not.toBe(oldProxy?.id);
    expect(proxies[0]?.running).toBe(true);
    expect(proxies[0]?.spec.env).toEqual(expect.arrayContaining(['MINIBOX_EGRESS_ALLOW=["example.com"]']));
    expect(runtime.hostIngressBlock).toEqual(["240.0.1.0/28"]);
  });

  test("a rebuild to open whose box cannot start restores the proxy and puts the firewall source back", async () => {
    const box = await newBox("unwalled", { egress: proxyOnly(["example.com"]) });
    runtime.fail("startContainer", new RuntimeError("engine", "engine refused the box"));

    await expect(rebuildBox(host, box.boxId, box.revision, { egress: open() }, true)).rejects.toBeInstanceOf(
      RuntimeError,
    );

    expect(host.specs.read(box.boxId)).toMatchObject({ revision: box.revision, egress: { mode: "proxy-only" } });
    expect(runtime.containers.get(box.id)?.running).toBe(true);
    expect(proxiesOf(box.boxId).map((proxy) => proxy.running)).toEqual([true]);
    expect(runtime.networks.has(egressNetworkOf(box.boxId))).toBe(true);
    expect(runtime.hostIngressBlock).toEqual(["240.0.1.0/28"]);
  });

  test("a failed create of the new container removes the private network the rebuild made", async () => {
    const box = await newBox("plain");
    runtime.fail("createContainer", new RuntimeError("engine", "engine refused the container"));

    await expect(rebuildBox(host, box.boxId, box.revision, { egress: none() }, true)).rejects.toBeInstanceOf(
      RuntimeError,
    );

    expect(runtime.networks.has(egressNetworkOf(box.boxId))).toBe(false);
    expect(runtime.hostIngressBlock).toEqual([]);
    expect(host.specs.read(box.boxId)).toMatchObject({ revision: box.revision });
    expect(host.specs.read(box.boxId)?.egress).toBeUndefined();
    expect(runtime.containers.get(box.id)?.running).toBe(true);
  });
});
