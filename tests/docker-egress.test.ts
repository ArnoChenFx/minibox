/**
 * Egress on a real engine, with the proxy and the host firewall running for real. A `none` box has no route out, and
 * exec, SSH and port previews still reach it. A `proxy-only` box reaches the hosts its allowlist names, is refused the
 * rest with an event for each, and has no way around its proxy. With BLOCK_HOST_GATEWAY on, a box on the default
 * network cannot reach a service on the host through the bridge gateway.
 *
 *   bun run test:docker
 *
 * That script (scripts/docker-integration.ts) picks the label prefix and sweeps what the run left behind. To run this
 * file directly: MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbit<id> bun test tests/docker-egress.test.ts
 *
 * The proxy-only cases need the engine to forward from user-defined networks to the internet. A host whose iptables-legacy
 * FORWARD policy is DROP, left over from an older Docker, drops that traffic silently, so the proxy's upstream times out.
 * The host firewall is one chain, MINIBOX-EGRESS, shared by every MiniBox on the host, so the test clears it when it
 * ends. The box image is tests/fixtures/egress. The proxy runs from tests/fixtures/egress/proxy.Dockerfile, which stands
 * in for the base template. The client side needs ssh on PATH.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { type App, createApp } from "../src/app";
import { createDockerRuntime } from "../src/docker/runtime";
import { type EgressRequest, normalizeEgress } from "../src/egress/policy";
import { PROXY_ALIAS } from "../src/egress/proxy";
import type { HostCtx } from "../src/host/registry";
import { egressNetworkName, egressProxyName } from "../src/labels";
import { proxyHttp, resolvePreview } from "../src/preview/proxy";
import type { ExecSession, Runtime } from "../src/runtime";
import { startServer } from "../src/server";
import { type Box, createBox } from "../src/services/boxes";
import { TEST_KEY, testConfig } from "./support/app";

const enabled = process.env.MINIBOX_TEST_DOCKER === "1";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const PREFIX_PATTERN = /^mbit[a-z0-9-]{3,40}$/;
const prefix = process.env.MINIBOX_TEST_PREFIX ?? `mbit${Date.now().toString(36)}`;
if (enabled && !PREFIX_PATTERN.test(prefix)) throw new Error(`MINIBOX_TEST_PREFIX must match ${PREFIX_PATTERN}`);
const owned = { [prefix]: "true" };
const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli.ts");
const FIXTURE_DIR = join(ROOT, "tests", "fixtures", "egress");
const BOX_IMAGE = `${prefix}-egress:fixture`;
/** The proxy runs the base template's image, so the fixture stands in for the template under this tag. */
const PROXY_BASE = `${prefix}-template:base`;
const ALLOWED = "example.com";
const DENIED = "example.org";
const SERVICE_TEXT = "gateway-ok\n";
const PREVIEW_PORT = 8080;
const runtime: Runtime = createDockerRuntime(SOCKET);

let app: App;
let host: HostCtx;
let server: ReturnType<typeof startServer>;
let base: string;
let home: string;
let dataDir: string;
let listener: TcpServer | undefined;
let listenerPort = 0;
let iso: Box;
let gated: Box;
let probe: Box;

interface Result {
  code: number | null;
  out: string;
  err: string;
}

async function collect(stream: Readable): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += String(chunk);
  return text;
}

async function until<T>(check: () => Promise<T | null>, what: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}

/** Runs a command in a box as dev, and returns its exit status and output once it has finished. */
async function inBox(box: Box, argv: string[]): Promise<Result> {
  const exec: ExecSession = await runtime.startExec(box.id, {
    cmd: argv,
    env: ["TERM=dumb"],
    workingDir: "/",
    user: "dev",
    tty: false,
  });
  const [out, err] = await Promise.all([collect(exec.stdout), collect(exec.stderr)]);
  const status = await until(async () => {
    const current = await exec.inspect();
    return current.running ? null : current;
  }, `${argv[0]} to finish`);
  return { code: status.exitCode, out, err };
}

