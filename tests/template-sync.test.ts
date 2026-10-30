import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Server } from "bun";

import { type App, createApp } from "../src/app";
import { ROOT } from "../src/config";
import type { LabelKeys } from "../src/labels";
import { type ExecSpec, RuntimeError } from "../src/runtime";
import { startServer } from "../src/server";
import { createDeclaredTemplate, readRecipe, removeRecipe, templateSetupOf } from "../src/services/template-builds";
import type { SocketData } from "../src/ws/socket";
import { silenceLogs, TEST_KEY, testConfig } from "./support/app";
import { bootCluster, type Cluster } from "./support/cluster";
import { FakeRuntime } from "./support/fake-runtime";
import { FakeCheckpointEngine } from "./support/fake-snapshots";
import { DEVCONTAINER_WITH_SETUP, serveRepository } from "./support/repository";

const GIB = 1024 ** 3;
const EDGE_SOCKET = "/run/minibox-test/edge-docker.sock";
const GOLD = "mbtest-template:gold";
const DEV = "mbtest-template:dev";
const DEV_SETUP = { postCreate: ["/bin/sh", "-c", "npm install"], forwardPorts: [3000] };

interface CreateResponse {
  box: { hostId?: string };
  sync?: { taskId: string };
  setup?: { taskId: string };
}

