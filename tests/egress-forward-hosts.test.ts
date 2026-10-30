import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { HostForwardCheck } from "../src/runtime";
import { silenceLogs } from "./support/app";
import { bootCluster, boxOn, type Cluster } from "./support/cluster";

const DROPPED: HostForwardCheck = { forwarding: false, cause: "policy", detail: "iptables FORWARD policy is DROP" };
const FORWARDING: HostForwardCheck = { forwarding: true, cause: null, detail: "iptables accepts the uplink" };

let cluster: Cluster;
let restoreLogs: () => void;

beforeAll(() => {
  restoreLogs = silenceLogs();
});
afterAll(() => restoreLogs());

beforeEach(async () => {
  cluster = await bootCluster();
});
afterEach(() => cluster.close());

/** The remote host `small` with a proxy-only box whose uplink the owner repaired, so it carries MiniBox's chain. */
async function repaired() {
  await boxOn(cluster, "small", "agent", { egress: { mode: "proxy-only" } });
  cluster.engines.small.forwardVerdict = DROPPED;
  await cluster.app.egressForward.tick();
  cluster.engines.small.forwardVerdict = FORWARDING;
  await cluster.app.egressForward.repair(cluster.app.hosts.get("small"));
  expect(cluster.app.egressForward.stateOf("small")?.installed).toBe(true);
}

/** The calls that took MiniBox's chain off the remote host. */
const removals = () => cluster.engines.small.callsTo("allowHostForward").filter((call) => call.args[1] === "");

describe("the chain MiniBox added to a remote host", () => {
  test("goes with the host when it is removed, while its engine can still be reached", async () => {
    await repaired();
    // The last proxy-only box is gone before a pass could take the chain off, which is when the host is removed.
    const box = await cluster.api("/api/boxes/agent?deleteVolume=true&skipTrash=true", { method: "DELETE" });
    expect(box.status).toBe(200);
    expect((await cluster.api("/api/hosts/small", { method: "DELETE" })).status).toBe(200);
    expect(removals()).toHaveLength(1);
  });

  test("stays when MiniBox shuts down, so a restart finds it where it was left", async () => {
    await repaired();
    // Shutting down detaches every remote host, which forgets what the watcher knew and changes nothing on the host.
    cluster.app.hostAdmin.close();
    expect(removals()).toEqual([]);
    expect(cluster.app.egressForward.stateOf("small")).toBeNull();
  });
});
