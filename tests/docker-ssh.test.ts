/**
 * SSH into a box against a real engine, with the OpenSSH client itself. The client reads the config that
 * `minibox ssh-config --append` writes, and reaches the box through a `minibox` on PATH, so the test covers the setup a
 * person runs. It checks a command's output and exit status, stdin, scp, sftp, a local forward (-L), the refusals (-R
 * and root), and that a stopped box wakes on connect. It also connects straight to the server's SSH port, as Termius
 * does, with a token as the password and with an owner key, and checks that a wrong password is refused.
 *
 *   bun run test:docker
 *
 * That script (scripts/docker-integration.ts) picks the label prefix and sweeps what the run left behind. To run this
 * file directly: MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbit<id> bun test tests/docker-ssh.test.ts
 *
 * The client side needs ssh, scp and sftp on PATH. The box image is tests/fixtures/ssh.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Server } from "bun";
import { utils } from "ssh2";

import { type App, createApp } from "../src/app";
import { createDockerRuntime } from "../src/docker/runtime";
import type { HostCtx } from "../src/host/registry";
import type { ExecSession, Runtime } from "../src/runtime";
import { startDirectSsh, startServer } from "../src/server";
import { type Box, createBox, getBox, stopBox } from "../src/services/boxes";
import type { SocketData } from "../src/ws/socket";
import { TEST_KEY, testConfig } from "./support/app";
import { mint } from "./support/tokens";

const enabled = process.env.MINIBOX_TEST_DOCKER === "1";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const PREFIX_PATTERN = /^mbit[a-z0-9-]{3,40}$/;
const prefix = process.env.MINIBOX_TEST_PREFIX ?? `mbit${Date.now().toString(36)}`;
if (enabled && !PREFIX_PATTERN.test(prefix)) throw new Error(`MINIBOX_TEST_PREFIX must match ${PREFIX_PATTERN}`);
const FIXTURE = `${prefix}-ssh:fixture`;
const owned = { [prefix]: "true" };
const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli.ts");
const BOX_NAME = "sshbox";
const SERVICE_PORT = 18080;
const runtime: Runtime = createDockerRuntime(SOCKET);

let app: App;
let host: HostCtx;
let server: Server<SocketData>;
let base: string;
let home: string;
let box: Box;
let directPort: number;

function environment(): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  return {
    ...inherited,
    HOME: home,
    PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
    MINIBOX_URL: base,
    MINIBOX_ACCESS_KEY: TEST_KEY,
    SSH_AUTH_SOCK: "",
  };
}

interface Result {
  code: number | null;
  out: string;
  err: string;
}

/** Runs a client command in the test home, with the box's config and the server's URL in its environment. */
async function run(argv: string[], input?: string): Promise<Result> {
  const proc = Bun.spawn(argv, {
    cwd: home,
    env: environment(),
    stdin: input === undefined ? "ignore" : new Blob([input]),
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

const configPath = () => join(home, ".ssh", "config");
const ssh = (args: string[], input?: string) => run(["ssh", "-F", configPath(), "-o", "BatchMode=yes", ...args], input);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

/** Reads what a raw TCP service writes, without speaking HTTP to it. Rejects while nothing is listening yet. */
function readRaw(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      text += chunk;
    });
    socket.on("close", () => resolve(text));
    socket.on("error", reject);
  });
}

async function until<T>(check: () => Promise<T | null>, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}

