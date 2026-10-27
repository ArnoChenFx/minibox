import { afterEach, describe, expect, test } from "bun:test";

import { type Cluster, MIB, bootCluster, boxOn } from "./support/cluster";

let cluster: Cluster | null = null;

afterEach(() => {
  cluster?.close();
  cluster = null;
});

interface UsageRow {
  id: string;
  status: string;
  containers: { running: number; total: number } | null;
  allocated: { cpus: number; memoryBytes: number } | null;
  usage: { cpus: number; memoryBytes: number } | null;
}

async function usageRows(c: Cluster): Promise<Record<string, UsageRow>> {
  const res = await c.api("/api/hosts/usage");
  expect(res.status).toBe(200);
  const { hosts } = (await res.json()) as { hosts: UsageRow[] };
  return Object.fromEntries(hosts.map((host) => [host.id, host]));
}

describe("host usage for the overview", () => {
  test("each host reports its containers, what its running boxes book, and what they use now", async () => {
    cluster = await bootCluster();
    await cluster.app.hostAdmin.refresh();
    await boxOn(cluster, "small", "alpha", { cpus: 1, memoryMb: 256 });
    const beta = await boxOn(cluster, "small", "beta", { cpus: 1, memoryMb: 512 });
    expect((await cluster.api(`/api/boxes/${beta.boxId}/stop`, { method: "POST" })).status).toBe(200);
    await cluster.app.hosts.get("small").sampler.sampleNow();

    const rows = await usageRows(cluster);
    expect(rows.small).toMatchObject({
      status: "online",
      containers: { running: 1, total: 2 },
      allocated: { cpus: 1, memoryBytes: 256 * MIB },
    });
    // The fake engine reports 1.5 percent of a core and a quarter of each box's memory limit, as a running box's sample.
    expect(rows.small?.usage?.cpus).toBeCloseTo(0.02, 2);
    expect(rows.small?.usage?.memoryBytes).toBe(64 * MIB);
    expect(rows.large).toMatchObject({
      status: "online",
      containers: { running: 0, total: 0 },
      allocated: { cpus: 0, memoryBytes: 0 },
      usage: { cpus: 0, memoryBytes: 0 },
    });
  });

  test("an offline host has no current figures, and keeps the containers of its last good check", async () => {
    cluster = await bootCluster();
    await boxOn(cluster, "large", "gamma", { cpus: 2 });
    await cluster.app.hostAdmin.refresh();
    cluster.app.hosts.get("large").host.status = "offline";

    const rows = await usageRows(cluster);
    expect(rows.large).toEqual({
      id: "large",
      status: "offline",
      containers: { running: 1, total: 1 },
      allocated: null,
      usage: null,
    });
  });

  test("a single-host install lists local alone, and the host list keeps the fields it had", async () => {
    cluster = await bootCluster();
    expect((await cluster.api("/api/hosts/small", { method: "DELETE" })).status).toBe(200);
    expect((await cluster.api("/api/hosts/large", { method: "DELETE" })).status).toBe(200);

    const list = (await (await cluster.api("/api/hosts")).json()) as { hosts: Record<string, unknown>[] };
    expect(list.hosts.map((host) => host.id)).toEqual(["local"]);
    expect(Object.keys(list.hosts[0] ?? {}).toSorted()).toEqual(
      [
        "id",
        "name",
        "transport",
        "endpoint",
        "status",
        "latencyMs",
        "capacity",
        "dockerVersion",
        "error",
        "boxes",
        "createdAt",
        "labels",
      ].toSorted(),
    );
    expect(Object.keys(await usageRows(cluster))).toEqual(["local"]);
  });
});
