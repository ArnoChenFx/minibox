/**
 * Tailscale in a box built from templates/base, against a real engine. The install runs through the tools writer as
 * the dev user. `minibox-tailscale up` starts tailscaled in userspace networking mode, and the daemon outlives the exec
 * that started it. `tailscale status` answers logged out, and uninstall stops the daemon before it removes the
 * binaries. The test never logs in.
 *
 *   bun run test:docker
 *
 * The install downloads from pkgs.tailscale.com. The login URL comes from the Tailscale control plane, so that check
 * runs only when the box can reach it. That script (scripts/docker-integration.ts) picks the label prefix and sweeps
 * what the run left behind. To run this file directly:
 * MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbit<id> bun test tests/docker-tools.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { type App, createApp } from "../src/app";
import { createDockerRuntime } from "../src/docker/runtime";
import type { HostCtx } from "../src/host/registry";
import type { ExecSession, Runtime } from "../src/runtime";
import { type Box, createBox } from "../src/services/boxes";
import { installTool, listToolStatuses, uninstallTool } from "../src/services/tools";
import { testConfig } from "./support/app";

const enabled = process.env.MINIBOX_TEST_DOCKER === "1";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const PREFIX_PATTERN = /^mbit[a-z0-9-]{3,40}$/;
const prefix = process.env.MINIBOX_TEST_PREFIX ?? `mbit${Date.now().toString(36)}`;
if (enabled && !PREFIX_PATTERN.test(prefix)) throw new Error(`MINIBOX_TEST_PREFIX must match ${PREFIX_PATTERN}`);
const ROOT = join(import.meta.dir, "..");
const IMAGE = `${prefix}-template:base`;
const owned = { [prefix]: "true" };
const CONTROL_PLANE = "https://controlplane.tailscale.com/";
const LOGIN_URL = /https:\/\/[^\s"']+(?=\s)/;
const runtime: Runtime = createDockerRuntime(SOCKET);

let app: App;
let host: HostCtx;
let box: Box;
let up: ExecSession;
let daemon: number;
let controlPlaneReachable = false;

async function until<T>(check: () => Promise<T | null>, what: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}

/** Keeps an exec's output as it arrives, so a command that runs for a long time can be read before it ends. */
function watch(session: ExecSession): { stdout: () => string; stderr: () => string } {
  const text = { stdout: "", stderr: "" };
  session.stdout.on("data", (chunk: Buffer | string) => {
    text.stdout += chunk.toString();
  });
  session.stderr.on("data", (chunk: Buffer | string) => {
    text.stderr += chunk.toString();
  });
  return { stdout: () => text.stdout, stderr: () => text.stderr };
}

function ended(stream: Readable): Promise<void> {
  if (stream.readableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once("end", () => resolve());
    stream.once("close", () => resolve());
    stream.once("error", () => resolve());
  });
}

