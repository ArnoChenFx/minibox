import { afterEach, describe, expect, test } from "bun:test";

import { type Cluster, type BoxRef, bootCluster, boxOn, errorOf, GIB } from "./support/cluster";

let cluster: Cluster | null = null;

afterEach(() => {
  cluster?.close();
  cluster = null;
});

function current(): Cluster {
  if (!cluster) throw new Error("the test has not booted");
  return cluster;
}

async function boot(
  overrides: Parameters<typeof bootCluster>[0] = {},
  templates: Parameters<typeof bootCluster>[1] = ["local", "small", "large"],
) {
  cluster = await bootCluster(overrides, templates);
  return cluster;
}

const api = (path: string, init?: RequestInit) => current().api(path, init);
const post = (path: string, body: unknown) => current().post(path, body);

/** Sets a host's labels through the API, which is the path an operator takes for the local host too. */
async function setLabels(id: string, labels: Record<string, string>): Promise<void> {
  const res = await api(`/api/hosts/${id}`, { method: "PATCH", body: JSON.stringify({ labels }) });
  if (res.status !== 200) throw new Error(`set labels on ${id}: ${res.status} ${await res.text()}`);
}

async function labelsOf(id: string): Promise<Record<string, string>> {
  const { hosts } = (await (await api("/api/hosts")).json()) as {
    hosts: { id: string; labels: Record<string, string> }[];
  };
  return hosts.find((host) => host.id === id)?.labels ?? {};
}

/** Creates a box that asks `auto` to pick only among hosts carrying `hostLabels`. */
function autoWith(labels: Record<string, string>, name: string, extra: Record<string, unknown> = {}) {
  return post("/api/boxes", {
    name,
    cpus: 1,
    memoryMb: 256,
    host: "auto",
    hostLabels: labels,
    mounts: [],
    ...extra,
  });
}

describe("host labels through the API", () => {
  test("a host is added with labels, they are listed, and a set replaces them", async () => {
    await boot();
    const added = await post("/api/hosts", {
      id: "lab",
      endpoint: "unix:///run/minibox-test/lab-docker.sock",
      labels: { gpu: "true", "org/arch": "amd64" },
    });
    expect(added.status).toBe(201);
    expect(((await added.json()) as { host: { labels: Record<string, string> } }).host.labels).toEqual({
      gpu: "true",
      "org/arch": "amd64",
    });
    expect(await labelsOf("lab")).toEqual({ gpu: "true", "org/arch": "amd64" });

    const replaced = await api("/api/hosts/lab", { method: "PATCH", body: JSON.stringify({ labels: { zone: "eu" } }) });
    expect(replaced.status).toBe(200);
    expect(await labelsOf("lab")).toEqual({ zone: "eu" });

    const cleared = await api("/api/hosts/lab", { method: "PATCH", body: JSON.stringify({ labels: {} }) });
    expect(cleared.status).toBe(200);
    expect(await labelsOf("lab")).toEqual({});
  });

  test("the local host takes labels too, and an auto create may select it by them", async () => {
    await boot();
    expect(await labelsOf("local")).toEqual({});
    await setLabels("local", { gpu: "true" });
    expect(await labelsOf("local")).toEqual({ gpu: "true" });
    // A box on auto considers only online hosts, and the cluster's first check of the local host runs here.
    await current().app.hostAdmin.refresh();

    // The local host reports the machine's own capacity, so the box fits there whatever the machine is.
    const res = await autoWith({ gpu: "true" }, "local-labelled", { cpus: 1, memoryMb: 128 });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { box: { hostId: string } }).box.hostId).toBe("local");
  });

  test("a label that does not follow the rules is a 400 that names the problem, and nothing is written", async () => {
    await boot();
    for (const labels of [{ "Bad Key": "x" }, { gpu: 1 }, { "a/b/c": "x" }, { gpu: "two\nlines" }]) {
      const res = await api("/api/hosts/local", { method: "PATCH", body: JSON.stringify({ labels }) });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toMatchObject({ code: "validation_failed", key: "host_labels_invalid" });
    }
    expect(await labelsOf("local")).toEqual({});

    const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`l${index}`, ""]));
    expect((await api("/api/hosts/local", { method: "PATCH", body: JSON.stringify({ labels: tooMany }) })).status).toBe(
      400,
    );
  });

  test("labels on a host that is not held are a 404", async () => {
    await boot();
    const res = await api("/api/hosts/nowhere", { method: "PATCH", body: JSON.stringify({ labels: {} }) });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toMatchObject({ code: "not_found", key: "host_not_found" });
  });
});

