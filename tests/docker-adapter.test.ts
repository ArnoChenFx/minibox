import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Server } from "bun";

import { createDockerRuntime } from "../src/docker/runtime";
import type { Runtime } from "../src/runtime";
import { rejectionOf } from "./support/app";

/** A tiny Engine API on a unix socket, so the adapter's HTTP error handling runs without a daemon. */
interface Recorded {
  method: string;
  path: string;
  search: string;
}

let dir: string;
let socket: string;
let server: Server<undefined>;
let listed: string[] = [];
let listStates: Record<string, string> = {};
const recorded: Recorded[] = [];

const RUNNING = {
  Id: "ok",
  Name: "/alpha",
  Created: "2026-10-20T10:00:00Z",
  Image: "sha256:9f1c0a",
  Config: { Image: "minibox-template:base", Labels: { minibox: "true", "minibox.name": "alpha" } },
  State: { Status: "running", Running: true, StartedAt: "2026-10-20T10:01:00Z" },
  HostConfig: {
    NanoCpus: 1_500_000_000,
    Memory: 512 * 1024 * 1024,
    NetworkMode: "minibox-boxes",
    PidsLimit: 256,
    RestartPolicy: { Name: "unless-stopped" },
  },
  Mounts: [
    {
      Type: "volume",
      Name: "mbx-alpha-workspace",
      Source: "/var/lib/docker/volumes/mbx-alpha-workspace/_data",
      Destination: "/workspace",
      RW: true,
      Mode: "z",
    },
  ],
};

const NEVER_STARTED = {
  Id: "fresh",
  Name: "/fresh",
  Created: "2026-10-20T10:00:00Z",
  Config: { Image: "minibox-template:base", Labels: {} },
  State: { Status: "created", Running: false, StartedAt: "0001-01-01T00:00:00Z" },
  HostConfig: { NanoCpus: 0, Memory: 0, NetworkMode: "default" },
};

/** When set, inspects of "ok" wait for it, so a test can change the container while an inspect is in flight. */
let inspectGate: Promise<void> | null = null;

const inspectable: Record<string, { status: number; body: unknown }> = {
  ok: { status: 200, body: RUNNING },
  fresh: { status: 200, body: NEVER_STARTED },
  gone: { status: 404, body: { message: "No such container: gone" } },
  broken: { status: 500, body: { message: "engine exploded" } },
};

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** Builds that the engine saw the client close, counted once per build. */
let buildCloses = 0;

/** A build that prints a line every few milliseconds until its connection closes. */
async function slowBuild(req: Request): Promise<Response> {
  await req.arrayBuffer();
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    buildCloses += 1;
  };
  req.signal.addEventListener("abort", close, { once: true });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => controller.enqueue(encoder.encode('{"stream":"Step 1/1\\n"}\n')), 10);
    },
    cancel: close,
  });
  return new Response(body, { headers: { "content-type": "application/json" } });
}

