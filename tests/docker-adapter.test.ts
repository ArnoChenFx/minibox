import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Server } from "bun";

import { createDockerRuntime } from "../src/docker/runtime";
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
const recorded: Recorded[] = [];

const RUNNING = {
  Id: "ok",
  Name: "/alpha",
  Created: "2026-10-20T10:00:00Z",
  Config: { Image: "minibox-template:base", Labels: { minibox: "true", "minibox.name": "alpha" } },
  State: { Status: "running", Running: true, StartedAt: "2026-10-20T10:01:00Z" },
  HostConfig: { NanoCpus: 1_500_000_000, Memory: 512 * 1024 * 1024, NetworkMode: "minibox-boxes" },
};

const NEVER_STARTED = {
  Id: "fresh",
  Name: "/fresh",
  Created: "2026-10-20T10:00:00Z",
  Config: { Image: "minibox-template:base", Labels: {} },
  State: { Status: "created", Running: false, StartedAt: "0001-01-01T00:00:00Z" },
  HostConfig: { NanoCpus: 0, Memory: 0, NetworkMode: "default" },
};

const inspectable: Record<string, { status: number; body: unknown }> = {
  ok: { status: 200, body: RUNNING },
  fresh: { status: 200, body: NEVER_STARTED },
  gone: { status: 404, body: { message: "No such container: gone" } },
  broken: { status: 500, body: { message: "engine exploded" } },
};

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function engine(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/v[\d.]+(?=\/)/, "");
  recorded.push({ method: req.method, path, search: url.search });

  if (req.method === "GET" && path === "/_ping") return new Response("OK");
  if (req.method === "GET" && path === "/containers/json") {
    return json(listed.map((id) => ({ Id: id, Names: [`/${id}`], Labels: {} })));
  }
  const inspect = /^\/containers\/([^/]+)\/json$/.exec(path);
  if (req.method === "GET" && inspect) {
    const entry = inspectable[inspect[1] ?? ""] ?? { status: 404, body: { message: "No such container" } };
    return json(entry.body, entry.status);
  }
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

  test("inspect maps limits and reports a container that never started without a start time", async () => {
    expect(await runtime().inspectContainer("ok")).toEqual({
      id: "ok",
      name: "alpha",
      image: "minibox-template:base",
      labels: { minibox: "true", "minibox.name": "alpha" },
      created: "2026-10-20T10:00:00Z",
      state: "running",
      running: true,
      startedAt: "2026-10-20T10:01:00Z",
      cpus: 1.5,
      memoryBytes: 512 * 1024 * 1024,
      network: "minibox-boxes",
    });
    expect(await runtime().inspectContainer("fresh")).toMatchObject({
      state: "created",
      running: false,
      startedAt: null,
      cpus: null,
      memoryBytes: null,
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
});
