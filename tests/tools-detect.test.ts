import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import type { HelperSpec } from "../src/runtime";
import { startServer } from "../src/server";
import { savePools } from "../src/services/volumes";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

type Found = Record<string, { managed: boolean; version?: string }>;

const CUSTOM_TOOL = {
  name: "Sample tool",
  description: "A sample entry.",
  source: "npm",
  package: "sample-tool",
  bin: "sample-tool",
  install: "npm install -g --prefix {{prefix}} {{package_spec}}",
  upgrade: "npm install -g --prefix {{prefix}} {{package_spec}}",
  uninstall: "npm uninstall -g --prefix {{prefix}} {{package}}",
  detect: "command -v sample-tool >/dev/null && sample-tool --version 2>/dev/null",
};

let app: App;
let runtime: FakeRuntime;
let server: ReturnType<typeof startServer> | undefined;
let base: string;
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  ({ app, runtime } = createTestApp({ labelPrefix: "mbtest" }));
  const keys = app.hosts.get().keys;
  runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
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

/**
 * Answers the detection helper from `found`, the way the detect script reports each entry: its marker, id, status,
 * managed flag and version. Edit `found` between requests to model an install or an uninstall.
 */
function answerDetection(found: Found): void {
  const prior = runtime.helperHandler;
  runtime.helperHandler = (spec: HelperSpec) => {
    if (!spec.cmd.join(" ").includes("MBTOOL")) return prior(spec);
    const lines = Object.entries(found).map(
      ([id, item]) => `MBTOOL\t${id}\t0\t${item.managed ? 1 : 0}\t${item.version ?? ""}`,
    );
    return { exitCode: 0, logs: lines.length ? `${lines.join("\n")}\n` : "" };
  };
}

function detectionCalls(): HelperSpec[] {
  return runtime
    .callsTo("runHelper")
    .map((call) => call.args[0] as HelperSpec)
    .filter((spec) => spec.cmd.join(" ").includes("MBTOOL"));
}

function writerCalls(): HelperSpec[] {
  return runtime
    .callsTo("runHelper")
    .map((call) => call.args[0] as HelperSpec)
    .filter((spec) => spec.network === true);
}

async function createBox(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await call("POST", "/api/boxes", { name, cpus: 1, memoryMb: 256, ...extra });
  expect(created.status).toBe(201);
  return String((created.json.box as { id: string }).id);
}

async function waitTask(id: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const view = (await call("GET", `/api/tasks/${id}`)).json;
    if (view.status !== "running" || Date.now() > deadline) return view;
    await Bun.sleep(5);
  }
}

function toolRow(json: Record<string, unknown>, id: string): Record<string, unknown> | undefined {
  return (json.tools as Record<string, unknown>[]).find((tool) => tool.id === id);
}

describe("installed detection", () => {
  test("a tool the detect command finds is installed with its version, and managed only when on the tools volume", async () => {
    const found: Found = {
      "claude-code": { managed: true, version: "2.1.306 (Claude Code)" },
      codex: { managed: false, version: "codex-cli 0.163.0" },
      uv: { managed: false },
    };
    answerDetection(found);
    const listed = await call("GET", "/api/tools");
    expect(listed.status).toBe(200);

    expect(toolRow(listed.json, "claude-code")).toMatchObject({
      category: "agents",
      needsRoot: false,
      installed: true,
      installedVersion: "2.1.306 (Claude Code)",
      managed: true,
    });
    expect(toolRow(listed.json, "codex")).toMatchObject({
      installed: true,
      installedVersion: "codex-cli 0.163.0",
      managed: false,
    });
    expect(toolRow(listed.json, "uv")).toMatchObject({ installed: true, installedVersion: null, managed: false });
    expect(toolRow(listed.json, "zig")).toMatchObject({ installed: false, installedVersion: null, managed: false });
    expect(toolRow(listed.json, "tailscale")).toMatchObject({
      category: "networking",
      needsRoot: true,
      installed: false,
    });
  });

  test("detection finds a tool in the box's own image, with its home and tools volumes read-only and no network", async () => {
    const keys = app.hosts.get().keys;
    runtime.seedImage("mbtest-custom:1", { [keys.template]: "true", [keys.templateName]: "custom" });
    const boxId = await createBox("alpha", { template: "mbtest-custom:1" });
    answerDetection({ codex: { managed: false, version: "codex-cli 0.163.0" } });

    const listed = await call("GET", `/api/tools?id=${boxId}`);
    expect(toolRow(listed.json, "codex")).toMatchObject({ installed: true, managed: false });

    const probe = detectionCalls().at(-1);
    expect(probe).toBeDefined();
    expect(probe?.image).toBe("mbtest-custom:1");
    expect(probe?.network).toBeFalsy();
    expect(probe?.mounts?.map((mount) => [mount.target, mount.mode]).toSorted()).toEqual([
      ["/home/dev", "ro"],
      ["/opt/minibox/tools", "ro"],
    ]);
  });

  test("without a box, detection runs in the base template with only the tools volume mounted", async () => {
    answerDetection({});
    await call("GET", "/api/tools");
    expect(detectionCalls().at(-1)?.mounts ?? []).toEqual([]);

    await createBox("alpha");
    await call("GET", "/api/tools");
    const probe = detectionCalls().at(-1);
    expect(probe?.image).toBe(app.cfg.baseTemplateTag);
    expect(probe?.mounts?.map((mount) => [mount.target, mount.mode])).toEqual([["/opt/minibox/tools", "ro"]]);
  });

  test("a failed detection helper reports every tool as not installed", async () => {
    const prior = runtime.helperHandler;
    runtime.helperHandler = (spec: HelperSpec) => {
      if (spec.cmd.join(" ").includes("MBTOOL")) throw new Error("engine unavailable");
      return prior(spec);
    };
    const listed = await call("GET", "/api/tools");
    expect(listed.status).toBe(200);
    expect((listed.json.tools as { installed: boolean }[]).every((tool) => tool.installed === false)).toBe(true);
  });
});