async function engine(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/v[\d.]+(?=\/)/, "");
  recorded.push({ method: req.method, path, search: url.search });

  if (req.method === "GET" && path === "/_ping") return new Response("OK");
  if (req.method === "GET" && path === "/containers/json") {
    return json(listed.map((id) => ({ Id: id, Names: [`/${id}`], Labels: {}, State: listStates[id] ?? "running" })));
  }
  const inspect = /^\/containers\/([^/]+)\/json$/.exec(path);
  if (req.method === "GET" && inspect) {
    if (inspect[1] === "ok" && inspectGate) await inspectGate;
    const entry = inspectable[inspect[1] ?? ""] ?? { status: 404, body: { message: "No such container" } };
    return json(entry.body, entry.status);
  }
  const diff = /^\/containers\/([^/]+)\/changes$/.exec(path);
  if (req.method === "GET" && diff) {
    const id = diff[1] ?? "";
    if (id === "pristine") return json(null);
    if (id === "empty") return new Response("");
    if (id === "object") return json({ Path: "/tmp", Kind: 0 });
    if (id === "text") return new Response("<html>bad gateway</html>", { headers: { "content-type": "text/html" } });
    if (id === "zero") return json(0);
    if (id === "edited") {
      return json([
        { Path: "/tmp", Kind: 0 },
        { Path: "/tmp/mb-diff", Kind: 1 },
        { Path: "/var/cache/old", Kind: 2 },
      ]);
    }
    return json({ message: `No such container: ${id}` }, 404);
  }
  if (req.method === "POST" && path === "/build") return slowBuild(req);
  if (req.method === "POST" && path === "/containers/create") {
    if (url.searchParams.get("name") === "taken") {
      return json({ message: 'Conflict. The container name "/taken" is already in use' }, 409);
    }
    const body = (await req.json()) as { Image?: string };
    if (body.Image === "missing:latest") return json({ message: "No such image: missing:latest" }, 404);
    return json({ Id: "new" }, 201);
  }
  const lifecycle = /^\/containers\/([^/]+)\/(start|stop)$/.exec(path);
  if (req.method === "POST" && lifecycle) {
    return new Response(null, { status: lifecycle[1] === "already" ? 304 : 204 });
  }
  const change = /^\/containers\/([^/]+)\/(update|rename|restart)$/.exec(path);
  if (req.method === "POST" && change) {
    return change[2] === "update" ? json({ Warnings: [] }) : new Response(null, { status: 204 });
  }
  const volume = /^\/volumes\/([^/]+)$/.exec(path);
  if (volume) {
    const name = volume[1] ?? "";
    if (req.method === "GET" && name === "absent") return json({ message: "get absent: no such volume" }, 404);
    if (req.method === "GET") return json({ Name: name, Labels: {} });
    if (req.method === "DELETE" && name === "busy") return json({ message: "remove busy: volume is in use" }, 409);
    if (req.method === "DELETE") return new Response(null, { status: 204 });
  }
  return json({ message: `unexpected ${req.method} ${path}` }, 500);
}

