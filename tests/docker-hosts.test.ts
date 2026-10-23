/**
 * A second host against a real Docker engine. The second host is reached over SSH: the in-process server in
 * tests/support/engines.ts stands in for sshd, so the test needs no SSH daemon, and forwards the Docker socket to the
 * real engine. Each request takes the tunnel a remote host takes. Boxes on both hosts are real containers.
 *
 *   bun run test:docker
 *
 * That script (scripts/docker-integration.ts) picks the label prefix and sweeps what the run left behind. To run this
 * file directly: MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbit<id> bun test tests/docker-hosts.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Server } from "bun";
import Docker from "dockerode";

import { type App, createApp } from "../src/app";
import { createDockerRuntime } from "../src/docker/runtime";
import { labelKeys } from "../src/labels";
import type { Runtime } from "../src/runtime";
import { startServer } from "../src/server";
import type { SocketData } from "../src/ws/socket";
import { rejectionOf, TEST_KEY, testConfig } from "./support/app";
import { type FakeSshHost, type KeyPair, newKeyPair, startSshHost } from "./support/engines";

const enabled = process.env.MINIBOX_TEST_DOCKER === "1";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const PREFIX_PATTERN = /^mbit[a-z0-9-]{3,40}$/;
const prefix = process.env.MINIBOX_TEST_PREFIX ?? `mbit${Date.now().toString(36)}`;
if (enabled && !PREFIX_PATTERN.test(prefix)) throw new Error(`MINIBOX_TEST_PREFIX must match ${PREFIX_PATTERN}`);
const IMAGE = process.env.MINIBOX_TEST_IMAGE ?? "alpine:3.20";
const LONG = 120_000;
const keys = labelKeys(prefix);
const runtime: Runtime = createDockerRuntime(SOCKET);
const docker = new Docker({ socketPath: SOCKET });

let app: App;
let server: Server<SocketData>;
let base: string;
let client: KeyPair;
let sshHost: FakeSshHost;

interface ErrorBody {
  code: string;
  key?: string;
  details?: Record<string, number>;
}

interface HostJson {
  id: string;
  transport: string;
  status: string;
  capacity: { cpus: number; memoryBytes: number } | null;
  dockerVersion: string | null;
  error: string | null;
  boxes: number;
}

interface BoxJson {
  id: string;
  name: string;
  state: string;
  running: boolean;
  hostId?: string;
  mounts: { volumeName: string | null }[];
}

interface VolumeJson {
  id: string;
  name: string;
  hostId: string;
  role: string | null;
  ownership: string;
  engineName: string;
}

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TEST_KEY}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });

async function waitForTask(taskId: string): Promise<string> {
  for (;;) {
    const view = (await (await api(`/api/tasks/${taskId}`)).json()) as { status: string };
    if (view.status !== "running") return view.status;
    await Bun.sleep(50);
  }
}

async function errorOf(res: Response): Promise<ErrorBody> {
  return ((await res.json()) as { error: ErrorBody }).error;
}

/** The engine's containers for a box of this run, found by the name label MiniBox writes at create. */
function containersNamed(name: string) {
  return docker.listContainers({
    all: true,
    filters: { label: [`${keys.box}=true`, `${keys.name}=${name}`] },
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
    dataDir: mkdtempSync(join(tmpdir(), "minibox-hosts-test-")),
  });
  app = createApp(cfg, "0.0.0-test", { runtime, eventsPath: ":memory:" });
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
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

describe.skipIf(!enabled)("a second host over SSH, against a real engine", () => {
  test("a host key that was not confirmed is refused with its fingerprint, and the host is not contacted", async () => {
    const res = await post("/api/hosts", {
      id: "lab",
      endpoint: `ssh://minibox@127.0.0.1:${sshHost.port}${SOCKET}`,
      privateKey: client.privateKey,
    });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({ code: "conflict", key: "host_key_unconfirmed" });
    expect(sshHost.authAttempts).toEqual([]);
  });

  test("with the confirmed fingerprint the host is online, reporting the real engine's version and capacity", async () => {
    const res = await post("/api/hosts", {
      id: "lab",
      name: "Lab",
      endpoint: `ssh://minibox@127.0.0.1:${sshHost.port}${SOCKET}`,
      privateKey: client.privateKey,
      hostKeyFingerprint: sshHost.fingerprint,
    });
    expect(res.status).toBe(201);
    const { host } = (await res.json()) as { host: HostJson };
    expect(host).toMatchObject({ id: "lab", transport: "ssh", status: "online", error: null });

    const info = await docker.info();
    const version = await docker.version();
    expect(host.dockerVersion).toBe(version.Version);
    expect(host.capacity).toEqual({ cpus: info.NCPU, memoryBytes: info.MemTotal });
    expect(sshHost.authAttempts.length).toBeGreaterThan(0);
    expect(new Set(sshHost.authAttempts)).toEqual(new Set(["minibox"]));
    expect(sshHost.forwards.length).toBeGreaterThan(0);
    expect(new Set(sshHost.forwards)).toEqual(new Set([SOCKET]));
  });

  test(
    "a box on the second host is a real container, and the local host runs one beside it",
    async () => {
      const lab = await post("/api/boxes", {
        name: "lab-box",
        template: IMAGE,
        cpus: 0.5,
        memoryMb: 128,
        mounts: [],
        host: "lab",
      });
      expect(lab.status).toBe(201);
      const { box: labBox } = (await lab.json()) as { box: BoxJson };
      expect(labBox).toMatchObject({ name: "lab-box", hostId: "lab", running: true });
      const labContainers = await containersNamed("lab-box");
      expect(labContainers).toHaveLength(1);
      expect(labContainers[0]?.State).toBe("running");

      const local = await post("/api/boxes", {
        name: "local-box",
        template: IMAGE,
        cpus: 0.5,
        memoryMb: 128,
        mounts: [],
      });
      expect(local.status).toBe(201);

      const listed = (await (await api("/api/boxes")).json()) as { boxes: BoxJson[] };
      expect(listed.boxes.find((box) => box.name === "lab-box")?.hostId).toBe("lab");
      expect(listed.boxes.find((box) => box.name === "local-box")?.hostId).toBe("local");
    },
    LONG,
  );

  test(
    "stop and start on the second host stop and start the container on the real engine",
    async () => {
      const { boxes } = (await (await api("/api/boxes")).json()) as { boxes: BoxJson[] };
      const id = boxes.find((box) => box.name === "lab-box")?.id ?? "";
      expect(id).not.toBe("");

      expect((await api(`/api/boxes/${id}/stop`, { method: "POST" })).status).toBe(200);
      expect((await containersNamed("lab-box"))[0]?.State).toBe("exited");

      expect((await api(`/api/boxes/${id}/start`, { method: "POST" })).status).toBe(200);
      expect((await containersNamed("lab-box"))[0]?.State).toBe("running");
    },
    LONG,
  );

  test(
    "a command on the second host runs through the tunnel and returns all of its output and its exit code",
    async () => {
      const { boxes } = (await (await api("/api/boxes")).json()) as { boxes: BoxJson[] };
      const id = boxes.find((box) => box.name === "lab-box")?.id ?? "";
      const res = await post(`/api/boxes/${id}/exec`, {
        cmd: "echo remote-$((40 + 2)); echo to-stderr >&2; exit 3",
        user: "root",
        cwd: "/",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ exitCode: 3, stdout: "remote-42\n", stderr: "to-stderr\n" });
    },
    LONG,
  );

  test(
    "deleting a box on the second host removes the volumes it owns, though the local host's cache sees the same engine",
    async () => {
      const made = await post("/api/boxes", {
        name: "lab-owned",
        template: IMAGE,
        cpus: 0.5,
        memoryMb: 128,
        host: "lab",
      });
      expect(made.status).toBe(201);
      const { box } = (await made.json()) as { box: BoxJson };
      const volumes = box.mounts.map((mount) => mount.volumeName ?? "");
      expect(volumes.length).toBeGreaterThan(0);

      const res = await api(`/api/boxes/${box.id}?deleteVolume=true`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        name: "lab-owned",
        volumeDeleted: true,
        trash: { id: expect.stringMatching(/^ck_/) },
      });
      expect(await containersNamed("lab-owned")).toHaveLength(0);
      for (const volume of volumes) {
        expect(await rejectionOf(runtime.inspectVolume(volume))).toMatchObject({ kind: "not_found" });
      }
    },
    LONG,
  );

  test(
    "the host stays while a box, a volume or a recycle bin entry on it exists, and goes once all are removed",
    async () => {
      const { hosts } = (await (await api("/api/hosts")).json()) as { hosts: HostJson[] };
      expect(hosts.find((host) => host.id === "lab")).toMatchObject({ status: "online", boxes: 1 });

      const refused = await api("/api/hosts/lab", { method: "DELETE" });
      expect(refused.status).toBe(409);
      expect(await errorOf(refused)).toMatchObject({
        code: "conflict",
        key: "host_in_use",
        details: { boxes: 1, volumes: 1, checkpoints: 1 },
      });

      const { boxes } = (await (await api("/api/boxes")).json()) as { boxes: BoxJson[] };
      const id = boxes.find((box) => box.name === "lab-box")?.id ?? "";
      expect((await api(`/api/boxes/${id}`, { method: "DELETE" })).status).toBe(200);
      expect(await containersNamed("lab-box")).toHaveLength(0);

      const stillHeld = await api("/api/hosts/lab", { method: "DELETE" });
      expect(stillHeld.status).toBe(409);
      expect(await errorOf(stillHeld)).toMatchObject({
        key: "host_in_use",
        details: { boxes: 0, volumes: 1, checkpoints: 2 },
      });

      const { trash } = (await (await api("/api/trash")).json()) as { trash: { id: string; hostId: string }[] };
      for (const entry of trash.filter((item) => item.hostId === "lab")) {
        const purge = await api(`/api/trash/${entry.id}`, { method: "DELETE" });
        expect(purge.status).toBe(202);
        expect(await waitForTask(((await purge.json()) as { taskId: string }).taskId)).toBe("succeeded");
      }

      const { volumes } = (await (await api("/api/volumes")).json()) as { volumes: VolumeJson[] };
      const onLab = volumes.filter((volume) => volume.hostId === "lab");
      expect(onLab).toMatchObject([{ role: "tools", ownership: "independent" }]);
      const [tools] = onLab;
      if (!tools) throw new Error("the host should still hold its shared tools volume");
      expect((await api(`/api/volumes/${tools.id}?confirm=true`, { method: "DELETE" })).status).toBe(200);
      expect(await rejectionOf(runtime.inspectVolume(tools.engineName))).toMatchObject({ kind: "not_found" });

      expect((await api("/api/hosts/lab", { method: "DELETE" })).status).toBe(200);
      const after = (await (await api("/api/hosts")).json()) as { hosts: HostJson[] };
      expect(after.hosts.map((host) => host.id)).toEqual(["local"]);
      expect(sshHost.forwards.every((path) => path === SOCKET)).toBe(true);
    },
    LONG,
  );
});