const curl = (box: Box, args: string[]) => inBox(box, ["curl", "-sS", "-m", "8", ...args]);

function newBox(name: string, egress?: EgressRequest): Promise<Box> {
  return createBox(host, {
    name,
    image: BOX_IMAGE,
    cpus: 0.5,
    memoryMb: 256,
    ...(egress ? { egress: normalizeEgress(egress) } : {}),
  });
}

const eventsOf = (op: string, boxId: string) => app.events.list({ op, box: boxId }, { limit: 200 }).events;

/**
 * The NET_RAW bit of a process's bounding set, read from `/proc/self/status` output. The effective set is empty for the
 * non-root user an exec runs as, so the bounding set is the one that says what the box may ever use.
 */
function netRawOf(status: string): boolean {
  const hex = /CapBnd:\s+([0-9a-f]+)/.exec(status)?.[1];
  if (!hex) throw new Error(`no CapBnd in ${status}`);
  return ((BigInt(`0x${hex}`) >> 13n) & 1n) === 1n;
}

/** The bridge gateway of a network, which Docker assigns as the first address of its subnet. */
async function gatewayOf(network: string): Promise<string> {
  const subnet = (await runtime.listNetworks()).find((candidate) => candidate.name === network)?.subnets[0];
  if (!subnet) throw new Error(`network ${network} has no subnet`);
  const octets = subnet.split("/")[0].split(".");
  return `${octets[0]}.${octets[1]}.${octets[2]}.1`;
}

