import { afterEach, describe, expect, test } from "bun:test";

import { createVolume } from "../src/services/volumes";
import { bootCluster, type Cluster } from "./support/cluster";
import { call, mint } from "./support/tokens";

const DAY_MS = 24 * 60 * 60 * 1000;

interface VolumeRow {
  name: string;
  hostId: string;
  status: string;
}

interface PruneReply {
  volumes: VolumeRow[];
  hosts: { hostId: string; status: string }[];
}

interface DeleteReply {
  volumes: (VolumeRow & { error: { key: string | null } | null })[];
}

let cluster: Cluster | null = null;

afterEach(() => {
  cluster?.close();
  cluster = null;
});

/**
 * Three hosts. The cluster's checkpoint engine reads only the local engine, so a remote volume that keeps a recycle bin
 * copy cannot be copied in a test. These volumes use the cache role, which keeps no copy, so their removal runs on the
 * host they live on.
 */
async function boot(): Promise<Cluster> {
  cluster = await bootCluster({}, ["local", "small", "large"]);
  return cluster;
}

/** The volume store is shared by every host, so one pass moves every volume past the grace period. */
function ageVolumes(c: Cluster): void {
  const store = c.app.hosts.get().volumes;
  const old = new Date(Date.now() - 30 * DAY_MS).toISOString();
  for (const record of store.list()) {
    store.write({ ...record, createdAt: old, lastMount: record.lastMount ? { ...record.lastMount, at: old } : null });
  }
}

function namesOn(c: Cluster): string[] {
  return c.app.hosts
    .get()
    .volumes.list()
    .map((volume) => volume.name);
}

describe("POST /api/volumes/prune on several hosts", () => {
  test("the owner's dry run lists orphans on every host, and a token's prune reads only the hosts it is granted", async () => {
    const c = await boot();
    const maker = mint(c.app, {
      name: "maker",
      scopes: ["volume:delete"],
      hosts: { type: "list", ids: ["local", "small"] },
    });
    await createVolume(c.app.hosts.get("small"), { name: "small-mine", role: "cache", createdBy: maker.id });
    await createVolume(c.app.hosts.get("small"), { name: "small-theirs", role: "cache", createdBy: "owner" });
    await createVolume(c.app.hosts.get("large"), { name: "large-mine", role: "cache", createdBy: maker.id });
    ageVolumes(c);

    const listed = (await call(c.base, "/api/volumes/prune", { body: {} })).json as unknown as PruneReply;
    expect(listed.hosts.map((host) => host.hostId).toSorted()).toEqual(["large", "local", "small"]);
    expect(listed.volumes.map((row) => row.name).toSorted()).toEqual(["large-mine", "small-mine", "small-theirs"]);

    const granted = await call(c.base, "/api/volumes/prune", { token: maker.secret, body: { dryRun: false } });
    expect(granted.status).toBe(200);
    const pruned = granted.json as unknown as PruneReply;
    expect(pruned.hosts.map((host) => host.hostId).toSorted()).toEqual(["local", "small"]);
    expect(pruned.volumes.map((row) => [row.name, row.status])).toEqual([["small-mine", "removed"]]);
    expect(namesOn(c)).toEqual(expect.arrayContaining(["small-theirs", "large-mine"]));
    expect(namesOn(c)).not.toContain("small-mine");
  });
});

describe("POST /api/volumes/delete on several hosts", () => {
  test("an owner deletes volumes on two hosts in one request, in the order named", async () => {
    const c = await boot();
    await createVolume(c.app.hosts.get("small"), { name: "small-notes", role: "cache", createdBy: "owner" });
    await createVolume(c.app.hosts.get("large"), { name: "large-notes", role: "cache", createdBy: "owner" });

    const res = await call(c.base, "/api/volumes/delete", {
      body: { ids: ["large-notes", "small-notes"], confirm: true },
    });
    expect(res.status).toBe(200);
    const deleted = res.json as unknown as DeleteReply;
    expect(deleted.volumes.map((row) => [row.name, row.hostId, row.status])).toEqual([
      ["large-notes", "large", "removed"],
      ["small-notes", "small", "removed"],
    ]);
    expect(namesOn(c)).toEqual([]);
  });

  test("a token is refused a volume on a host it is not granted, and that volume is kept", async () => {
    const c = await boot();
    const maker = mint(c.app, {
      name: "maker",
      scopes: ["volume:delete"],
      hosts: { type: "list", ids: ["local", "small"] },
    });
    await createVolume(c.app.hosts.get("large"), { name: "large-mine", role: "cache", createdBy: maker.id });
    await createVolume(c.app.hosts.get("small"), { name: "small-mine", role: "cache", createdBy: maker.id });

    const res = await call(c.base, "/api/volumes/delete", {
      token: maker.secret,
      body: { ids: ["large-mine", "small-mine"], confirm: true },
    });
    expect(res.status).toBe(200);
    const deleted = res.json as unknown as DeleteReply;
    expect(deleted.volumes.map((row) => [row.name, row.status])).toEqual([
      ["large-mine", "refused"],
      ["small-mine", "removed"],
    ]);
    expect(deleted.volumes.find((row) => row.name === "large-mine")?.error).toMatchObject({
      key: "volume_delete_forbidden",
    });
    expect(namesOn(c)).toEqual(["large-mine"]);
  });
});