let app: App;
let server: Server<SocketData>;
let base: string;
let local: FakeRuntime;
let edge: FakeRuntime;
let keys: LabelKeys;
let restoreLogs: () => void;

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TEST_KEY}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function errorKeyOf(res: Response): Promise<string | undefined> {
  return (await json<{ error: { key?: string } }>(res)).error.key;
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** A template only the local engine holds, so a create on the edge host has to copy it. */
function seedGold(): void {
  local.seedImage(GOLD, { [keys.template]: "true", [keys.templateName]: "gold" });
}

function createOn(host: string, name: string, template = GOLD) {
  return post("/api/boxes", { name, cpus: 1, memoryMb: 256, host, template, mounts: [] });
}

async function syncTo(ref: string, host: string): Promise<string> {
  const started = await post(`/api/templates/${encodeURIComponent(ref)}/sync`, { host });
  expect(started.status).toBe(202);
  return (await json<{ taskId: string }>(started)).taskId;
}

beforeEach(async () => {
  restoreLogs = silenceLogs();
  local = new FakeRuntime();
  edge = new FakeRuntime();
  edge.engine = { cpus: 2, memoryBytes: 4 * GIB };
  app = createApp(testConfig({ labelPrefix: "mbtest" }), "0.0.0-test", {
    runtime: local,
    connect: () => edge,
    checkpointEngine: new FakeCheckpointEngine(),
    eventsPath: ":memory:",
  });
  keys = app.hosts.get().keys;
  for (const runtime of [local, edge]) {
    runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  }
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

describe("a box created where its template is missing copies the template first", () => {
  test("the copy runs as a task the create waits for, and the box starts from the copied image", async () => {
    seedGold();
    const res = await createOn("edge", "alpha");
    expect(res.status).toBe(201);
    const { box, sync } = await json<CreateResponse>(res);
    expect(box.hostId).toBe("edge");
    expect(sync?.taskId).toBeString();
    expect(edge.callsTo("loadImage")).toHaveLength(1);
    expect(edge.callsTo("createContainer")).toHaveLength(1);
    expect(app.tasks.get(sync?.taskId ?? "", { output: false })).toMatchObject({
      op: "template.sync",
      status: "succeeded",
      hostId: "edge",
      result: { ref: GOLD, host: "edge", sent: true },
    });
  });

  test("a host that already holds the template gets no copy, and no sync is reported", async () => {
    seedGold();
    edge.seedImage(GOLD, { [keys.template]: "true", [keys.templateName]: "gold" });
    const res = await createOn("edge", "alpha");
    expect(res.status).toBe(201);
    expect((await json<CreateResponse>(res)).sync).toBeUndefined();
    expect(edge.callsTo("loadImage")).toHaveLength(0);
    expect(local.callsTo("saveImage")).toHaveLength(0);
  });

  test("a template no host holds is not copied, and the create is refused as it always was", async () => {
    const res = await createOn("edge", "alpha", "mbtest-template:nowhere");
    expect(res.status).toBe(400);
    expect(await errorKeyOf(res)).toBe("template_image_missing");
    expect(edge.callsTo("loadImage")).toHaveLength(0);
  });

  test("a copy that fails fails the create with the copy's error, and leaves no box behind", async () => {
    seedGold();
    edge.fail("loadImage", new RuntimeError("engine", "boom"));
    const res = await createOn("edge", "alpha");
    expect(res.status).toBe(502);
    expect(await errorKeyOf(res)).toBe("docker_error");
    expect(app.tasks.list({ limit: 10 })).toContainEqual(
      expect.objectContaining({ op: "template.sync", status: "failed" }),
    );
    expect(app.hosts.get().specs.list()).toEqual([]);
    expect(edge.callsTo("createContainer")).toHaveLength(0);
  });

  test("two creates that need the same copy share one copy, and both boxes are made", async () => {
    seedGold();
    const gate = edge.hold("loadImage");
    const first = createOn("edge", "alpha");
    await waitFor(() => edge.callsTo("loadImage").length === 1, "the copy to start");
    const inspected = edge.callsTo("inspectImage").length;
    const second = createOn("edge", "beta");
    await waitFor(() => edge.callsTo("inspectImage").length > inspected, "the second create to look for the template");
    await Bun.sleep(20);
    gate.release();
    const [a, b] = await Promise.all([first, second]);
    const [bodyA, bodyB] = [await json<CreateResponse>(a), await json<CreateResponse>(b)];
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(bodyA.sync?.taskId).toBeString();
    expect(bodyB.sync?.taskId).toBe(bodyA.sync?.taskId);
    expect(edge.callsTo("loadImage")).toHaveLength(1);
    expect(edge.callsTo("createContainer")).toHaveLength(2);
  });

  test("a create the host refuses for a taken name copies nothing first", async () => {
    expect((await createOn("edge", "alpha", app.cfg.baseTemplateTag)).status).toBe(201);
    seedGold();
    const res = await createOn("edge", "alpha");
    expect(res.status).toBe(409);
    expect(await errorKeyOf(res)).toBe("box_exists");
    expect(edge.callsTo("loadImage")).toHaveLength(0);
  });

  test("a create that names an unset secret copies nothing first", async () => {
    seedGold();
    const res = await post("/api/boxes", {
      name: "alpha",
      cpus: 1,
      memoryMb: 256,
      host: "edge",
      template: GOLD,
      mounts: [],
      env: [{ name: "TOKEN", secretRef: "unset" }],
    });
    expect(res.status).toBe(400);
    expect(await errorKeyOf(res)).toBe("env_secret_missing");
    expect(edge.callsTo("loadImage")).toHaveLength(0);
  });
});

describe("template sync copies a template to a host on request", () => {
  test("the copy runs as a task, and a second copy to the same host sends nothing", async () => {
    seedGold();
    const started = await post(`/api/templates/${encodeURIComponent(GOLD)}/sync`, { host: "edge" });
    expect(started.status).toBe(202);
    const { taskId } = await json<{ taskId: string }>(started);
    await app.tasks.drain();
    expect(app.tasks.get(taskId, { output: false })).toMatchObject({
      status: "succeeded",
      result: { ref: GOLD, host: "edge", sent: true },
    });

    const again = await json<{ taskId: string }>(
      await post(`/api/templates/${encodeURIComponent(GOLD)}/sync`, { host: "edge" }),
    );
    await app.tasks.drain();
    expect(app.tasks.get(again.taskId, { output: false })?.result).toMatchObject({ sent: false });

    const { templates } = await json<{ templates: { ref: string; hostId: string }[] }>(
      await api("/api/templates?host=edge"),
    );
    expect(templates).toContainEqual(expect.objectContaining({ ref: GOLD, hostId: "edge" }));
  });

  test("a template no other host holds is refused before a task starts", async () => {
    const res = await post(`/api/templates/${encodeURIComponent("mbtest-template:nowhere")}/sync`, { host: "edge" });
    expect(res.status).toBe(404);
    expect(await errorKeyOf(res)).toBe("template_not_found");
    expect(app.tasks.list({ limit: 10 })).toEqual([]);
  });

  test("a host that is not added is a 404", async () => {
    seedGold();
    const res = await post(`/api/templates/${encodeURIComponent(GOLD)}/sync`, { host: "nowhere" });
    expect(res.status).toBe(404);
    expect(await errorKeyOf(res)).toBe("host_not_found");
  });
});

describe("a declared template keeps its setup on the hosts it is copied to", () => {
  beforeEach(async () => {
    serveRepository(local, new Map([[".devcontainer/devcontainer.json", DEVCONTAINER_WITH_SETUP]]));
    await createDeclaredTemplate(
      app.hosts.get(),
      { name: "dev", source: { kind: "devcontainer", url: "https://github.com/org/app.git" }, createdBy: "owner" },
      {},
    );
  });

  test("a sync copies the recipe, so the copy reports the setup of the declared template", async () => {
    await syncTo(DEV, "edge");
    await app.tasks.drain();

    const edgeHost = app.hosts.get("edge");
    expect(readRecipe(edgeHost, "dev")).toEqual(readRecipe(app.hosts.get(), "dev"));
    expect(await templateSetupOf(edgeHost, DEV)).toEqual(DEV_SETUP);
  });

  test("a box created where the template has to be copied first runs its setup on that host, as dev", async () => {
    const res = await createOn("edge", "alpha", DEV);
    expect(res.status).toBe(201);
    const { sync, setup } = await json<CreateResponse>(res);
    expect(sync?.taskId).toBeString();
    await app.tasks.drain();

    expect(app.tasks.get(setup?.taskId ?? "", { output: false })).toMatchObject({
      op: "box.setup",
      status: "succeeded",
    });
    const execs = edge
      .callsTo("startExec")
      .map((entry) => entry.args[1] as ExecSpec)
      .filter((spec) => JSON.stringify(spec.cmd) === JSON.stringify(DEV_SETUP.postCreate));
    expect(execs).toEqual([expect.objectContaining({ user: "dev", workingDir: "/" })]);
  });

  test("a host that holds the image but not its recipe gets the recipe on the next sync", async () => {
    await syncTo(DEV, "edge");
    await app.tasks.drain();
    removeRecipe(app.hosts.get("edge"), "dev");
    expect(await templateSetupOf(app.hosts.get("edge"), DEV)).toBeNull();

    const again = await syncTo(DEV, "edge");
    await app.tasks.drain();
    expect(app.tasks.get(again, { output: false })).toMatchObject({ status: "succeeded", result: { sent: false } });
    expect(await templateSetupOf(app.hosts.get("edge"), DEV)).toEqual(DEV_SETUP);
  });

  test("a template that no recipe built is copied without one, so its copy has no setup", async () => {
    seedGold();
    await syncTo(GOLD, "edge");
    await app.tasks.drain();

    expect(readRecipe(app.hosts.get("edge"), "gold")).toBeNull();
    expect(await templateSetupOf(app.hosts.get("edge"), GOLD)).toBeNull();
  });
});

/** The source as a host stores it, rather than as a read interprets an official source. */
function storedSourceOf(host: { specs: { dir(): string }; host: { id: string } }, name: string): unknown {
  const path = join(dirname(host.specs.dir()), "template-recipes", host.host.id, `${name}.json`);
  return (JSON.parse(readFileSync(path, "utf8")) as { source: unknown }).source;
}

describe("a copy of an old fork keeps the source the source host stores", () => {
  let cluster: Cluster | undefined;
  let templates = "";

  beforeEach(() => {
    // A templates directory of its own, so a test can change the official Dockerfile without touching the repository.
    templates = mkdtempSync(join(tmpdir(), "minibox-templates-"));
    cpSync(join(ROOT, "templates"), templates, { recursive: true });
  });

  afterEach(() => {
    cluster?.close();
    cluster = undefined;
    rmSync(templates, { recursive: true, force: true });
  });

  test("the target keeps the official source, so an upgrade gives both hosts the same text", async () => {
    cluster = await bootCluster({ templatesDir: templates }, ["local", "small"]);
    const localHost = cluster.app.hosts.get();
    const smallHost = cluster.app.hosts.get("small");

    // The official `node` template, and a fork of it written the way an earlier version did: the fork's own image, still
    // naming the official source.
    await createDeclaredTemplate(
      localHost,
      { name: "node", source: { kind: "official", name: "node" }, createdBy: "owner" },
      {},
    );
    expect((await cluster.post("/api/templates/mbtest-template:node/fork", { name: "node-copy" })).status).toBe(201);
    const recipeFile = join(dirname(localHost.specs.dir()), "template-recipes", localHost.host.id, "node-copy.json");
    const forked = JSON.parse(readFileSync(recipeFile, "utf8")) as Record<string, unknown>;
    writeFileSync(recipeFile, JSON.stringify({ ...forked, source: { kind: "official", name: "node" } }));

    // Copy it to the other host, as a create there, a sync or a move does.
    const started = await cluster.post("/api/templates/mbtest-template:node-copy/sync", { host: "small" });
    expect(started.status).toBe(202);
    const { taskId } = (await started.json()) as { taskId: string };
    await cluster.app.tasks.drain();
    expect(cluster.app.tasks.get(taskId, { output: false })).toMatchObject({ status: "succeeded" });
    // The copy carries the record as stored, not as the source host read it.
    expect(storedSourceOf(smallHost, "node-copy")).toEqual({ kind: "official", name: "node" });

    // A MiniBox upgrade changes the Dockerfile both hosts ship.
    const shipped = readFileSync(join(templates, "official", "node", "Dockerfile"), "utf8");
    writeFileSync(join(templates, "official", "node", "Dockerfile"), `${shipped}RUN echo upgraded\n`);

    expect(readRecipe(smallHost, "node-copy")?.source).toEqual({
      kind: "dockerfile",
      text: `${shipped}RUN echo upgraded\n`,
    });
    expect(readRecipe(smallHost, "node-copy")?.source).toEqual(readRecipe(localHost, "node-copy")?.source);
  });
});