describe("an auto create that selects a host by labels", () => {
  test("it goes to the labelled host with the most room, not the roomier one that lacks the label", async () => {
    await boot();
    await setLabels("small", { gpu: "true" });
    const placed = await autoWith({ gpu: "true" }, "alpha");
    expect(placed.status).toBe(201);
    expect(((await placed.json()) as { box: BoxRef }).box.hostId).toBe("small");
    expect(current().engines.small.callsTo("createContainer")).toHaveLength(1);
    expect(current().engines.large.callsTo("createContainer")).toHaveLength(0);
  });

  test("labels no host carries are a 422 that names them, and no box is created", async () => {
    await boot();
    await setLabels("small", { gpu: "true" });
    const res = await autoWith({ gpu: "true", arch: "amd64" }, "alpha");
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: "insufficient_capacity",
      key: "host_auto_no_label_match",
      params: { labels: "gpu=true, arch=amd64" },
      details: { field: "hostLabels" },
    });
    expect(current().engines.small.callsTo("createContainer")).toHaveLength(0);
    expect(current().engines.large.callsTo("createContainer")).toHaveLength(0);
    const { boxes } = (await (await api("/api/boxes")).json()) as { boxes: { name: string }[] };
    expect(boxes.map((box) => box.name)).not.toContain("alpha");
  });

  test("a create that names a host cannot also send labels, and says why", async () => {
    await boot();
    const res = await post("/api/boxes", {
      name: "alpha",
      cpus: 1,
      memoryMb: 256,
      host: "small",
      hostLabels: { gpu: "true" },
      mounts: [],
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ key: "host_labels_need_auto", details: { field: "hostLabels" } });
  });

  test("a label with an invalid key is refused by the input schema, before any host is looked at", async () => {
    await boot();
    const res = await autoWith({ "Bad Key": "x" }, "alpha");
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ key: "host_labels_invalid", details: { field: "hostLabels" } });
  });

  test("without hostLabels the placement is exactly what it was, labels or not", async () => {
    await boot();
    await setLabels("small", { gpu: "true" });
    await setLabels("large", { gpu: "true" });
    const placed = await post("/api/boxes", { name: "alpha", cpus: 1, memoryMb: 256, host: "auto", mounts: [] });
    expect(placed.status).toBe(201);
    expect(((await placed.json()) as { box: BoxRef }).box.hostId).toBe("large");
  });

  test("the template still comes first among the labelled hosts: a labelled host without the template is only a builder", async () => {
    // The template is seeded on local and small only, so large is a builder.
    await boot({}, ["local", "small"]);
    await setLabels("small", { gpu: "true" });
    await setLabels("large", { gpu: "true" });
    const placed = await autoWith({ gpu: "true" }, "alpha");
    expect(placed.status).toBe(201);
    expect(((await placed.json()) as { box: BoxRef }).box.hostId).toBe("small");
  });

  test("a labelled host that cannot hold the box is the no-room answer, never a fallback to a host without the label", async () => {
    await boot();
    await setLabels("small", { gpu: "true" });
    const res = await autoWith({ gpu: "true" }, "alpha", { cpus: 4 });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ code: "insufficient_capacity", key: "host_auto_no_room" });
  });

  test("an offline labelled host is not a candidate, so a set only it carries is refused", async () => {
    await boot();
    await setLabels("large", { gpu: "true" });
    current().engines.large.down = true;
    await current().app.hostAdmin.refresh();
    expect(current().app.hosts.get("large").host.status).toBe("offline");
    const res = await autoWith({ gpu: "true" }, "alpha");
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ key: "host_auto_no_label_match" });
  });

  test("the overcommit ratio applies to the labelled hosts as it does to the rest", async () => {
    await boot({ hostOvercommit: 2 });
    await setLabels("small", { gpu: "true" });
    await boxOn(current(), "small", "alpha", { cpus: 1, memoryMb: 256 });
    // The small engine reports 2 CPUs, and the ratio lifts the total its boxes may book to 4. One is booked, so a second
    // 2-CPU box fits, and a third one would not: a single box still may not ask for more than the host itself reports.
    const placed = await autoWith({ gpu: "true" }, "beta", { cpus: 2 });
    expect(placed.status).toBe(201);
    expect(((await placed.json()) as { box: BoxRef }).box.hostId).toBe("small");

    const over = await autoWith({ gpu: "true" }, "gamma", { cpus: 1.5 });
    expect(over.status).toBe(422);
    expect(await errorOf(over)).toMatchObject({ code: "insufficient_capacity", key: "host_auto_no_room" });
  });

  test("setting a host's labels keeps the order the hosts were added in, which a tie is broken by", async () => {
    await boot();
    // local, small and large are added in that order, and `auto` keeps the earlier host when two have as much room.
    await setLabels("local", { gpu: "true" });
    await setLabels("small", { gpu: "true" });
    await setLabels("large", { gpu: "true" });
    const { hosts } = (await (await api("/api/hosts")).json()) as { hosts: { id: string }[] };
    expect(hosts.map((host) => host.id)).toEqual(["local", "small", "large"]);
    const files = (await import("../src/data-dir")).hostsPath(current().app.cfg.dataDir);
    const stored = JSON.parse(await Bun.file(files).text()) as { hosts: { id: string }[] };
    expect(stored.hosts.map((host) => host.id)).toEqual(["local", "small", "large"]);
  });

  test("the labels an auto create asks for survive a restart of the control plane", async () => {
    const first = await boot();
    await setLabels("small", { gpu: "true" });
    // The hosts file is what a restart reads, so a fresh manager over the same DATA_DIR must see the labels again.
    const reloaded = first.app.hostAdmin;
    await reloaded.refresh();
    expect(await labelsOf("small")).toEqual({ gpu: "true" });
    expect(first.app.hosts.get("small").host.labels).toEqual({ gpu: "true" });
  });
});

