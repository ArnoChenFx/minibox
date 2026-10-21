import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Server } from "bun";

import { createDockerRuntime } from "../src/docker/runtime";
import { isAbortError } from "../src/lib/abort";
import type { Runtime } from "../src/runtime";
import { rejectionOf } from "./support/app";
import { archive, entry, paxEntry } from "./support/tar";

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
/** Bodies of the container creates the adapter sent. */
const createBodies: Record<string, unknown>[] = [];

/** Each request as `METHOD path`, with a wait's condition after it, so the order of a helper's calls can be checked. */
const trailOf = (requests: Recorded[]): string[] =>
  requests.map((r) => {
    const condition = new URLSearchParams(r.search).get("condition");
    return condition ? `${r.method} ${r.path} ${condition}` : `${r.method} ${r.path}`;
  });

/** The archive the engine sends for a container's path, keyed by container id. */
const ARCHIVES: Record<string, Buffer> = {
  "tar-owned": archive(entry({ name: "workspace/", type: "5", uid: 1000, gid: 1000 })),
  "tar-pax": archive(paxEntry({ uid: "3000000", gid: "3000001" }), entry({ name: "workspace/", type: "5" })),
  "tar-garbage": Buffer.alloc(512, "z"),
  "tar-empty": Buffer.alloc(1024),
};

/** The output of a helper that exits non-zero, in the multiplexed framing the engine uses for a non-TTY log. */
const helperLog = (text: string): Buffer => {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = 2;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

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
  NetworkSettings: { Networks: { "minibox-boxes": { IPAddress: "172.18.0.2" } } },
};

const NEVER_STARTED = {
  Id: "fresh",
  Name: "/fresh",
  Created: "2026-10-20T10:00:00Z",
  Config: { Image: "minibox-template:base", Labels: {} },
  State: { Status: "created", Running: false, StartedAt: "0001-01-01T00:00:00Z" },
  HostConfig: { NanoCpus: 0, Memory: 0, NetworkMode: "default" },
  NetworkSettings: { Networks: {} },
};

/** When set, inspects of "ok" wait for it, so a test can change the container while an inspect is in flight. */
let inspectGate: Promise<void> | null = null;
/** When set, the container listing does not answer until the client gives up on it. */
let listHung = false;
/** Requests the engine held and then saw the client abandon. */
let abandoned = 0;

const inspectable: Record<string, { status: number; body: unknown }> = {
  ok: { status: 200, body: RUNNING },
  fresh: { status: 200, body: NEVER_STARTED },
  gone: { status: 404, body: { message: "No such container: gone" } },
  broken: { status: 500, body: { message: "engine exploded" } },
};

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** A one-shot stats payload: 20% of two CPUs, and 10% of a 1000-byte limit. */
const ONE_SHOT_STATS = {
  cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 2 },
  precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
  memory_stats: { usage: 100, limit: 1000 },
};

/** Holds a request the way an engine that never answers does, until the client gives up on it. */
async function hang(req: Request): Promise<Response> {
  await new Promise<void>((resolve) =>
    req.signal.addEventListener(
      "abort",
      () => {
        abandoned += 1;
        resolve();
      },
      { once: true },
    ),
  );
  return new Response(null, { status: 499 });
}

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

/** Two events for "ok", one JSON object per line as the engine streams them, and then the stream ends. */
function eventsStream(): Response {
  const events = [
    { Type: "container", Action: "start", Actor: { ID: "ok", Attributes: { name: "alpha" } }, time: 1_700_000_000 },
    { Type: "container", Action: "die", Actor: { ID: "ok", Attributes: { name: "alpha" } }, time: 1_700_000_001 },
  ];
  return new Response(events.map((event) => `${JSON.stringify(event)}\n`).join(""));
}

