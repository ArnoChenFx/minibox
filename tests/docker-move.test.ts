/**
 * Moving a box to a second host against a real Docker engine. The second host is reached over SSH through the in-process
 * server in tests/support/engines.ts, which forwards the Docker socket to this engine. Both hosts therefore share one
 * engine. The box's own container name is still taken there, so the move takes a suffixed name, and the template is
 * already present. To see the image cross as an archive, the second host is shown without the template until an archive
 * is loaded, which runs the real `docker save` and `docker load` pair.
 *
 * The checkpoint path runs restic in helper containers, so it needs the restic image pulled on both hosts and the
 * base template, which a fork and a restore use to set a volume's owner. Both hosts share one engine here, so the
 * source's volumes still exist while the target restores its own copies of them.
 *
 *   bun run test:docker
 *
 * That script (scripts/docker-integration.ts) picks the label prefix and sweeps what the run left behind. To run this
 * file directly: MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbit<id> bun test tests/docker-move.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import type { Server } from "bun";
import Docker from "dockerode";

import { type App, createApp } from "../src/app";
import { createDockerRuntime } from "../src/docker/runtime";
import { labelKeys } from "../src/labels";
import { type Runtime, RuntimeError } from "../src/runtime";
import { startServer } from "../src/server";
import type { SocketData } from "../src/ws/socket";
import { TEST_KEY, testConfig } from "./support/app";
import { type FakeSshHost, type KeyPair, newKeyPair, startSshHost } from "./support/engines";
import { finishedTask } from "./support/tokens";

const enabled = process.env.MINIBOX_TEST_DOCKER === "1";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const PREFIX_PATTERN = /^mbit[a-z0-9-]{3,40}$/;
const prefix = process.env.MINIBOX_TEST_PREFIX ?? `mbit${Date.now().toString(36)}`;
if (enabled && !PREFIX_PATTERN.test(prefix)) throw new Error(`MINIBOX_TEST_PREFIX must match ${PREFIX_PATTERN}`);
const IMAGE = process.env.MINIBOX_TEST_IMAGE ?? "alpine:3.20";
const LONG = 120_000;
const TOOLS_PATH = "/opt/minibox/tools";
const keys = labelKeys(prefix);
const runtime: Runtime = createDockerRuntime(SOCKET);
const docker = new Docker({ socketPath: SOCKET });

/** While `hideTemplate` is set, the second host reports the template as absent, so a move sends it as an archive. */
const second = { hideTemplate: false, loads: 0 };

function secondHostRuntime(inner: Runtime): Runtime {
  return {
    ...inner,
    async inspectImage(ref) {
      if (second.hideTemplate && ref === IMAGE) throw new RuntimeError("not_found", `No such image: ${ref}`);
      return inner.inspectImage(ref);
    },
    async loadImage(archive: Readable) {
      await inner.loadImage(archive);
      second.hideTemplate = false;
      second.loads += 1;
    },
  };
}

let app: App;
let server: Server<SocketData>;
let base: string;
let client: KeyPair;
let sshHost: FakeSshHost;

interface ErrorBody {
  code: string;
  key?: string;
  details?: { preview?: MovePreview };
}

interface MovePreview {
  via?: string;
  from: string;
  to: string;
  starts: boolean;
  image: { ref: string; transfer: boolean };
  volumes: { path: string; action: string }[];
}

interface BoxJson {
  id: string;
  boxId: string;
  name: string;
  hostId?: string;
  running: boolean;
  revision: number;
  containerName: string;
  desired: string;
  mounts: { path: string; volumeId: string | null; volumeName: string | null }[];
}

interface VolumeJson {
  id: string;
  hostId: string;
  engineName: string;
}

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TEST_KEY}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });

async function errorOf(res: Response): Promise<ErrorBody> {
  return ((await res.json()) as { error: ErrorBody }).error;
}

async function viewOf(id: string): Promise<BoxJson> {
  return ((await (await api(`/api/boxes/${id}`)).json()) as { box: BoxJson }).box;
}

/** The engine's containers that carry this box's id label, on the one engine both hosts use. */
function containersOf(id: string) {
  return docker.listContainers({ all: true, filters: { label: [`${keys.id}=${id}`] } });
}

async function createBox(name: string): Promise<BoxJson> {
  const res = await post("/api/boxes", { name, template: IMAGE, cpus: 0.5, memoryMb: 128 });
  expect(res.status).toBe(201);
  return ((await res.json()) as { box: BoxJson }).box;
}