beforeAll(async () => {
  if (!enabled) return;
  const cfg = testConfig({
    labelPrefix: prefix,
    dockerSocket: SOCKET,
    baseTemplateTag: `${prefix}-template:base`,
    dataDir: mkdtempSync(join(tmpdir(), "minibox-ssh-data-")),
    sshPort: 0,
    sshBind: "127.0.0.1",
  });
  app = createApp(cfg, "0.0.0-test", { runtime, eventsPath: ":memory:" });
  host = app.hosts.get();
  await runtime.buildImage({
    contextDir: join(ROOT, "tests", "fixtures", "ssh"),
    dockerfile: "Dockerfile",
    tag: FIXTURE,
    labels: owned,
  });
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
  const listening = await startDirectSsh(app);
  if (listening === null) throw new Error("direct SSH did not start");
  directPort = listening;

  home = mkdtempSync(join(tmpdir(), "minibox-ssh-home-"));
  mkdirSync(join(home, "bin"));
  writeFileSync(join(home, "bin", "minibox"), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  chmodSync(join(home, "bin", "minibox"), 0o755);

  box = await createBox(host, { name: BOX_NAME, image: FIXTURE, cpus: 0.5, memoryMb: 128 });
  const setup = await run([process.execPath, CLI, "ssh-config", "--append"]);
  if (setup.code !== 0) throw new Error(`ssh-config --append failed: ${setup.err}`);
}, 600_000);

afterAll(async () => {
  if (!enabled) return;
  await app?.sshDirect?.close();
  server?.stop(true);
  app?.sessions.stop();
  app?.tokens.stop();
  app?.throttle.stop();
  app?.events.close();
  for (const c of await runtime.listContainers({ labels: owned })) {
    await runtime.removeContainer(c.id, { force: true }).catch(() => {});
  }
  if (home) rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!enabled)("SSH into a box with the OpenSSH client", () => {
  test("the config minibox ssh-config wrote is the one the client reads", async () => {
    const shown = await run(["ssh", "-F", configPath(), "-G", `${BOX_NAME}.minibox`]);
    expect(shown.code).toBe(0);
    expect(shown.out).toMatch(/^user dev$/m);
    expect(shown.out).toMatch(/^proxycommand minibox ssh-proxy /m);
    expect(shown.out).toMatch(/^stricthostkeychecking (yes|true)$/m);
    expect(shown.out).toContain(join(home, ".ssh", "minibox_known_hosts"));
  });

  test("a command runs in the box as dev, and its output and exit status come back", async () => {
    const result = await ssh([`${BOX_NAME}.minibox`, "id -un; echo out; echo err >&2; exit 7"]);
    expect(result.code).toBe(7);
    expect(result.out).toBe("dev\nout\n");
    expect(result.err).toContain("err\n");
  });

  test("stdin reaches the command", async () => {
    const result = await ssh([`${BOX_NAME}.minibox`, "cat"], "piped in\n");
    expect(result).toMatchObject({ code: 0, out: "piped in\n" });
  });

  test("root is refused before any command runs", async () => {
    const result = await ssh(["-l", "root", `${BOX_NAME}.minibox`, "true"]);
    expect(result.code).toBe(255);
    expect(result.err).toContain("Permission denied");
  });

  test("scp copies a file in and back out, byte for byte, and the box owns the copy as dev", async () => {
    const payload = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 31 + 7) & 0xff));
    const up = join(home, "up.bin");
    writeFileSync(up, payload);
    const put = await run([
      "scp",
      "-F",
      configPath(),
      "-o",
      "BatchMode=yes",
      up,
      `${BOX_NAME}.minibox:/workspace/scp.bin`,
    ]);
    expect(put.code).toBe(0);
    const down = join(home, "down.bin");
    const got = await run([
      "scp",
      "-F",
      configPath(),
      "-o",
      "BatchMode=yes",
      `${BOX_NAME}.minibox:/workspace/scp.bin`,
      down,
    ]);
    expect(got.code).toBe(0);
    expect(readFileSync(down).equals(payload)).toBe(true);
    expect((await ssh([`${BOX_NAME}.minibox`, "stat -c %U /workspace/scp.bin"])).out.trim()).toBe("dev");
  });

  test("sftp lists the workspace, then uploads and downloads a file", async () => {
    const local = join(home, "sftp-local.txt");
    const back = join(home, "sftp-back.txt");
    const batch = join(home, "sftp.batch");
    writeFileSync(local, "sftp body\n");
    writeFileSync(
      batch,
      ["ls -l /workspace", `put ${local} /workspace/sftp.txt`, `get /workspace/sftp.txt ${back}`, ""].join("\n"),
    );
    const result = await run(["sftp", "-F", configPath(), "-o", "BatchMode=yes", "-b", batch, `${BOX_NAME}.minibox`]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("sftp.txt");
    expect(readFileSync(back, "utf8")).toBe("sftp body\n");
  });

  test("a local forward (-L) reaches a service listening on the box's loopback", async () => {
    const service: ExecSession = await runtime.startExec(box.id, {
      cmd: ["socat", `TCP-LISTEN:${SERVICE_PORT},bind=127.0.0.1,reuseaddr,fork`, "SYSTEM:echo pong-from-box"],
      env: ["TERM=dumb"],
      workingDir: "/",
      user: "dev",
      tty: false,
    });
    service.stdout.resume();
    service.stderr.resume();
    const local = await freePort();
    const forward = Bun.spawn(
      [
        "ssh",
        "-F",
        configPath(),
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-N",
        "-L",
        `${local}:127.0.0.1:${SERVICE_PORT}`,
        `${BOX_NAME}.minibox`,
      ],
      { env: environment(), stdout: "pipe", stderr: "pipe" },
    );
    try {
      const body = await until(
        () =>
          readRaw(local).then(
            (text) => text || null,
            () => null,
          ),
        "the forwarded port",
      );
      expect(body).toBe("pong-from-box\n");
    } finally {
      forward.kill();
      await forward.exited;
      await service.kill().catch(() => {});
    }
  });

  test("a remote forward (-R) is refused, so the client reports the failure", async () => {
    const result = await run([
      "ssh",
      "-F",
      configPath(),
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-N",
      "-R",
      "19191:127.0.0.1:1",
      `${BOX_NAME}.minibox`,
    ]);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("remote port forwarding failed");
  });

  test("a stopped box is woken by the SSH connection", async () => {
    await stopBox(host, box.boxId, "idle");
    expect((await getBox(host, box.boxId)).running).toBe(false);
    const result = await ssh([`${BOX_NAME}.minibox`, "echo awake"]);
    expect(result).toMatchObject({ code: 0, out: "awake\n" });
    expect((await getBox(host, box.boxId)).running).toBe(true);
  });
});