function helperCallsFrom(index: number): HelperSpec[] {
  return runtime
    .callsTo("runHelper")
    .slice(index)
    .map((call) => call.args[0] as HelperSpec);
}

async function installCodex(boxId: string): Promise<string> {
  const started = await call("POST", `/api/boxes/${boxId}/tools/install`, { tool: "codex", version: "latest" });
  expect(started.status).toBe(202);
  return String((await waitTask(String(started.json.taskId))).status);
}

describe("the tools writer", () => {
  test("a local tools volume is handed to uid 1000 by a root helper just before the writer runs", async () => {
    const boxId = await createBox("alpha");
    answerDetection({});
    const before = runtime.callsTo("runHelper").length;

    expect(await installCodex(boxId)).toBe("succeeded");
    const calls = helperCallsFrom(before);
    const writer = calls.findIndex((spec) => spec.network === true);
    const handover = calls.findIndex((spec) => spec.user === "0:0" && spec.cmd.join(" ").includes("chown -R"));
    expect(handover).toBeGreaterThanOrEqual(0);
    expect(handover).toBeLessThan(writer);
    expect(calls[handover]).toMatchObject({
      capAdd: ["CHOWN"],
      mounts: [{ source: calls[writer]?.mounts?.[0]?.source }],
    });
  });

  test("a tools volume on a path pool is not handed over, because its directory is prepared when it is created", async () => {
    await savePools(
      app.hosts.get(),
      [
        { name: "local", backend: "local" },
        { name: "disk", backend: "path", root: "/mnt/disk", default: true },
      ],
      undefined,
    );
    const boxId = await createBox("alpha");
    answerDetection({});
    const before = runtime.callsTo("runHelper").length;

    expect(await installCodex(boxId)).toBe("succeeded");
    const calls = helperCallsFrom(before);
    expect(calls.some((spec) => spec.network === true)).toBe(true);
    expect(calls.some((spec) => spec.user === "0:0" && spec.cmd.join(" ").includes("chown -R"))).toBe(false);
  });
});

