import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import { probeHost } from "../src/host/registry";
import type { LabelKeys } from "../src/labels";
import { createTestApp, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

const MB = 1024 * 1024;

let app: App;
let runtime: FakeRuntime;
let keys: LabelKeys;
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  ({ app, runtime } = createTestApp({ labelPrefix: "mbtest" }));
  keys = app.hosts.get().keys;
});

afterEach(() => restoreLogs());

describe("HostRegistry", () => {
  test("the implicit local host is the default and carries the configured endpoint", () => {
    const ctx = app.hosts.get();
    expect(ctx.host).toMatchObject({
      id: "local",
      kind: "docker",
      endpoint: `unix://${app.cfg.dockerSocket}`,
      status: "unknown",
    });
    expect(app.hosts.get("local")).toBe(ctx);
    expect(ctx.baseTemplateTag).toBe(app.cfg.baseTemplateTag);
    expect(ctx.keys.box).toBe("mbtest");
  });

  test("unknown ids are an error, and a host id can only be registered once", () => {
    const local = app.hosts.get();
    expect(() => app.hosts.get("nope")).toThrow("unknown host: nope");
    expect(() => app.hosts.add(local)).toThrow("host already registered: local");
  });

  test("internal APIs can address another host by id", () => {
    const local = app.hosts.get();
    const lab = { ...local, host: { ...local.host, id: "lab", name: "Lab" } };
    app.hosts.add(lab);
    expect(app.hosts.get("lab").host.name).toBe("Lab");
    expect(app.hosts.get("local").host.name).toBe("Local");
  });
});

describe("probeHost", () => {
  test("records online or offline from the ping result", async () => {
    const ctx = app.hosts.get();
    expect(await probeHost(ctx)).toBe("online");
    expect(ctx.host.status).toBe("online");

    runtime.down = true;
    expect(await probeHost(ctx)).toBe("offline");
    expect(ctx.host.status).toBe("offline");
  });
});

describe("HostMonitor", () => {
  test("summarises the engine and allocation of MiniBox boxes", async () => {
    runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true" });
    const box = { [keys.box]: "true" };
    runtime.seedContainer({
      image: app.cfg.baseTemplateTag,
      name: "mbtest-a",
      labels: { ...box, [keys.name]: "a" },
      running: true,
      cpus: 1.5,
      memoryBytes: 512 * MB,
    });
    runtime.seedContainer({
      image: app.cfg.baseTemplateTag,
      name: "mbtest-b",
      labels: { ...box, [keys.name]: "b" },
      running: true,
      cpus: 0.5,
      memoryBytes: 256 * MB,
    });
    runtime.seedContainer({
      image: app.cfg.baseTemplateTag,
      name: "mbtest-c",
      labels: { ...box, [keys.name]: "c" },
      running: false,
      cpus: null,
      memoryBytes: null,
    });
    runtime.seedContainer({ image: app.cfg.baseTemplateTag, name: "unrelated", running: true });

    const snapshot = await app.monitor.snapshot();
    expect(snapshot.docker).toMatchObject({
      available: true,
      version: "fake",
      rootDir: "/fake/docker",
      containers: { running: 3, total: 4 },
      images: 1,
    });
    expect(snapshot.boxes).toEqual({
      total: 3,
      running: 2,
      allocatedCpus: 2,
      allocatedMemory: 768 * MB,
      unlimited: 1,
    });
  });

  test("Docker information is cached briefly instead of queried on every snapshot", async () => {
    await app.monitor.snapshot();
    await app.monitor.snapshot();
    expect(runtime.callsTo("info")).toHaveLength(1);
  });

  test("an unreachable engine is reported as unavailable with empty box totals", async () => {
    runtime.down = true;
    const snapshot = await app.monitor.snapshot();
    expect(snapshot.docker.available).toBe(false);
    expect(snapshot.boxes).toEqual({ total: 0, running: 0, allocatedCpus: 0, allocatedMemory: 0, unlimited: 0 });
  });
});
