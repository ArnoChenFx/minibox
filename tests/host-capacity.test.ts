import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";

import {
  type Cluster,
  type HostName,
  boxOn as boxOnIn,
  bootCluster,
  errorOf,
  GIB,
  SMALL_SOCKET,
} from "./support/cluster";
import { mint } from "./support/tokens";

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
  templates: HostName[] = ["local", "small", "large"],
) {
  cluster = await bootCluster(overrides, templates);
}

const api = (path: string, init?: RequestInit) => current().api(path, init);
const post = (path: string, body: unknown) => current().post(path, body);
const boxOn = (host: string | undefined, name: string, extra: Record<string, unknown> = {}) =>
  boxOnIn(current(), host, name, extra);
const resize = (boxId: string, body: unknown, revision: number) =>
  api(`/api/boxes/${boxId}/resources`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "if-match": String(revision) },
  });

/** A box create sent with a token instead of the owner key. */
const createAs = (secret: string, body: unknown) =>
  fetch(`${current().base}/api/boxes`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("a running box books its CPU and memory against the host it runs on", () => {
  test("a box that would push the running boxes past the host's CPU limit is refused, and the refusal gives the total", async () => {
    await boot();
    await boxOn("small", "alpha", { cpus: 1 });

    const res = await post("/api/boxes", { name: "beta", cpus: 2, memoryMb: 256, host: "small", mounts: [] });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: "insufficient_capacity",
      key: "cpu_booked_over_host",
      params: { booked: 3, limit: 2 },
      details: { field: "cpus" },
    });
    expect(current().engines.small.callsTo("createContainer")).toHaveLength(1);
  });

  test("the overcommit ratio raises the limit that the booked total is held to", async () => {
    await boot({ hostOvercommit: 2 });
    await boxOn("small", "alpha", { cpus: 1 });
    await boxOn("small", "beta", { cpus: 2 });

    const res = await post("/api/boxes", { name: "gamma", cpus: 2, memoryMb: 256, host: "small", mounts: [] });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ key: "cpu_booked_over_host", params: { booked: 5, limit: 4 } });
  });

  test("memory is booked the same way, against the memory the host reports", async () => {
    await boot();
    await boxOn("small", "alpha", { memoryMb: 3 * 1024 });

    const res = await post("/api/boxes", { name: "beta", cpus: 1, memoryMb: 2048, host: "small", mounts: [] });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      key: "memory_booked_over_host",
      params: { booked: 5, limit: 4 },
      details: { field: "memoryMb" },
    });
  });

  test("a stopped box books nothing, so the host has its room back", async () => {
    await boot();
    const alpha = await boxOn("small", "alpha", { cpus: 2 });
    expect((await api(`/api/boxes/${alpha.boxId}/stop`, { method: "POST" })).status).toBe(200);

    await boxOn("small", "beta", { cpus: 2 });
    expect(current().engines.small.callsTo("createContainer")).toHaveLength(2);
  });

  test("a resize is checked for how much it grows a running box, and a shrink is never refused", async () => {
    await boot();
    const alpha = await boxOn("small", "alpha", { cpus: 1 });
    await boxOn("small", "beta", { cpus: 1 });

    const grown = await resize(alpha.boxId, { cpus: 2 }, alpha.revision);
    expect(grown.status).toBe(422);
    expect(await errorOf(grown)).toMatchObject({ key: "cpu_booked_over_host", params: { booked: 3, limit: 2 } });

    const shrunk = await resize(alpha.boxId, { cpus: 0.5 }, alpha.revision);
    expect(shrunk.status).toBe(200);
    const revision = ((await shrunk.json()) as { box: { revision: number } }).box.revision;

    expect((await resize(alpha.boxId, { memoryMb: 512 }, revision)).status).toBe(200);
  });

  test("a resize of a stopped box is not checked, since it books nothing", async () => {
    await boot();
    const alpha = await boxOn("small", "alpha", { cpus: 1 });
    expect((await api(`/api/boxes/${alpha.boxId}/stop`, { method: "POST" })).status).toBe(200);
    await boxOn("small", "beta", { cpus: 2 });

    const res = await resize(alpha.boxId, { cpus: 2 }, alpha.revision + 1);
    expect(res.status).toBe(200);
  });
});