function moveRequest(id: string, revision: number, body: Record<string, unknown>): Promise<Response> {
  return api(`/api/boxes/${id}/move`, {
    method: "POST",
    headers: { "if-match": String(revision) },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  if (!enabled) return;
  client = newKeyPair();
  sshHost = await startSshHost(client, SOCKET);
  const cfg = testConfig({
    labelPrefix: prefix,
    dockerSocket: SOCKET,
    baseTemplateTag: `${prefix}-template:base`,
    dataDir: mkdtempSync(join(tmpdir(), "minibox-move-test-")),
  });
  app = createApp(cfg, "0.0.0-test", {
    runtime,
    connect: (target) => secondHostRuntime(createDockerRuntime(target)),
    eventsPath: ":memory:",
  });
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
  const added = await post("/api/hosts", {
    id: "lab",
    name: "Lab",
    endpoint: `ssh://minibox@127.0.0.1:${sshHost.port}${SOCKET}`,
    privateKey: client.privateKey,
    hostKeyFingerprint: sshHost.fingerprint,
  });
  expect(added.status).toBe(201);
}, 60_000);

afterAll(async () => {
  if (!enabled) return;
  app?.hostAdmin.close();
  app?.sessions.stop();
  app?.tokens.stop();
  app?.events.close();
  server?.stop(true);
  await sshHost?.close();
  for (const c of await runtime.listContainers({ labels: { [prefix]: "true" } })) {
    await runtime.removeContainer(c.id, { force: true }).catch(() => {});
  }
}, LONG);

describe.skipIf(!enabled)("moving a box to a second host, against a real engine", () => {
  test(
    "a box moves with its files and its volumes, runs on the second host, and its old volumes are removed",
    async () => {
      const box = await createBox("mover");
      expect(box).toMatchObject({ hostId: "local", running: true });
      const rebuilt = await api(`/api/boxes/${box.boxId}/rebuild`, {
        method: "POST",
        headers: { "if-match": String(box.revision) },
        body: JSON.stringify({ profile: "relaxed", confirm: true }),
      });
      expect(rebuilt.status).toBe(200);
      expect(
        (
          await post(`/api/boxes/${box.boxId}/exec`, {
            cmd: "echo kept > /workspace/notes.txt",
            user: "root",
            cwd: "/",
          })
        ).status,
      ).toBe(200);

      const before = await viewOf(box.boxId);
      expect(before.containerName).toBe(`${prefix}-${box.boxId}`);
      const copied = before.mounts.filter((mount) => mount.volumeId !== null && mount.path !== TOOLS_PATH);
      const oldEngineNames = await Promise.all(
        copied.map(async (mount) => {
          const found = (await (await api(`/api/volumes/${mount.volumeId}`)).json()) as { volume: VolumeJson };
          return found.volume.engineName;
        }),
      );
      expect(oldEngineNames).toHaveLength(3);

      const preview = await moveRequest(box.boxId, before.revision, { host: "lab" });
      expect(preview.status).toBe(409);
      const previewed = (await errorOf(preview)).details?.preview;
      expect(previewed).toMatchObject({ from: "local", to: "lab", starts: true, image: { transfer: false } });
      expect(previewed?.volumes.map((volume) => volume.action).toSorted()).toEqual(
        ["copy", "copy", "copy", "tools"].toSorted(),
      );
      expect(await containersOf(box.boxId)).toHaveLength(1);
      expect((await viewOf(box.boxId)).hostId).toBe("local");

      const started = await moveRequest(box.boxId, before.revision, { host: "lab", confirm: true });
      expect(started.status).toBe(202);
      const done = await finishedTask(base, ((await started.json()) as { taskId: string }).taskId);
      expect(done).toMatchObject({ status: "succeeded", result: { from: "local", to: "lab", leftovers: [] } });

      const after = await viewOf(box.boxId);
      expect(after).toMatchObject({ hostId: "lab", running: true, revision: before.revision + 1 });
      expect(after.containerName).toMatch(new RegExp(`^${prefix}-${box.boxId}-[0-9a-f]{6}$`));
      const containers = await containersOf(box.boxId);
      expect(containers.map((container) => [container.State, container.Names])).toEqual([
        ["running", [`/${after.containerName}`]],
      ]);

      const cat = await post(`/api/boxes/${box.boxId}/exec`, {
        cmd: "cat /workspace/notes.txt",
        user: "root",
        cwd: "/",
      });
      expect(await cat.json()).toMatchObject({ exitCode: 0, stdout: "kept\n" });

      const volumes = ((await (await api("/api/volumes")).json()) as { volumes: VolumeJson[] }).volumes;
      for (const engineName of oldEngineNames) {
        expect(volumes.filter((volume) => volume.engineName === engineName)).toEqual([]);
        await expect(runtime.inspectVolume(engineName)).rejects.toMatchObject({ kind: "not_found" });
      }
    },
    LONG,
  );

  test(
    "the template crosses as an archive when the second host does not hold it",
    async () => {
      const box = await createBox("archived");
      const before = await viewOf(box.boxId);
      const loadsBefore = second.loads;
      second.hideTemplate = true;

      const preview = await moveRequest(box.boxId, before.revision, { host: "lab" });
      expect(preview.status).toBe(409);
      expect((await errorOf(preview)).details?.preview?.image).toEqual({ ref: IMAGE, transfer: true });

      const started = await moveRequest(box.boxId, before.revision, { host: "lab", confirm: true });
      expect(started.status).toBe(202);
      const done = await finishedTask(base, ((await started.json()) as { taskId: string }).taskId);
      expect(done.status).toBe("succeeded");
      expect(second.loads).toBe(loadsBefore + 1);
      expect((await viewOf(box.boxId)).hostId).toBe("lab");
      expect((await containersOf(box.boxId)).map((container) => container.State)).toEqual(["running"]);
    },
    LONG,
  );

  test(
    "a checkpoint move carries the box's data through a checkpoint, restores it on the second host and leaves no checkpoint",
    async () => {
      const box = await createBox("carried");
      expect(
        (
          await post(`/api/boxes/${box.boxId}/exec`, {
            cmd: "echo carried > /workspace/notes.txt && mkdir -p /home/dev/kept && echo home > /home/dev/kept/f.txt",
            user: "root",
            cwd: "/",
          })
        ).status,
      ).toBe(200);
      const before = await viewOf(box.boxId);
      const copied = before.mounts.filter((mount) => mount.volumeId !== null && mount.path !== TOOLS_PATH);
      // Read while their records exist: once the move has removed the source volumes there is nothing left to ask.
      const oldEngineNames = await Promise.all(
        copied.map(async (mount) => {
          const found = (await (await api(`/api/volumes/${mount.volumeId}`)).json()) as { volume: VolumeJson };
          return found.volume.engineName;
        }),
      );
      expect(oldEngineNames).toHaveLength(3);

      const preview = await moveRequest(box.boxId, before.revision, { host: "lab", via: "checkpoint" });
      expect(preview.status).toBe(409);
      const previewed = (await errorOf(preview)).details?.preview;
      expect(previewed).toMatchObject({ via: "checkpoint", from: "local", to: "lab", starts: true });
      expect(previewed?.volumes.map((volume) => volume.action).toSorted()).toEqual(
        ["checkpoint", "checkpoint", "empty", "tools"].toSorted(),
      );
      expect((await viewOf(box.boxId)).hostId).toBe("local");

      const started = await moveRequest(box.boxId, before.revision, { host: "lab", via: "checkpoint", confirm: true });
      expect(started.status).toBe(202);
      const done = await finishedTask(base, ((await started.json()) as { taskId: string }).taskId);
      expect(done).toMatchObject({
        status: "succeeded",
        result: { from: "local", to: "lab", via: "checkpoint", checkpoints: 0, leftovers: [] },
      });

      const after = await viewOf(box.boxId);
      expect(after).toMatchObject({ hostId: "lab", running: true, revision: before.revision + 1 });
      expect((await containersOf(box.boxId)).map((container) => container.State)).toEqual(["running"]);

      // The data the checkpoint carried, read inside the box on its new host.
      const cat = await post(`/api/boxes/${box.boxId}/exec`, {
        cmd: "cat /workspace/notes.txt /home/dev/kept/f.txt",
        user: "root",
        cwd: "/",
      });
      expect(await cat.json()).toMatchObject({ exitCode: 0, stdout: "carried\nhome\n" });

      // The move's own checkpoints are removed on both hosts, so neither the source nor the target keeps one.
      const listed = ((await (await api("/api/checkpoints")).json()) as { checkpoints: { boxId: string | null }[] })
        .checkpoints;
      expect(listed.filter((checkpoint) => checkpoint.boxId === box.boxId)).toEqual([]);

      // The source's volumes went with the box.
      const volumes = ((await (await api("/api/volumes")).json()) as { volumes: VolumeJson[] }).volumes;
      for (const engineName of oldEngineNames) {
        expect(volumes.filter((volume) => volume.engineName === engineName)).toEqual([]);
        await expect(runtime.inspectVolume(engineName)).rejects.toMatchObject({ kind: "not_found" });
      }
    },
    LONG,
  );

  test(
    "a stopped box moves as a stopped box: its container is created on the second host and not started",
    async () => {
      const box = await createBox("sleeper");
      expect((await post(`/api/boxes/${box.boxId}/stop`, {})).status).toBe(200);
      const stopped = await viewOf(box.boxId);
      expect(stopped).toMatchObject({ running: false, desired: "stopped" });

      const started = await moveRequest(box.boxId, stopped.revision, { host: "lab", confirm: true });
      expect(started.status).toBe(202);
      const done = await finishedTask(base, ((await started.json()) as { taskId: string }).taskId);
      expect(done.status).toBe("succeeded");

      const moved = await viewOf(box.boxId);
      expect(moved).toMatchObject({ hostId: "lab", running: false, desired: "stopped" });
      expect((await containersOf(box.boxId)).map((container) => container.State)).toEqual(["created"]);
    },
    LONG,
  );
});
