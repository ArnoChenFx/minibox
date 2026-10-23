import type { Server } from "bun";

import { type App, createApp } from "../../src/app";
import type { Config } from "../../src/config";
import type { EngineTarget } from "../../src/runtime";
import { startServer } from "../../src/server";
import type { SocketData } from "../../src/ws/socket";
import { silenceLogs, TEST_KEY, testConfig } from "./app";
import { FakeRuntime } from "./fake-runtime";
import { FakeCheckpointEngine } from "./fake-snapshots";

export const GIB = 1024 ** 3;
export const MIB = 1024 ** 2;
export const SMALL_SOCKET = "/run/minibox-test/small-docker.sock";
export const LARGE_SOCKET = "/run/minibox-test/large-docker.sock";

export type HostName = "local" | "small" | "large";

export interface Cluster {
  readonly app: App;
  readonly base: string;
  /** The engine behind each host. Tests seed images and read calls from these. */
  readonly engines: Record<HostName, FakeRuntime>;
  api(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, body: unknown): Promise<Response>;
  close(): void;
}

export interface BoxRef {
  id: string;
  boxId: string;
  hostId?: string;
  revision: number;
}

export type ErrorBody = {
  code: string;
  key?: string;
  params?: Record<string, unknown>;
  details?: Record<string, unknown>;
};

export async function errorOf(res: Response): Promise<ErrorBody> {
  return ((await res.json()) as { error: ErrorBody }).error;
}

/** Creates a box with no mounts, so the test needs no volume, on the host named, or on the local host when undefined. */
export async function boxOn(
  cluster: Cluster,
  host: string | undefined,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<BoxRef> {
  const res = await cluster.post("/api/boxes", { name, cpus: 1, memoryMb: 256, host, mounts: [], ...extra });
  if (res.status !== 201) throw new Error(`create ${name} on ${host}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { box: BoxRef }).box;
}

/**
 * A cluster of the local host and two remote engines reached through unix sockets: `small` (2 CPUs, 4 GiB) and `large`
 * (8 CPUs, 16 GiB). The local host reports the real machine, so tests place boxes on the remote engines, whose capacity
 * is fixed. The template is seeded on the hosts named in `templates` only, so a test decides where `auto` may place a box.
 * Returns once both remote hosts are added and their samplers have listed their engines.
 */
export async function bootCluster(
  overrides: Partial<Config> = {},
  templates: HostName[] = ["local", "small", "large"],
): Promise<Cluster> {
  const restoreLogs = silenceLogs();
  const local = new FakeRuntime();
  const small = new FakeRuntime();
  small.engine = { cpus: 2, memoryBytes: 4 * GIB };
  const large = new FakeRuntime();
  large.engine = { cpus: 8, memoryBytes: 16 * GIB };
  const engines: Record<HostName, FakeRuntime> = { local, small, large };
  const app = createApp(testConfig({ labelPrefix: "mbtest", ...overrides }), "0.0.0-test", {
    runtime: local,
    connect: (target: EngineTarget) => ("socketPath" in target && target.socketPath === LARGE_SOCKET ? large : small),
    checkpointEngine: new FakeCheckpointEngine(),
    eventsPath: ":memory:",
  });
  for (const host of templates) {
    engines[host].seedImage(app.cfg.baseTemplateTag, {
      [app.hosts.get().keys.template]: "true",
      [app.hosts.get().keys.templateName]: "base",
    });
  }
  const server: Server<SocketData> = startServer(app);
  const base = `http://127.0.0.1:${server.port}`;
  const api = (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${TEST_KEY}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    return fetch(`${base}${path}`, { ...init, headers });
  };
  const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });
  for (const [id, socket] of [
    ["small", SMALL_SOCKET],
    ["large", LARGE_SOCKET],
  ] as const) {
    const res = await post("/api/hosts", { id, endpoint: `unix://${socket}` });
    if (res.status !== 201) throw new Error(`add host ${id}: ${res.status} ${await res.text()}`);
  }
  for (const host of ["small", "large"] as const) {
    await waitUntil(() => app.hosts.get(host).sampler.ready(), `the first listing of ${host}`);
  }
  return {
    app,
    base,
    engines,
    api,
    post,
    close() {
      app.hostAdmin.close();
      app.sessions.stop();
      app.tokens.stop();
      server.stop(true);
      restoreLogs();
    },
  };
}

async function waitUntil(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}