describe("a control plane with one host has no booking check", () => {
  test("two boxes may each take the whole machine, as they always could before hosts existed", async () => {
    await boot();
    expect((await api("/api/hosts/small", { method: "DELETE" })).status).toBe(200);
    expect((await api("/api/hosts/large", { method: "DELETE" })).status).toBe(200);

    const cores = os.cpus().length;
    await boxOn(undefined, "alpha", { cpus: cores });
    const second = await boxOn(undefined, "beta", { cpus: cores });
    expect(second.hostId).toBeUndefined();
    expect(current().engines.local.callsTo("createContainer")).toHaveLength(2);
  });
});

describe("host auto places a new box on the reachable host with the most room", () => {
  test("the host left with the most free CPU and memory once the box is placed wins", async () => {
    await boot({}, ["small", "large"]);
    await boxOn("small", "alpha", { cpus: 1 });

    const placed = await boxOn("auto", "beta", { cpus: 1 });
    expect(placed.hostId).toBe("large");
    expect(current().engines.large.callsTo("createContainer")).toHaveLength(1);
  });

  test("a host without the template is not a candidate, however empty it is", async () => {
    await boot({}, ["small"]);
    await boxOn("small", "alpha", { cpus: 1 });

    const placed = await boxOn("auto", "beta", { cpus: 1 });
    expect(placed.hostId).toBe("small");
    expect(current().engines.large.callsTo("createContainer")).toHaveLength(0);
  });

  test("an offline host is skipped, even when it is the emptiest", async () => {
    await boot({}, ["small", "large"]);
    current().app.hosts.get("large").host.status = "offline";

    const placed = await boxOn("auto", "alpha", { cpus: 1 });
    expect(placed.hostId).toBe("small");
  });

  test("equally free hosts keep the order they were added in", async () => {
    await boot({}, ["small", "large"]);
    current().engines.small.engine = { cpus: 4, memoryBytes: 8 * GIB };
    current().engines.large.engine = { cpus: 4, memoryBytes: 8 * GIB };

    const placed = await boxOn("auto", "alpha", { cpus: 1 });
    expect(placed.hostId).toBe("small");
  });

  test("when no online host holds the template, auto is refused and names the template", async () => {
    await boot({}, []);
    const res = await post("/api/boxes", { name: "alpha", cpus: 1, memoryMb: 256, host: "auto", mounts: [] });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ key: "template_image_missing", details: { field: "template" } });
  });

  test("when no host with the template has room for the box, auto is a 422 and no box is made", async () => {
    await boot({}, ["small", "large"]);
    const res = await post("/api/boxes", { name: "alpha", cpus: 16, memoryMb: 256, host: "auto", mounts: [] });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ code: "insufficient_capacity", key: "host_auto_no_room" });
    expect(current().engines.large.callsTo("createContainer")).toHaveLength(0);
  });

  test("a token's auto create considers only the hosts it is granted, and never reads the others", async () => {
    await boot({}, ["small", "large"]);
    const token = mint(current().app, {
      name: "small-only",
      preset: "operator",
      hosts: { type: "list", ids: ["small"] },
    });
    const inspectsBefore = current().engines.large.callsTo("inspectImage").length;
    const res = await createAs(token.secret, { name: "alpha", cpus: 1, memoryMb: 256, host: "auto", mounts: [] });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { box: { hostId: string } }).box.hostId).toBe("small");
    expect(current().engines.large.callsTo("createContainer")).toHaveLength(0);
    expect(current().engines.large.callsTo("inspectImage")).toHaveLength(inspectsBefore);
  });

  test("a token granted no host is refused an auto create before any engine is read", async () => {
    await boot({}, ["small", "large"]);
    const token = mint(current().app, { name: "nowhere", preset: "operator", hosts: { type: "list", ids: [] } });
    const res = await createAs(token.secret, { name: "alpha", cpus: 1, memoryMb: 256, host: "auto", mounts: [] });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatchObject({ key: "host_not_granted" });
  });

  test("auto is a reserved word, so no host can be added under that id", async () => {
    await boot();
    const res = await post("/api/hosts", { id: "auto", endpoint: `unix://${SMALL_SOCKET}` });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ key: "host_id_reserved" });
  });
});