const runtime = () => createDockerRuntime(socket);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "minibox-engine-"));
  socket = join(dir, "engine.sock");
  server = Bun.serve({ unix: socket, fetch: engine });
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("Docker adapter against a fake engine socket", () => {
  test("ping reaches the engine, and a socket that does not exist is unavailable", async () => {
    await runtime().ping();
    expect(await rejectionOf(createDockerRuntime(join(dir, "missing.sock")).ping())).toMatchObject({
      kind: "unavailable",
    });
  });

  test("inspect maps limits, mounts and restart policy, and a container that never started has no start time", async () => {
    expect(await runtime().inspectContainer("ok")).toEqual({
      id: "ok",
      name: "alpha",
      image: "minibox-template:base",
      imageId: "sha256:9f1c0a",
      labels: { minibox: "true", "minibox.name": "alpha" },
      created: "2026-10-20T10:00:00Z",
      state: "running",
      running: true,
      startedAt: "2026-10-20T10:01:00Z",
      cpus: 1.5,
      memoryBytes: 512 * 1024 * 1024,
      pidsLimit: 256,
      restart: "unless-stopped",
      mounts: [{ source: "mbx-alpha-workspace", target: "/workspace", mode: "rw" }],
      network: "minibox-boxes",
    });
    expect(await runtime().inspectContainer("fresh")).toMatchObject({
      state: "created",
      running: false,
      startedAt: null,
      cpus: null,
      memoryBytes: null,
      pidsLimit: null,
      restart: "no",
      mounts: [],
      network: "bridge",
    });
  });

  test("listing skips a container that vanished before it was inspected", async () => {
    listed = ["ok", "gone"];
    const containers = await runtime().listContainers({ labels: { minibox: "true" } });
    expect(containers.map((c) => c.id)).toEqual(["ok"]);
  });

  test("listing fails on an engine error instead of hiding the container", async () => {
    listed = ["ok", "broken"];
    expect(await rejectionOf(runtime().listContainers({ labels: {} }))).toMatchObject({
      kind: "engine",
      detail: "engine exploded",
    });
  });

  test("a taken container name is a conflict, and a missing image is not_found", async () => {
    expect(
      await rejectionOf(runtime().createContainer({ image: "minibox-template:base", name: "taken" })),
    ).toMatchObject({ kind: "conflict", detail: expect.stringContaining("already in use") });
    expect(await rejectionOf(runtime().createContainer({ image: "missing:latest" }))).toMatchObject({
      kind: "not_found",
    });
  });

  test("a missing container is not_found, and an unexpected status is an engine error", async () => {
    expect(await rejectionOf(runtime().inspectContainer("gone"))).toMatchObject({
      kind: "not_found",
      detail: "No such container: gone",
    });
    expect(await rejectionOf(runtime().inspectContainer("broken"))).toMatchObject({
      kind: "engine",
      detail: "engine exploded",
    });
  });

  test("a container with no writable-layer changes has none, and the engine's change kinds are mapped", async () => {
    expect(await runtime().containerDiff("pristine")).toEqual([]);
    expect(await runtime().containerDiff("edited")).toEqual([
      { path: "/tmp", kind: "modified" },
      { path: "/tmp/mb-diff", kind: "added" },
      { path: "/var/cache/old", kind: "deleted" },
    ]);
    expect(await rejectionOf(runtime().containerDiff("gone"))).toMatchObject({ kind: "not_found" });
  });

  test("an empty or JSON null diff means no changes, and any other body is an engine error", async () => {
    expect(await runtime().containerDiff("empty")).toEqual([]);
    for (const id of ["object", "text", "zero"]) {
      expect(await rejectionOf(runtime().containerDiff(id))).toMatchObject({
        kind: "engine",
        detail: expect.stringContaining("unexpected response from docker diff"),
      });
    }
  });

  test("a volume that is in use is a conflict, and a missing volume is not_found", async () => {
    expect(await rejectionOf(runtime().removeVolume("busy"))).toMatchObject({ kind: "conflict" });
    expect(await rejectionOf(runtime().inspectVolume("absent"))).toMatchObject({ kind: "not_found" });
  });

  test("starting a running container and stopping a stopped one succeed, and stop sends the timeout", async () => {
    recorded.length = 0;
    await runtime().startContainer("already");
    await runtime().stopContainer("already", { timeoutSec: 12 });
    expect(recorded.map((r) => [r.method, r.path])).toEqual([
      ["POST", "/containers/already/start"],
      ["POST", "/containers/already/stop"],
    ]);
    expect(recorded[1]?.search).toBe("?t=12");
  });

  test("an aborted build rejects with AbortError, and the engine sees its connection close", async () => {
    const context = mkdtempSync(join(dir, "context-"));
    writeFileSync(join(context, "Dockerfile"), "FROM scratch\n");
    const closes = buildCloses;
    const controller = new AbortController();
    let lines = 0;
    const build = runtime().buildImage({
      contextDir: context,
      dockerfile: "Dockerfile",
      tag: "minibox-test:aborted",
      labels: {},
      onLog: () => {
        lines += 1;
        if (lines === 2) controller.abort();
      },
      signal: controller.signal,
    });

    const error = await rejectionOf(build);

    expect((error as Error).name).toBe("AbortError");
    const closedSince = () => buildCloses > closes;
    for (let i = 0; i < 400 && !closedSince(); i++) await Bun.sleep(5);
    expect(closedSince()).toBe(true);
  });
});

const inspects = (id: string) =>
  recorded.filter((r) => r.method === "GET" && r.path === `/containers/${id}/json`).length;