describe("reconcile and changes to installed tools", () => {
  test("reconcile skips a tool the box already has and installs only the missing ones", async () => {
    const boxId = await createBox("alpha", { tools: ["claude-code", "codex"] });
    answerDetection({ "claude-code": { managed: false, version: "2.1.306 (Claude Code)" } });

    const started = await call("POST", `/api/boxes/${boxId}/tools/reconcile`);
    expect(started.status).toBe(202);
    const task = await waitTask(String(started.json.taskId));
    expect(task.status).toBe("succeeded");
    expect(task.result).toEqual({ installed: ["codex"], skipped: ["claude-code"], failed: [] });

    const writes = writerCalls().map((spec) => spec.cmd.join(" "));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("@openai/codex");
    expect(writes[0]).not.toContain("@anthropic-ai/claude-code");
  });

  test("uninstall and upgrade refuse a tool that is installed outside MiniBox", async () => {
    const boxId = await createBox("alpha", { tools: ["claude-code"] });
    answerDetection({ "claude-code": { managed: false, version: "2.1.306 (Claude Code)" } });

    for (const action of ["uninstall", "upgrade"]) {
      const started = await call("POST", `/api/boxes/${boxId}/tools/${action}`, {
        tool: "claude-code",
        version: "latest",
      });
      expect(started.status).toBe(202);
      const task = await waitTask(String(started.json.taskId));
      expect(task.status).toBe("failed");
      expect((task.error as { message: string }).message).toContain("installed outside MiniBox");
    }
    expect(writerCalls()).toHaveLength(0);
  });

  test("uninstall, upgrade and reconcile stop when detection cannot run, rather than act on an empty answer", async () => {
    const boxId = await createBox("alpha", { tools: ["claude-code"] });
    const prior = runtime.helperHandler;
    runtime.helperHandler = (spec: HelperSpec) => {
      if (spec.cmd.join(" ").includes("MBTOOL")) throw new Error("engine unavailable");
      return prior(spec);
    };

    const requests: [string, Record<string, unknown> | undefined][] = [
      ["uninstall", { tool: "claude-code", version: "latest" }],
      ["upgrade", { tool: "claude-code", version: "latest" }],
      ["reconcile", undefined],
    ];
    for (const [action, body] of requests) {
      const started = await call("POST", `/api/boxes/${boxId}/tools/${action}`, body);
      expect(started.status).toBe(202);
      const task = await waitTask(String(started.json.taskId));
      expect(task.status).toBe("failed");
      expect((task.error as { message: string }).message).toContain("engine unavailable");
    }
    expect(writerCalls()).toHaveLength(0);
  });

  test("uninstall removes a tool MiniBox installed on the tools volume", async () => {
    const boxId = await createBox("alpha", { tools: ["claude-code"] });
    answerDetection({ "claude-code": { managed: true, version: "2.1.306 (Claude Code)" } });

    const started = await call("POST", `/api/boxes/${boxId}/tools/uninstall`, { tool: "claude-code" });
    const task = await waitTask(String(started.json.taskId));
    expect(task.status).toBe("succeeded");
    expect(task.result).toEqual({ id: "claude-code", version: "latest", installedVersion: null });
    expect(writerCalls()).toHaveLength(1);
  });

  test("a custom entry saved through the API is detected, recorded on a box and installed by reconcile", async () => {
    expect((await call("PUT", "/api/tools/custom/sample-tool", CUSTOM_TOOL)).status).toBe(200);
    answerDetection({ "sample-tool": { managed: false, version: "1.2.3" } });
    expect(toolRow((await call("GET", "/api/tools")).json, "sample-tool")).toMatchObject({
      source: "npm",
      installed: true,
      installedVersion: "1.2.3",
      managed: false,
      desiredVersion: null,
    });

    const boxId = await createBox("alpha", { tools: ["sample-tool"] });
    answerDetection({});
    const started = await call("POST", `/api/boxes/${boxId}/tools/reconcile`);
    expect(started.status).toBe(202);
    const task = await waitTask(String(started.json.taskId));
    expect(task.status).toBe("succeeded");
    expect(task.result).toEqual({ installed: ["sample-tool"], skipped: [], failed: [] });
    const writes = writerCalls().map((spec) => spec.cmd.join(" "));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("npm install -g --prefix /opt/minibox/tools sample-tool@latest");
  });

  test("an installed custom entry is uninstalled with its saved command, and deleting the entry leaves the volume alone", async () => {
    await call("PUT", "/api/tools/custom/sample-tool", CUSTOM_TOOL);
    const boxId = await createBox("alpha", { tools: ["sample-tool"] });
    answerDetection({ "sample-tool": { managed: true, version: "1.2.3" } });

    const started = await call("POST", `/api/boxes/${boxId}/tools/uninstall`, { tool: "sample-tool" });
    expect(started.status).toBe(202);
    expect((await waitTask(String(started.json.taskId))).status).toBe("succeeded");
    expect(writerCalls().map((spec) => spec.cmd.join(" "))).toEqual([
      "sh -c npm uninstall -g --prefix /opt/minibox/tools sample-tool",
    ]);

    const writesBefore = writerCalls().length;
    expect((await call("DELETE", "/api/tools/custom/sample-tool")).json).toEqual({
      id: "sample-tool",
      restoredBuiltin: false,
    });
    expect(toolRow((await call("GET", "/api/tools")).json, "sample-tool")).toBeUndefined();
    expect(writerCalls()).toHaveLength(writesBefore);
  });

  test("a root-only tool cannot be recorded on a box or installed", async () => {
    const refused = await call("POST", "/api/boxes", { name: "beta", cpus: 1, memoryMb: 256, tools: ["tailscale"] });
    expect(refused.status).toBe(400);
    expect((refused.json.error as { message: string }).message).toContain("requires root");

    const boxId = await createBox("alpha");
    const started = await call("POST", `/api/boxes/${boxId}/tools/install`, { tool: "tailscale", version: "latest" });
    expect(started.status).toBe(202);
    const task = await waitTask(String(started.json.taskId));
    expect(task.status).toBe("failed");
    expect((task.error as { message: string }).message).toContain("requires root");
    expect(writerCalls()).toHaveLength(0);
  });
});