/** A known_hosts line that pins the server's host key for the direct port, as a first connection would save it. */
function pinDirectHostKey(): string {
  const path = join(home, ".ssh", "direct_known_hosts");
  writeFileSync(path, `[127.0.0.1]:${directPort} ${app.ssh.hostKeyView().publicKey}\n`);
  return path;
}

/**
 * OpenSSH straight to the direct port, with no config file and no minibox CLI: the user is the box name. A password is
 * typed by an askpass script, the way sshpass would type it, so the test needs nothing beyond OpenSSH.
 */
async function directSsh(options: { password?: string; identity?: string }, command: string): Promise<Result> {
  const args = [
    "ssh",
    "-F",
    "/dev/null",
    "-p",
    String(directPort),
    "-o",
    `UserKnownHostsFile=${pinDirectHostKey()}`,
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "NumberOfPasswordPrompts=1",
    "-o",
    "ConnectTimeout=20",
  ];
  const env: Record<string, string> = {};
  if (options.identity) {
    args.push("-i", options.identity, "-o", "IdentitiesOnly=yes", "-o", "PreferredAuthentications=publickey");
    args.push("-o", "BatchMode=yes");
  } else {
    const askpass = join(home, "bin", "askpass");
    writeFileSync(join(home, "password"), options.password ?? "");
    writeFileSync(askpass, `#!/bin/sh\ncat "${join(home, "password")}"\n`);
    chmodSync(askpass, 0o755);
    args.push("-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "PubkeyAuthentication=no");
    Object.assign(env, { SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force", DISPLAY: ":0" });
  }
  args.push(`${BOX_NAME}@127.0.0.1`, command);
  const proc = Bun.spawn(args, {
    cwd: home,
    env: { ...environment(), ...env },
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

describe.skipIf(!enabled)("direct SSH to the server's SSH port with the OpenSSH client", () => {
  test("an agent token with box:ssh is the password, and the user is the box name", async () => {
    const token = mint(app, { name: "termius", scopes: ["box:ssh"], boxes: { type: "all" } });
    const result = await directSsh({ password: token.secret }, "id -un; echo direct");
    expect(result).toMatchObject({ code: 0, out: "dev\ndirect\n" });
  });

  test("a private key whose public half the owner added logs in", async () => {
    const pair = utils.generateKeyPairSync("ed25519", { comment: "laptop" });
    app.sshKeys.add(pair.public, "laptop");
    const identity = join(home, ".ssh", "id_direct");
    writeFileSync(identity, pair.private, { mode: 0o600 });
    const result = await directSsh({ identity }, "echo keyed");
    expect(result).toMatchObject({ code: 0, out: "keyed\n" });
  });

  test("a wrong password is refused, and nothing runs", async () => {
    const result = await directSsh({ password: "not-a-token" }, "echo never");
    expect(result.code).toBe(255);
    expect(result.out).toBe("");
    expect(result.err).toContain("Permission denied");
  });
});
