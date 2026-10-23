import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import { RuntimeError, type HelperSpec } from "../src/runtime";
import { startServer } from "../src/server";
import { ensureBaseImage } from "../src/services/base-template";
import { createTestApp, rejectionOf, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

let app: App;
let runtime: FakeRuntime;
let host: HostCtx;
let server: ReturnType<typeof startServer> | undefined;
let base: string;
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  ({ app, runtime } = createTestApp({ labelPrefix: "mbtest" }));
  host = app.hosts.get();
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  server?.stop(true);
  server = undefined;
  app.throttle.stop();
  app.sessions.stop();
  app.events.close();
  restoreLogs();
});

const baseBuilds = () => runtime.builds.filter((build) => build.tag === app.cfg.baseTemplateTag);

async function hasImage(ref: string): Promise<boolean> {
  return runtime.inspectImage(ref).then(
    () => true,
    () => false,
  );
}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TEST_KEY}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function waitTask(id: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const view = (await call("GET", `/api/tasks/${id}`)).json;
    if (view.status !== "running" || Date.now() > deadline) return view;
    await Bun.sleep(5);
  }
}

async function createFromCustom(name: string, tools: string[]): Promise<string> {
  const created = await call("POST", "/api/boxes", {
    name,
    cpus: 1,
    memoryMb: 256,
    template: "mbtest-custom:1",
    tools,
  });
  expect(created.status).toBe(201);
  return String((created.json.box as { id: string }).id);
}

describe("ensureBaseImage", () => {
  test("a host without the base template builds it from templates/base, labelled as the base template", async () => {
    const logs: string[] = [];
    expect(await ensureBaseImage(host, { log: (text) => logs.push(text) })).toBe(app.cfg.baseTemplateTag);
    expect(baseBuilds()).toHaveLength(1);
    expect(baseBuilds()[0]?.files.has("Dockerfile")).toBe(true);
    const image = await runtime.inspectImage(app.cfg.baseTemplateTag);
    expect(image.labels).toMatchObject({ [host.keys.template]: "true", [host.keys.templateName]: "base" });
    expect(logs.join("")).toContain(`Base template ${app.cfg.baseTemplateTag} is missing`);
    expect(logs.join("")).toContain(runtime.buildLog);
  });

  test("a host that holds the base template builds nothing", async () => {
    runtime.seedImage(app.cfg.baseTemplateTag);
    expect(await ensureBaseImage(host)).toBe(app.cfg.baseTemplateTag);
    expect(baseBuilds()).toHaveLength(0);
  });

  test("callers that need it at the same time share one build, and each gets its log", async () => {
    const gate = runtime.hold("buildImage");
    const first: string[] = [];
    const second: string[] = [];
    const both = Promise.all([
      ensureBaseImage(host, { log: (text) => first.push(text) }),
      ensureBaseImage(host, { log: (text) => second.push(text) }),
      ensureBaseImage(host),
    ]);
    while (runtime.callsTo("buildImage").length === 0) await Bun.sleep(1);
    await Bun.sleep(5);
    gate.release();
    const tag = app.cfg.baseTemplateTag;
    expect(await both).toEqual([tag, tag, tag]);
    expect(baseBuilds()).toHaveLength(1);
    expect(first.join("")).toContain("is missing");
    expect(second.join("")).toContain("is missing");
  });

  test("a failed build is a clear error, and the next need tries again", async () => {
    runtime.fail("buildImage", new RuntimeError("engine", "pull access denied for node"));
    const error = await rejectionOf(ensureBaseImage(host));
    expect(error).toMatchObject({ status: 400, key: "helper_image_build_failed" });
    expect((error as Error).message).toContain("pull access denied for node");
    expect(await hasImage(app.cfg.baseTemplateTag)).toBe(false);

    expect(await ensureBaseImage(host)).toBe(app.cfg.baseTemplateTag);
    expect(await hasImage(app.cfg.baseTemplateTag)).toBe(true);
  });

  test("an agent host, which cannot build, keeps the missing-image error and starts no build", async () => {
    const agent = { ...host, host: { ...host.host, transport: "agent" } } as HostCtx;
    expect(await rejectionOf(ensureBaseImage(agent))).toMatchObject({ key: "helper_image_missing" });
    expect(runtime.callsTo("buildImage")).toHaveLength(0);
  });
});

describe("boxes on a host without the base template", () => {
  beforeEach(() => {
    const keys = host.keys;
    runtime.seedImage("mbtest-custom:1", { [keys.template]: "true", [keys.templateName]: "custom" });
    runtime.helperHandler = (
      (prior) => (spec: HelperSpec) =>
        spec.cmd.join(" ").includes("MBTOOL") ? { exitCode: 0, logs: "" } : prior(spec)
    )(runtime.helperHandler);
  });

  test("a tool install builds the base template, sharing the build a click on Build base template starts", async () => {
    const boxId = await createFromCustom("alpha", ["bun", "pi-agent"]);
    // The state the report came from: the base template is not there when the tools are installed.
    if (await hasImage(app.cfg.baseTemplateTag)) await runtime.removeImage(app.cfg.baseTemplateTag, { force: true });
    const before = baseBuilds().length;

    const gate = runtime.hold("buildImage");
    const reconcile = await call("POST", `/api/boxes/${boxId}/tools/reconcile`);
    while (runtime.callsTo("buildImage").length <= before) await Bun.sleep(1);
    const build = await call("POST", "/api/templates/base/build");
    expect([reconcile.status, build.status]).toEqual([202, 202]);
    await Bun.sleep(10);
    gate.release();
    const [installed, built] = await Promise.all([
      waitTask(String(reconcile.json.taskId)),
      waitTask(String(build.json.taskId)),
    ]);

    expect([installed.status, built.status]).toEqual(["succeeded", "succeeded"]);
    expect(installed.result).toMatchObject({ installed: ["bun", "pi-agent"], failed: [] });
    expect(baseBuilds().length - before).toBe(1);
    const writers = runtime
      .callsTo("runHelper")
      .map((entry) => entry.args[0] as HelperSpec)
      .filter((spec) => spec.network === true);
    expect(writers).toHaveLength(2);
    expect(writers.every((spec) => spec.image === app.cfg.baseTemplateTag)).toBe(true);
    expect(String(installed.output)).toContain("is missing; building it");
  });

  test("creating a box from another template does not wait for a base template build", async () => {
    await createFromCustom("alpha", []);
    expect(baseBuilds()).toHaveLength(0);
  });

  test("a box from the base template on a fresh host builds it first, once, as a task of its own", async () => {
    const created = await call("POST", "/api/boxes", { name: "fresh", cpus: 1, memoryMb: 256 });
    expect(created.status).toBe(201);
    expect(baseBuilds()).toHaveLength(1);
    const builds = (await call("GET", "/api/tasks?limit=50")).json;
    expect(JSON.stringify(builds)).toContain("template.build");
  });
});