/** A service on every interface of the host, so a box can reach it through the bridge gateway. */
function listenOnHost(): Promise<{ server: TcpServer; port: number }> {
  return new Promise((resolve, reject) => {
    const tcp = createServer((socket) => {
      socket.on("error", () => {});
      socket.end(`HTTP/1.0 200 OK\r\nContent-Length: ${SERVICE_TEXT.length}\r\n\r\n${SERVICE_TEXT}`);
    });
    tcp.once("error", reject);
    tcp.listen(0, "0.0.0.0", () => {
      const address = tcp.address();
      resolve({ server: tcp, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

/** Serves a fixed HTTP response from inside a box, through socat, on the box's own port. */
async function servePreview(box: Box): Promise<ExecSession> {
  await inBox(box, [
    "sh",
    "-c",
    "printf 'HTTP/1.0 200 OK\\r\\nContent-Type: text/plain\\r\\n\\r\\npreview-ok\\n' > /tmp/preview.http",
  ]);
  const session = await runtime.startExec(box.id, {
    cmd: ["socat", `TCP-LISTEN:${PREVIEW_PORT},bind=0.0.0.0,reuseaddr,fork`, "SYSTEM:cat /tmp/preview.http"],
    env: ["TERM=dumb"],
    workingDir: "/",
    user: "dev",
    tty: false,
  });
  session.stdout.resume();
  session.stderr.resume();
  return session;
}

/** Reaches a preview the way the route does after its own sign-in check: the box is resolved and proxied to. */
async function previewOf(name: string): Promise<Response | null> {
  const url = new URL(`http://minibox.test/box/${name}/${PREVIEW_PORT}/`);
  try {
    const resolved = await resolvePreview(app.hosts, url, { pulse: app.pulse, audit: () => {} });
    try {
      return await proxyHttp(new Request(url), resolved, "path");
    } finally {
      resolved.release();
    }
  } catch {
    return null;
  }
}

/** Runs a client command in the test home, with the box's config and the server's URL in its environment. */
async function run(argv: string[]): Promise<Result> {
  const proc = Bun.spawn(argv, {
    cwd: home,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
      HOME: home,
      PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
      MINIBOX_URL: base,
      MINIBOX_ACCESS_KEY: TEST_KEY,
      SSH_AUTH_SOCK: "",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 60_000);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out, err };
  } finally {
    clearTimeout(timer);
  }
}

beforeAll(async () => {
  if (!enabled) return;
  await runtime.buildImage({ contextDir: FIXTURE_DIR, dockerfile: "proxy.Dockerfile", tag: PROXY_BASE, labels: owned });
  await runtime.buildImage({ contextDir: FIXTURE_DIR, dockerfile: "Dockerfile", tag: BOX_IMAGE, labels: owned });
  dataDir = mkdtempSync(join(tmpdir(), "minibox-egress-data-"));
  app = createApp(
    testConfig({
      labelPrefix: prefix,
      dockerSocket: SOCKET,
      baseTemplateTag: PROXY_BASE,
      dataDir,
      blockHostGateway: true,
    }),
    "0.0.0-test",
    { runtime, eventsPath: ":memory:" },
  );
  host = app.hosts.get();
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
  const service = await listenOnHost();
  listener = service.server;
  listenerPort = service.port;

  iso = await newBox("iso-none", { mode: "none" });
  gated = await newBox("gated", { mode: "proxy-only", domains: [ALLOWED] });
  probe = await createBox(host, { name: "probe", image: BOX_IMAGE, cpus: 0.5, memoryMb: 256 });

  home = mkdtempSync(join(tmpdir(), "minibox-egress-home-"));
  mkdirSync(join(home, "bin"));
  writeFileSync(join(home, "bin", "minibox"), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  chmodSync(join(home, "bin", "minibox"), 0o755);
  const setup = await run([process.execPath, CLI, "ssh-config", "--append"]);
  if (setup.code !== 0) throw new Error("ssh-config --append failed");
}, 600_000);

afterAll(async () => {
  if (!enabled) return;
  server?.stop(true);
  listener?.close();
  app?.sessions.stop();
  app?.tokens.stop();
  app?.throttle.stop();
  app?.events.close();
  const containers = [
    ...(await runtime.listContainers({ labels: owned }).catch(() => [])),
    ...(await runtime.listContainers({ labels: {} }).catch(() => [])).filter((c) => c.name.startsWith(`${prefix}-`)),
  ];
  for (const container of new Map(containers.map((c) => [c.id, c])).values()) {
    await runtime.removeContainer(container.id, { force: true }).catch(() => {});
  }
  for (const network of await runtime.listNetworks().catch(() => [])) {
    if (network.name.startsWith(`${prefix}-`)) await runtime.removeNetwork(network.name).catch(() => {});
  }
  await runtime.setHostIngressBlock([]).catch(() => {});
  await runtime.removeImage(BOX_IMAGE, { force: true }).catch(() => {});
  await runtime.removeImage(PROXY_BASE, { force: true }).catch(() => {});
  if (home) rmSync(home, { recursive: true, force: true });
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe.skipIf(!enabled)("egress tiers on a real engine", () => {
  test("a none box has no route out: an HTTPS request fails and the box has no default route", async () => {
    expect(iso.network).toBe(egressNetworkName(prefix, iso.boxId));
    expect((await curl(iso, ["-o", "/dev/null", `https://${ALLOWED}/`])).code).not.toBe(0);
    const routes = await inBox(iso, ["sh", "-c", `awk 'NR > 1 && $2 == "00000000"' /proc/net/route`]);
    expect(routes.out).toBe("");
  }, 120_000);

  test("exec runs in a none box and returns its output and exit status", async () => {
    expect(await inBox(iso, ["sh", "-c", "id -un; echo out; exit 3"])).toMatchObject({ code: 3, out: "dev\nout\n" });
  }, 120_000);

  test("the SSH gateway reaches a none box with the OpenSSH client", async () => {
    const result = await run([
      "ssh",
      "-F",
      join(home, ".ssh", "config"),
      "-o",
      "BatchMode=yes",
      "iso-none.minibox",
      "id -un; echo ssh-ok",
    ]);
    expect(result).toMatchObject({ code: 0, out: "dev\nssh-ok\n" });
  }, 120_000);

  test("a port preview answers from a none box", async () => {
    const service = await servePreview(iso);
    try {
      const response = await until(async () => {
        const reply = await previewOf("iso-none");
        return reply?.status === 200 ? reply : null;
      }, "the preview to answer");
      expect(await response.text()).toBe("preview-ok\n");
    } finally {
      await service.kill().catch(() => {});
    }
  }, 120_000);

  test("a proxy-only box reaches its allowlisted host and is refused the rest, with an event for each", async () => {
    const proxy = (await runtime.listContainers({ labels: {} })).find(
      (c) => c.name === egressProxyName(prefix, gated.boxId),
    );
    expect(proxy?.running).toBe(true);
    expect((await inBox(gated, ["sh", "-c", 'printf %s "$HTTPS_PROXY"'])).out).toBe(`http://${PROXY_ALIAS}:3128`);

    expect(await curl(gated, ["-o", "/dev/null", "-w", "%{http_code}", `https://${ALLOWED}/`])).toMatchObject({
      code: 0,
      out: "200",
    });
    expect((await curl(gated, ["-o", "/dev/null", `https://${ALLOWED}/egress-path-marker`])).code).toBe(0);
    expect((await curl(gated, ["-o", "/dev/null", `https://${DENIED}/`])).code).not.toBe(0);

    const allowance = await until(
      async () => eventsOf("egress.allowed", gated.id).find((e) => e.detail?.host === ALLOWED) ?? null,
      "the allowed event",
    );
    expect(allowance.detail).toMatchObject({ host: ALLOWED, port: 443, scheme: "https" });
    const denial = await until(
      async () => eventsOf("egress.denied", gated.id).find((e) => e.detail?.host === DENIED) ?? null,
      "the denial event",
    );
    expect(denial.detail).toMatchObject({ host: DENIED, port: 443, reason: "not_allowed" });

    const logged = JSON.stringify([...eventsOf("egress.allowed", gated.id), ...eventsOf("egress.denied", gated.id)]);
    expect(logged).not.toContain("egress-path-marker");
  }, 180_000);

  test("a proxy-only box cannot get around its proxy", async () => {
    const direct = await curl(gated, ["--noproxy", "*", "-o", "/dev/null", "https://1.1.1.1/"]);
    expect(direct.code).not.toBe(0);

    const unproxied = await inBox(gated, [
      "env",
      "-u",
      "HTTPS_PROXY",
      "-u",
      "https_proxy",
      "-u",
      "HTTP_PROXY",
      "-u",
      "http_proxy",
      "curl",
      "-sS",
      "-m",
      "8",
      "-o",
      "/dev/null",
      `https://${ALLOWED}/`,
    ]);
    expect(unproxied.code).not.toBe(0);

    const otherPort = await curl(gated, [
      "-x",
      `http://${PROXY_ALIAS}:3128`,
      "-o",
      "/dev/null",
      `https://${ALLOWED}:8443/`,
    ]);
    expect(otherPort.code).not.toBe(0);
    const denial = await until(
      async () => eventsOf("egress.denied", gated.id).find((e) => e.detail?.port === 8443) ?? null,
      "the port denial event",
    );
    expect(denial.detail).toMatchObject({ port: 8443, reason: "port" });

    expect(netRawOf((await inBox(gated, ["sh", "-c", "cat /proc/self/status"])).out)).toBe(false);
  }, 180_000);

  test("BLOCK_HOST_GATEWAY keeps a default-network box off a service on the host, and clearing it lets the box through", async () => {
    expect(probe.network).toBe(host.security.network);
    const url = `http://${await gatewayOf(probe.network)}:${listenerPort}/`;

    const blocked = await inBox(probe, ["curl", "-sS", "-m", "5", url]);
    expect(blocked.code).not.toBe(0);

    await runtime.setHostIngressBlock([]);
    expect(await inBox(probe, ["curl", "-sS", "-m", "5", url])).toMatchObject({ code: 0, out: SERVICE_TEXT });
  }, 120_000);

  test("a default-network box keeps NET_RAW, and the egress boxes do not", async () => {
    expect(netRawOf((await inBox(probe, ["sh", "-c", "cat /proc/self/status"])).out)).toBe(true);
    expect(netRawOf((await inBox(iso, ["sh", "-c", "cat /proc/self/status"])).out)).toBe(false);
  }, 120_000);
});
