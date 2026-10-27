import { afterAll, afterEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import type { Config } from "../src/config";
import { createTestApp, silenceLogs } from "./support/app";

const apps: App[] = [];
const restoreLogs = silenceLogs();
afterEach(() => {
  for (const app of apps.splice(0)) {
    app.hostAdmin.close();
    app.throttle.stop();
    app.sessions.stop();
    app.tokens.stop();
    app.events.close();
  }
});
afterAll(restoreLogs);

function boot(config: Partial<Config> = {}) {
  const lab = createTestApp(config);
  apps.push(lab.app);
  return lab;
}

describe("host labels across an actual control-plane restart", () => {
  test("configured local labels load without replacing the local runtime or monitor", () => {
    const first = boot({ localHostLabels: { gpu: "true" } });
    const next = boot({ ...first.app.cfg, dockerSocket: "/new-local.sock" });
    const local = next.app.hosts.get();
    expect(local.host.labels).toEqual({ gpu: "true" });
    expect(local.host.transport).toBe("local");
    expect(local.host.endpoint).toBe("unix:///new-local.sock");
    expect(local.runtime).toBe(next.runtime);
    expect(local.monitor).toBe(next.app.monitor);
    expect(next.app.hosts.list()).toHaveLength(1);
  });

  test("API overrides survive a restart and an empty override stays empty over the startup defaults", async () => {
    const first = boot({ localHostLabels: { gpu: "true" } });
    await first.app.hostAdmin.setLabels("local", { zone: "eu" });
    const next = boot(first.app.cfg);
    expect(next.app.hosts.get().host.labels).toEqual({ zone: "eu" });
    await next.app.hostAdmin.setLabels("local", {});
    const cleared = boot(first.app.cfg);
    expect(cleared.app.hosts.get().host.labels).toEqual({});
  });

  test("setting local labels with no startup defaults and keeping remote hosts also survives a restart", async () => {
    const first = boot();
    await first.app.hostAdmin.add({ id: "lab", endpoint: "unix:///run/lab.sock", labels: { zone: "west" } });
    await first.app.hostAdmin.setLabels("local", { zone: "east" });
    const next = boot(first.app.cfg);
    expect(next.app.hosts.list().map((host) => host.host.id)).toEqual(["local", "lab"]);
    expect(next.app.hosts.get().host.labels).toEqual({ zone: "east" });
    expect(next.app.hosts.get("lab").host.labels).toEqual({ zone: "west" });
    expect(next.app.hosts.get("lab").host.transport).toBe("unix");
  });
});