interface Output {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a shell line in the box as dev, the way command exec does, and returns its status and output. */
async function execInBox(script: string): Promise<Output> {
  const session = await runtime.startExec(box.id, {
    cmd: ["/bin/sh", "-c", script],
    env: [],
    workingDir: "/",
    user: "dev",
    tty: false,
  });
  const output = watch(session);
  const status = await until(
    async () => {
      const current = await session.inspect();
      return current.running ? null : current;
    },
    `exec ${script}`,
    120_000,
  );
  await Promise.all([ended(session.stdout), ended(session.stderr)]);
  return { exitCode: status.exitCode, stdout: output.stdout(), stderr: output.stderr() };
}

beforeAll(async () => {
  if (!enabled) return;
  app = createApp(
    testConfig({
      labelPrefix: prefix,
      dockerSocket: SOCKET,
      baseTemplateTag: IMAGE,
      dataDir: mkdtempSync(join(tmpdir(), "minibox-tools-data-")),
    }),
    "0.0.0-test",
    { runtime, eventsPath: ":memory:" },
  );
  host = app.hosts.get();
  await runtime.buildImage({
    contextDir: join(ROOT, "templates", "base"),
    dockerfile: "Dockerfile",
    tag: IMAGE,
    labels: owned,
  });
  box = await createBox(host, { name: "tools-box", image: IMAGE, cpus: 1, memoryMb: 512 });
  const probe = await execInBox(`curl -sS -m 15 -o /dev/null ${CONTROL_PLANE} && echo reachable || echo unreachable`);
  controlPlaneReachable = probe.stdout.trim() === "reachable";
  if (!controlPlaneReachable) {
    console.warn(`[docker-tools] the box cannot reach ${CONTROL_PLANE}, so the login URL check is skipped`);
  }
}, 900_000);

afterAll(async () => {
  if (!enabled) return;
  app?.sessions.stop();
  app?.tokens.stop();
  app?.throttle.stop();
  app?.events.close();
  for (const container of await runtime.listContainers({ labels: owned })) {
    await runtime.removeContainer(container.id, { force: true }).catch(() => {});
  }
});

describe.skipIf(!enabled)("Tailscale in a box built from templates/base", () => {
  test("the tools writer installs tailscale for dev, and detection finds it on the tools volume", async () => {
    const installed = await installTool(host, box.id, "tailscale", "latest");
    expect(installed).toMatchObject({ id: "tailscale" });
    expect(installed.installedVersion).toMatch(/^\d+\.\d+\.\d+/);

    const identity = await execInBox("id -un; id -u; command -v tailscale; tailscale version | head -n 1");
    expect(identity).toMatchObject({ exitCode: 0 });
    expect(identity.stdout.trim().split("\n")).toEqual([
      "dev",
      "1000",
      "/opt/minibox/tools/bin/tailscale",
      installed.installedVersion,
    ]);

    const listed = await listToolStatuses(host, box.id);
    expect(listed.find((tool) => tool.id === "tailscale")).toMatchObject({
      needsRoot: false,
      installed: true,
      managed: true,
      installedVersion: installed.installedVersion,
    });
    const helper = await execInBox("test -x /opt/minibox/tools/bin/minibox-tailscale && echo ok");
    expect(helper.stdout.trim()).toBe("ok");
  }, 600_000);

  test("minibox-tailscale up runs tailscaled in userspace mode, and status answers logged out", async () => {
    up = await runtime.startExec(box.id, {
      cmd: ["minibox-tailscale", "up"],
      env: [],
      workingDir: "/",
      user: "dev",
      tty: false,
    });
    const output = watch(up);

    const status = await until(
      async () => {
        const result = await execInBox("minibox-tailscale status --json");
        return result.exitCode === 0 ? result : null;
      },
      "tailscaled to answer status",
      60_000,
    );
    expect(status.stdout).toMatch(/"BackendState":\s*"NeedsLogin"/);

    daemon = Number((await execInBox('cat "$HOME/.local/state/tailscale/tailscaled.pid"')).stdout.trim());
    expect(daemon).toBeGreaterThan(1);
    const argv = (await execInBox(`tr '\\000' ' ' < /proc/${daemon}/cmdline`)).stdout;
    expect(argv).toContain("/opt/minibox/tools/bin/tailscaled --tun=userspace-networking ");
    expect(argv).toContain("--socks5-server=localhost:1055");
    expect(argv).toContain("--outbound-http-proxy-listen=localhost:1055");
    expect(argv).toContain("--state=/home/dev/.local/state/tailscale/tailscaled.state");

    const port = await execInBox("bash -c 'exec 3<>/dev/tcp/localhost/1055' && echo open");
    expect(port.stdout.trim()).toBe("open");

    if (controlPlaneReachable) {
      const login = await until(
        async () => {
          const match = LOGIN_URL.exec(`${output.stdout()}${output.stderr()}`);
          return match ? match[0] : null;
        },
        "the login URL from tailscale up",
        120_000,
      );
      expect(login).toMatch(/^https:\/\//);
    }
    expect((await up.inspect()).running).toBe(true);
  }, 300_000);

  test("killing the exec that ran up leaves tailscaled running", async () => {
    await up.kill();
    expect((await execInBox(`kill -0 ${daemon} && echo alive`)).stdout.trim()).toBe("alive");
    expect(await execInBox("minibox-tailscale status --json")).toMatchObject({ exitCode: 0 });
  }, 120_000);

  test("uninstall stops tailscaled and removes the binaries, and keeps the login state", async () => {
    const removed = await uninstallTool(host, box.id, "tailscale");
    expect(removed).toMatchObject({ id: "tailscale", installedVersion: null });

    const state = await execInBox(
      `if [ -e /proc/${daemon} ]; then sed 's/.*) //' /proc/${daemon}/stat | cut -d' ' -f1; else echo gone; fi`,
    );
    expect(["gone", "Z", "X"]).toContain(state.stdout.trim());
    const binary = await execInBox("test -e /opt/minibox/tools/bin/tailscale && echo present || echo removed");
    expect(binary.stdout.trim()).toBe("removed");
    const kept = await execInBox('test -d "$HOME/.local/state/tailscale" && echo kept');
    expect(kept.stdout.trim()).toBe("kept");

    const listed = await listToolStatuses(host, box.id);
    expect(listed.find((tool) => tool.id === "tailscale")).toMatchObject({ installed: false, managed: false });
  }, 300_000);
});