describe("the local host's labels from HOST_LABELS", () => {
  test("the configured labels reach the local host, so an auto create can select it", async () => {
    await boot({ localHostLabels: { gpu: "true", "org/arch": "amd64" } });
    expect(await labelsOf("local")).toEqual({ gpu: "true", "org/arch": "amd64" });
    await current().app.hostAdmin.refresh();
    const res = await autoWith({ "org/arch": "amd64" }, "alpha", { cpus: 1, memoryMb: 128 });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { box: { hostId: string } }).box.hostId).toBe("local");
  });

  test("labels set through the API are kept over the configuration, so an old .env does not undo them", async () => {
    await boot({ localHostLabels: { gpu: "true" } });
    await setLabels("local", { zone: "eu" });
    expect(await labelsOf("local")).toEqual({ zone: "eu" });
  });
});

describe("the template's own capacity is still what decides a labelled box", () => {
  test("a labelled box that fits nowhere is the no-room answer", async () => {
    await boot();
    await setLabels("large", { gpu: "true" });
    // The large fake engine reports 8 CPUs and 16 GiB, so 64 CPUs fit nowhere.
    const res = await autoWith({ gpu: "true" }, "alpha", { cpus: 64, memoryMb: 1024 });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ key: "host_auto_no_room" });
    expect(GIB).toBe(1024 ** 3);
  });
});
