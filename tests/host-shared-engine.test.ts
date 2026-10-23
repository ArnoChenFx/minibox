import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Server } from "bun";

import { type App, createApp } from "../src/app";
import type { LabelKeys } from "../src/labels";
import { startServer } from "../src/server";
import { getBox, listBoxes, locateBox } from "../src/services/boxes";
import { reconcileHost } from "../src/services/reconcile";
import type { SocketData } from "../src/ws/socket";
import { silenceLogs, TEST_KEY, testConfig } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";
import { FakeCheckpointEngine } from "./support/fake-snapshots";

const EDGE_SOCKET = "/run/minibox-test/edge-docker.sock";

let app: App;
let server: Server<SocketData>;
let base: string;
let engine: FakeRuntime;
let keys: LabelKeys;
let restoreLogs: () => void;

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TEST_KEY}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });

async function boxOn(host: string | undefined, name: string): Promise<{ boxId: string }> {
  const res = await post("/api/boxes", { name, cpus: 1, memoryMb: 256, host, mounts: [] });
  expect(res.status).toBe(201);
  return ((await res.json()) as { box: { boxId: string } }).box;
}

async function listed(query = ""): Promise<{ name: string; hostId?: string }[]> {
  const body = (await (await api(`/api/boxes${query}`)).json()) as { boxes: { name: string; hostId?: string }[] };
  return body.boxes;
}

beforeEach(async () => {
  restoreLogs = silenceLogs();
  engine = new FakeRuntime();
  app = createApp(testConfig({ labelPrefix: "mbtest" }), "0.0.0-test", {
    runtime: engine,
    connect: () => engine,
    checkpointEngine: new FakeCheckpointEngine(),
    eventsPath: ":memory:",
  });
  keys = app.hosts.get().keys;
  engine.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
  const added = await post("/api/hosts", { id: "edge", endpoint: `unix://${EDGE_SOCKET}` });
  expect(added.status).toBe(201);
});

afterEach(() => {
  app.hostAdmin.close();
  app.sessions.stop();
  app.tokens.stop();
  server.stop(true);
  restoreLogs();
});

describe("two hosts that share one engine: a box belongs to the host whose spec names it", () => {
  test("the other host cannot read a box it does not hold, by name, stable id or container", async () => {
    const box = await boxOn("local", "alpha");
    const edge = app.hosts.get("edge");

    await expect(getBox(edge, "alpha")).rejects.toMatchObject({ status: 404 });
    await expect(getBox(edge, box.boxId)).rejects.toMatchObject({ status: 404 });
    expect((await getBox(app.hosts.get("local"), "alpha")).hostId).toBe("local");
  });

  test("the other host does not list the box, and the box is listed once, on its own host", async () => {
    await boxOn("local", "alpha");
    expect(await listBoxes(app.hosts.get("edge"))).toEqual([]);
    expect((await listBoxes(app.hosts.get("local"))).map((box) => [box.name, box.hostId])).toEqual([
      ["alpha", "local"],
    ]);

    expect((await listed()).map((box) => [box.name, box.hostId])).toEqual([["alpha", "local"]]);
    expect(await listed("?host=edge")).toEqual([]);
  });

  test("reconciling the other host does not claim or start the box", async () => {
    const box = await boxOn("local", "alpha");
    const report = await reconcileHost(app.hosts.get("edge"));
    expect(report.claimed).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(app.hosts.get("local").specs.read(box.boxId)?.hostId).toBe("local");
  });

  test("the host counts in the list of hosts name only the boxes they hold", async () => {
    await boxOn("local", "alpha");
    const hosts = (await (await api("/api/hosts")).json()) as { hosts: { id: string; boxes: number }[] };
    expect(Object.fromEntries(hosts.hosts.map((host) => [host.id, host.boxes]))).toEqual({ local: 1, edge: 0 });
  });

  test("a container no spec covers is claimed by exactly one host, and the other refuses it", async () => {
    engine.seedContainer({
      name: "mbtest-stray",
      image: app.cfg.baseTemplateTag,
      labels: { [keys.box]: "true", [keys.name]: "stray" },
      running: true,
    });

    const { host } = await locateBox(app.hosts, "stray");
    const other = app.hosts.list().find((candidate) => candidate.host.id !== host.host.id);
    expect(other).toBeDefined();
    if (!other) return;
    await expect(getBox(other, "stray")).rejects.toMatchObject({ status: 404 });
    expect((await getBox(host, "stray")).hostId).toBe(host.host.id);
    const specs = app.hosts
      .get()
      .specs.list()
      .filter((spec) => spec.name === "stray");
    expect(specs.map((spec) => spec.hostId)).toEqual([host.host.id]);
  });
});