/** Lists "ok", applies one change through the adapter, lists again, and counts the inspects the second list made. */
async function inspectsAfterChange(change: (adapter: Runtime) => Promise<unknown>): Promise<number> {
  listed = ["ok"];
  const adapter = createDockerRuntime(socket);
  await adapter.listContainers({ labels: {} });
  const before = inspects("ok");
  await change(adapter);
  await adapter.listContainers({ labels: {} });
  return inspects("ok") - before;
}

describe("Docker adapter list inspect cache", () => {
  test("a second list reuses the inspect of a container whose state did not change", async () => {
    listed = ["ok"];
    const adapter = createDockerRuntime(socket);
    await adapter.listContainers({ labels: {} });
    const before = inspects("ok");
    expect((await adapter.listContainers({ labels: {} })).map((c) => c.id)).toEqual(["ok"]);
    expect(inspects("ok")).toBe(before);
  });

  test("a container whose listed state changed is inspected again, and the others are not", async () => {
    listed = ["ok", "fresh"];
    listStates = { ok: "running", fresh: "created" };
    const adapter = createDockerRuntime(socket);
    await adapter.listContainers({ labels: {} });
    const [okBefore, freshBefore] = [inspects("ok"), inspects("fresh")];
    await adapter.listContainers({ labels: {} });
    expect([inspects("ok"), inspects("fresh")]).toEqual([okBefore, freshBefore]);

    listStates = { ok: "exited", fresh: "created" };
    await adapter.listContainers({ labels: {} });
    expect(inspects("ok")).toBe(okBefore + 1);
    expect(inspects("fresh")).toBe(freshBefore);
    listStates = {};
  });

  test("an update, rename or restart through the adapter makes the next list inspect again", async () => {
    expect(await inspectsAfterChange((adapter) => adapter.updateContainer("ok", { cpus: 2 }))).toBe(1);
    expect(await inspectsAfterChange((adapter) => adapter.renameContainer("ok", "alpha-2"))).toBe(1);
    expect(await inspectsAfterChange((adapter) => adapter.restartContainer("ok", { timeoutSec: 1 }))).toBe(1);
  });

  test("a container that leaves the list is inspected again when it returns", async () => {
    listed = ["ok"];
    const adapter = createDockerRuntime(socket);
    await adapter.listContainers({ labels: {} });
    const before = inspects("ok");
    listed = [];
    await adapter.listContainers({ labels: {} });
    listed = ["ok"];
    await adapter.listContainers({ labels: {} });
    expect(inspects("ok")).toBe(before + 1);
  });

  test("an inspect still in flight when the container changes is not cached", async () => {
    listed = ["ok"];
    const adapter = createDockerRuntime(socket);
    const before = inspects("ok");
    let release!: () => void;
    inspectGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const firstList = adapter.listContainers({ labels: {} });
      for (let i = 0; i < 400 && inspects("ok") === before; i++) await Bun.sleep(5);
      expect(inspects("ok")).toBeGreaterThan(before);
      await adapter.updateContainer("ok", { cpus: 2 });
      inspectGate = null;
      release();
      await firstList;
    } finally {
      inspectGate = null;
      release();
    }

    const afterFirst = inspects("ok");
    await adapter.listContainers({ labels: {} });
    expect(inspects("ok")).toBe(afterFirst + 1);
  });

  test("a cached inspect expires after 30 seconds even when the state never changes", async () => {
    listed = ["ok"];
    const adapter = createDockerRuntime(socket);
    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(1_000_000);
      await adapter.listContainers({ labels: {} });
      const before = inspects("ok");
      clock.mockReturnValue(1_000_000 + 29_999);
      await adapter.listContainers({ labels: {} });
      expect(inspects("ok")).toBe(before);
      clock.mockReturnValue(1_000_000 + 30_000);
      await adapter.listContainers({ labels: {} });
      expect(inspects("ok")).toBe(before + 1);
    } finally {
      clock.mockRestore();
    }
  });
});