async function engine(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/v[\d.]+(?=\/)/, "");
  recorded.push({ method: req.method, path, search: url.search });

  if (req.method === "GET" && path === "/_ping") return new Response("OK");
  if (req.method === "GET" && path === "/containers/json") {
    if (listHung) return hang(req);
    return json(listed.map((id) => ({ Id: id, Names: [`/${id}`], Labels: {}, State: listStates[id] ?? "running" })));
  }
  if (req.method === "GET" && path === "/events") return eventsStream();
  const inspect = /^\/containers\/([^/]+)\/json$/.exec(path);
  if (req.method === "GET" && inspect) {
    if (inspect[1] === "hung") return hang(req);
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
  const stats = /^\/containers\/([^/]+)\/stats$/.exec(path);
  if (req.method === "GET" && stats) {
    if (stats[1] === "ok") return json(ONE_SHOT_STATS);
    if (stats[1] === "hung") return hang(req);
  }
  if (req.method === "POST" && path === "/build") return slowBuild(req);
  if (req.method === "POST" && path === "/containers/create") {
    if (url.searchParams.get("name") === "taken") {
      return json({ message: 'Conflict. The container name "/taken" is already in use' }, 409);
    }
    const body = (await req.json()) as { Image?: string };
    createBodies.push(body);
    if (body.Image === "missing:latest") return json({ message: "No such image: missing:latest" }, 404);
    if (body.Image === "helper:ok") return json({ Id: "helper-ok" }, 201);
    if (body.Image === "helper:fail") return json({ Id: "helper-fail" }, 201);
    if (body.Image === "helper:refused") return json({ Id: "helper-refused" }, 201);
    return json({ Id: "new" }, 201);
  }
  const lifecycle = /^\/containers\/([^/]+)\/(start|stop)$/.exec(path);
  if (req.method === "POST" && lifecycle) {
    if (lifecycle[1] === "helper-refused" && lifecycle[2] === "start") {
      return json({ message: 'exec: "chown": executable file not found in $PATH' }, 400);
    }
    return new Response(null, { status: lifecycle[1] === "already" ? 304 : 204 });
  }
  const waited = /^\/containers\/([^/]+)\/wait$/.exec(path);
  if (req.method === "POST" && waited) {
    return json({ StatusCode: waited[1] === "helper-fail" ? 1 : 0 });
  }
  const archiveOf = /^\/containers\/([^/]+)\/archive$/.exec(path);
  if (req.method === "GET" && archiveOf) {
    const id = archiveOf[1] ?? "";
    if (id === "tar-missing") return json({ message: "Could not find the requested path" }, 404);
    const body = ARCHIVES[id];
    return body ? new Response(body) : json({ message: `No such container: ${id}` }, 404);
  }
  const attachTo = /^\/containers\/([^/]+)\/attach$/.exec(path);
  if (req.method === "POST" && attachTo) {
    return new Response(attachTo[1] === "helper-fail" ? helperLog("chown: boom\n") : null);
  }
  const removal = /^\/containers\/([^/]+)$/.exec(path);
  if (req.method === "DELETE" && removal) return new Response(null, { status: 204 });
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
      ipAddress: "172.18.0.2",
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
      ipAddress: null,
    });
  });

  test("a stats sample is read once from the engine, and a call whose signal aborts is cancelled", async () => {
    expect(await runtime().containerStats("ok")).toEqual({
      cpuPercent: 20,
      memUsage: 100,
      memLimit: 1000,
      memPercent: 10,
    });
    expect(recorded.at(-1)).toMatchObject({ path: "/containers/ok/stats", search: "?stream=false" });

    const error = await rejectionOf(runtime().containerStats("hung", { signal: AbortSignal.timeout(50) }));
    expect(isAbortError(error)).toBe(true);
  });

  test("an inspect or a listing gives up when its signal aborts, and the engine sees the request close", async () => {
    const before = abandoned;
    const inspect = await rejectionOf(runtime().inspectContainer("hung", { signal: AbortSignal.timeout(50) }));
    expect(isAbortError(inspect)).toBe(true);

    listed = ["ok", "hung"];
    const listingInspect = await rejectionOf(
      runtime().listContainers({ labels: {} }, { signal: AbortSignal.timeout(50) }),
    );
    expect(isAbortError(listingInspect)).toBe(true);

    listed = ["ok"];
    listHung = true;
    try {
      const listing = await rejectionOf(runtime().listContainers({ labels: {} }, { signal: AbortSignal.timeout(50) }));
      expect(isAbortError(listing)).toBe(true);
    } finally {
      listHung = false;
    }

    const abandonedThree = () => abandoned - before >= 3;
    for (let i = 0; i < 400 && !abandonedThree(); i++) await Bun.sleep(5);
    expect(abandoned - before).toBeGreaterThanOrEqual(3);
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

  test("events send the filters and since to the engine, and yield each event it streams", async () => {
    const before = recorded.length;
    const seen: string[] = [];
    const events = runtime().events({ labels: { minibox: "true" }, types: ["container"], since: 1_700_000_000 });
    for await (const event of events) seen.push(`${event.action} ${event.id} ${event.time}`);

    const request = recorded.slice(before).find((r) => r.path === "/events");
    const query = new URLSearchParams(request?.search);
    expect(query.get("since")).toBe("1700000000");
    expect(JSON.parse(query.get("filters") ?? "null")).toEqual({ label: ["minibox=true"], type: ["container"] });
    expect(seen).toEqual(["start ok 2023-11-14T22:13:20.000Z", "die ok 2023-11-14T22:13:21.000Z"]);
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

describe("Docker adapter volume root owner", () => {
  test("the owner is read from the first entry of the archive, and PAX ids take precedence over ustar", async () => {
    expect(await runtime().volumeRootOwner("tar-owned", "/workspace")).toEqual({ uid: 1000, gid: 1000 });
    expect(await runtime().volumeRootOwner("tar-pax", "/workspace")).toEqual({ uid: 3000000, gid: 3000001 });
    const request = recorded.at(-1);
    expect(request).toMatchObject({ method: "GET", path: "/containers/tar-pax/archive" });
    expect(new URLSearchParams(request?.search).get("path")).toBe("/workspace");
  });

  test("a path the engine does not have is not_found, and bytes that are not a tar are an engine error", async () => {
    expect(await rejectionOf(runtime().volumeRootOwner("tar-missing", "/nope"))).toMatchObject({ kind: "not_found" });
    expect(await rejectionOf(runtime().volumeRootOwner("tar-garbage", "/workspace"))).toMatchObject({
      kind: "engine",
      detail: expect.stringContaining("could not read the owner of /workspace"),
    });
    expect(await rejectionOf(runtime().volumeRootOwner("tar-empty", "/workspace"))).toMatchObject({ kind: "engine" });
  });

  test("setting the owner runs a helper that can only chown the volume root, and the engine removes it", async () => {
    recorded.length = 0;
    createBodies.length = 0;
    await runtime().setVolumeRootOwner("mbx-alpha-workspace", { uid: 1000, gid: 1000 }, "helper:ok");

    expect(createBodies).toMatchObject([
      {
        Image: "helper:ok",
        Cmd: ["chown", "1000:1000", "/minibox-volume"],
        User: "0:0",
        HostConfig: {
          Mounts: [
            {
              Type: "volume",
              Source: "mbx-alpha-workspace",
              Target: "/minibox-volume",
              ReadOnly: false,
              VolumeOptions: { NoCopy: true },
            },
          ],
          CapDrop: ["ALL"],
          CapAdd: ["CHOWN"],
          SecurityOpt: ["no-new-privileges:true"],
          NetworkMode: "none",
          ReadonlyRootfs: true,
          AutoRemove: true,
        },
      },
    ]);
    expect(trailOf(recorded)).toEqual([
      "GET /volumes/mbx-alpha-workspace",
      "POST /containers/create",
      "POST /containers/helper-ok/attach",
      "POST /containers/helper-ok/wait next-exit",
      "POST /containers/helper-ok/start",
      "POST /containers/helper-ok/wait removed",
    ]);
  });

  test("a helper whose chown fails reports what it printed, and waits for the engine to remove it", async () => {
    recorded.length = 0;
    expect(
      await rejectionOf(runtime().setVolumeRootOwner("mbx-alpha-workspace", { uid: 1000, gid: 1000 }, "helper:fail")),
    ).toMatchObject({ kind: "engine", detail: "chown of mbx-alpha-workspace exited with status 1: chown: boom" });
    expect(trailOf(recorded).at(-1)).toBe("POST /containers/helper-fail/wait removed");
  });

  test("a helper the engine refuses to start is an engine error, not a bad request, and it is removed", async () => {
    recorded.length = 0;
    expect(
      await rejectionOf(
        runtime().setVolumeRootOwner("mbx-alpha-workspace", { uid: 1000, gid: 1000 }, "helper:refused"),
      ),
    ).toMatchObject({ kind: "engine", detail: 'exec: "chown": executable file not found in $PATH' });
    expect(recorded.at(-1)).toMatchObject({ method: "DELETE", path: "/containers/helper-refused" });
  });

  test("a volume that does not exist is not_found, and no helper is created", async () => {
    recorded.length = 0;
    expect(
      await rejectionOf(runtime().setVolumeRootOwner("absent", { uid: 1000, gid: 1000 }, "helper:ok")),
    ).toMatchObject({ kind: "not_found" });
    expect(recorded.some((r) => r.method === "POST" && r.path === "/containers/create")).toBe(false);
  });

  test("a helper image the engine does not have is an engine error, not a missing volume", async () => {
    expect(
      await rejectionOf(
        runtime().setVolumeRootOwner("mbx-alpha-workspace", { uid: 1000, gid: 1000 }, "missing:latest"),
      ),
    ).toMatchObject({ kind: "engine", detail: "No such image: missing:latest" });
  });
});
