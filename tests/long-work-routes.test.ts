import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Server } from "bun";

import type { App } from "../src/app";
import type { OperationContext } from "../src/operations/types";
import { routes } from "../src/routes";
import { matchRoute } from "../src/routes/router";
import { startServer } from "../src/server";
import { createTestApp, rejectionOf, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

/**
 * Bun closes a request that stays quiet past its idle cap, and bytes written do not reset it. Long work therefore
 * answers 202 and runs in the background, and only the two progress streams lift the cap, with
 * `server.timeout(req, 0)`. These tests check that MiniBox does exactly that, against a recording object in place of
 * Bun's server, since the cap itself is Bun's behaviour and not ours to test.
 */

const OWNER = { type: "owner" as const, id: "owner", name: "owner" };
const MISSING = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const auth = { authorization: `Bearer ${TEST_KEY}` };

interface Timeout {
  readonly req: Request;
  readonly seconds: number;
}

function recordingServer(): { server: Server<unknown>; timeouts: Timeout[] } {
  const timeouts: Timeout[] = [];
  const server = {
    timeout: (req: Request, seconds: number) => {
      timeouts.push({ req, seconds });
    },
  };
  return { server: server as unknown as Server<unknown>, timeouts };
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("the condition was not met in time");
    await Bun.sleep(5);
  }
}

async function statusOf(base: string, taskId: string): Promise<unknown> {
  const res = await fetch(`${base}/api/tasks/${taskId}`, { headers: auth });
  return ((await res.json()) as { status?: string }).status;
}

describe("long work", () => {
  let restoreLogs: () => void;
  let app: App;
  let runtime: FakeRuntime;
  let ctx: OperationContext;

  beforeEach(() => {
    restoreLogs = silenceLogs();
    ({ app, runtime } = createTestApp({ labelPrefix: "mbtest" }));
    ctx = { host: app.hosts.get(), principal: OWNER, source: "rest", events: app.events };
  });

  afterEach(() => restoreLogs());

  const serve = () => {
    const server = startServer(app);
    return {
      base: `http://127.0.0.1:${server.port}`,
      stop: () => {
        server.stop(true);
        app.throttle.stop();
      },
    };
  };

  /** Calls a route the way the server does, with a bearer caller, and returns the request it was given. */
  async function invoke(method: string, path: string, server: Server<unknown>) {
    const url = new URL(path, "http://127.0.0.1");
    const matched = matchRoute(routes, method, url.pathname);
    if (matched === null || matched === "method_not_allowed") throw new Error(`no route for ${method} ${path}`);
    const req = new Request(url.href, { method, headers: auth });
    const res = await matched.route.handler({
      app,
      host: app.hosts.get(),
      req,
      url,
      params: matched.params,
      server,
      caller: { sessionId: null },
    });
    return { req, res };
  }

  test("a template build answers 202 while the build is still running", async () => {
    const held = runtime.hold("buildImage");
    const server = serve();
    try {
      const res = await fetch(`${server.base}/api/templates/base/build`, { method: "POST", headers: auth });
      expect(res.status).toBe(202);
      const { taskId } = (await res.json()) as { taskId: string };
      await waitFor(() => runtime.callsTo("buildImage").length === 1);
      expect(await statusOf(server.base, taskId)).toBe("running");
    } finally {
      held.release();
      await app.tasks.drain();
      server.stop();
    }
  });

  test("a snapshot commit answers 202 while the commit is still running", async () => {
    const keys = app.hosts.get().keys;
    runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    const alpha = (await app.operations.run("box.create", ctx, { name: "alpha", cpus: 1, memoryMb: 256 })) as {
      box: { id: string };
    };
    const held = runtime.hold("commitContainer");
    const server = serve();
    try {
      const res = await fetch(`${server.base}/api/boxes/${alpha.box.id}/snapshots`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ name: "nightly" }),
      });
      expect(res.status).toBe(202);
      const { taskId } = (await res.json()) as { taskId: string };
      await waitFor(() => runtime.callsTo("commitContainer").length === 1);
      expect(await statusOf(server.base, taskId)).toBe("running");
    } finally {
      held.release();
      await app.tasks.drain();
      server.stop();
    }
  });

  test("the task progress stream lifts the idle cap for its own request once the task is found", async () => {
    const held = runtime.hold("buildImage");
    const { taskId } = (await app.operations.run("template.build", ctx, {})) as { taskId: string };
    const { server, timeouts } = recordingServer();
    try {
      const { req, res } = await invoke("GET", `/api/tasks/${taskId}/events`, server);
      expect(res.status).toBe(200);
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]?.req).toBe(req);
      expect(timeouts[0]?.seconds).toBe(0);
      await res.body?.cancel();
    } finally {
      held.release();
      await app.tasks.drain();
    }
  });

  test("the event stream lifts the idle cap for its own request", async () => {
    const { server, timeouts } = recordingServer();
    const { req, res } = await invoke("GET", "/api/events/stream", server);
    expect(res.status).toBe(200);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]?.req).toBe(req);
    expect(timeouts[0]?.seconds).toBe(0);
    await res.body?.cancel();
  });

  test("a progress stream refused for a missing task leaves the cap in place", async () => {
    const { server, timeouts } = recordingServer();
    const refused = await rejectionOf(invoke("GET", `/api/tasks/${MISSING}/events`, server));
    expect(refused).toMatchObject({ status: 404 });
    expect(timeouts).toEqual([]);
  });

  test("ordinary requests keep Bun's idle cap", async () => {
    const { server, timeouts } = recordingServer();
    const { res } = await invoke("GET", "/api/tasks", server);
    expect(res.status).toBe(200);
    expect(timeouts).toEqual([]);
  });
});
