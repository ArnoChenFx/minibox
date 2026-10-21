import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";

import { Client } from "ssh2";

import { runCli } from "../src/cli";
import type { OperationContext, Principal } from "../src/operations/types";
import { startServer } from "../src/server";
import { getBox } from "../src/services/boxes";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { fingerprintOf, runCommand } from "./support/ssh";
import { mint } from "./support/tokens";

const OWNER: Principal = { type: "owner", id: "owner", name: "owner" };

interface Io {
  out: string;
  err: string;
  stdout(text: string): void;
  stderr(text: string): void;
  stdoutBytes(bytes: Uint8Array): void;
  stdinBytes(): AsyncIterable<Uint8Array>;
}

async function* noBytes(): AsyncGenerator<Uint8Array> {}

function io(stdin: AsyncIterable<Uint8Array> = noBytes()): Io {
  const sink: Io = {
    out: "",
    err: "",
    stdout(text) {
      sink.out += text;
    },
    stderr(text) {
      sink.err += text;
    },
    stdoutBytes() {},
    stdinBytes: () => stdin,
  };
  return sink;
}

async function* lines(rows: string[]): AsyncGenerator<string> {
  for (const row of rows) yield row;
}

/** Bytes an SSH client writes, read by `ssh-proxy` as they arrive. */
function byteQueue() {
  const chunks: Uint8Array[] = [];
  let finished = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  return {
    push(chunk: Uint8Array) {
      chunks.push(chunk);
      notify();
    },
    end() {
      finished = true;
      notify();
    },
    async *read(): AsyncGenerator<Uint8Array> {
      for (;;) {
        const next = chunks.shift();
        if (next) yield next;
        else if (finished) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}

function serve() {
  const { app, runtime } = createTestApp({ labelPrefix: "mbtest" });
  const keys = app.hosts.get().keys;
  runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  const ctx: OperationContext = {
    host: app.hosts.get(),
    principal: OWNER,
    source: "rest",
    events: app.events,
    tokens: app.tokens,
    execs: app.execs,
  };
  const server = startServer(app);
  const env = { MINIBOX_URL: `http://127.0.0.1:${server.port}`, MINIBOX_ACCESS_KEY: TEST_KEY };
  return {
    app,
    runtime,
    ctx,
    env,
    stop: () => {
      server.stop(true);
      app.throttle.stop();
    },
  };
}

describe("CLI", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("help and unknown commands exit 2 without a server", async () => {
    const help = io();
    expect(await runCli(["--help"], {}, help, lines([]))).toBe(2);
    expect(help.err).toContain("minibox exec");
    expect(help.err).toContain("minibox box ls");
    const missing = io();
    expect(await runCli(["box", "ls"], {}, missing, lines([]))).toBe(2);
    expect(missing.err).toContain("MINIBOX_ACCESS_KEY");
    const unknown = io();
    expect(await runCli(["nope"], { MINIBOX_ACCESS_KEY: "x" }, unknown, lines([]))).toBe(2);
  });

  test("box ls and exec print the server's answer and keep the command's exit code", async () => {
    const env = serve();
    try {
      await env.app.operations.run("box.create", env.ctx, { name: "alpha", cpus: 1, memoryMb: 256 });
      const listed = io();
      expect(await runCli(["box", "ls"], env.env, listed, lines([]))).toBe(0);
      expect(listed.out).toContain("alpha");
      expect(listed.out).toContain("NAME");

      env.runtime.execScript = { stdout: "hello\n", stderr: "warn\n", code: 3 };
      const ran = io();
      expect(
        await runCli(
          ["exec", "alpha", "--cwd", "/workspace", "--user", "dev", "--", "echo", "hi"],
          env.env,
          ran,
          lines([]),
        ),
      ).toBe(3);
      expect(ran.out).toBe("hello\n");
      expect(ran.err).toBe("warn\n");
      expect(env.runtime.execs.at(-1)?.spec).toMatchObject({
        cmd: ["echo", "hi"],
        user: "dev",
        workingDir: "/workspace",
        tty: false,
      });

      env.runtime.execScript = null;
      const background = io();
      expect(
        await runCli(
          ["exec", "alpha", "--background", "--timeout", "30", "--", "sleep", "30"],
          env.env,
          background,
          lines([]),
        ),
      ).toBe(0);
      expect(background.out.trim()).toMatch(/^ex_[0-9A-HJKMNP-TV-Z]{26}$/);
    } finally {
      env.stop();
    }
  });

  test("mcp proxies a JSON-RPC line and remembers the session", async () => {
    const env = serve();
    try {
      const sink = io();
      const code = await runCli(
        ["mcp", "--toolsets", "core"],
        env.env,
        sink,
        lines([
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {} },
          }),
          JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        ]),
      );
      expect(code).toBe(0);
      expect(sink.out).toContain("minibox");
      expect(sink.out).toContain("protocolVersion");
    } finally {
      env.stop();
    }
  });

  test("session commands start, read, send, list and close a tmux session", async () => {
    const env = serve();
    try {
      await env.app.operations.run("box.create", env.ctx, { name: "alpha", cpus: 1, memoryMb: 256 });
      const started = io();
      expect(await runCli(["session", "start", "alpha", "work"], env.env, started, lines([]))).toBe(0);
      expect(started.out).toBe("work\n");

      expect(await runCli(["session", "send", "alpha", "work", "--text", "echo hi\n"], env.env, io(), lines([]))).toBe(
        0,
      );
      expect(
        await runCli(
          ["session", "send", "alpha", "work", "--key", "Escape", "--key", "Enter"],
          env.env,
          io(),
          lines([]),
        ),
      ).toBe(0);

      const read = io();
      expect(await runCli(["session", "read", "alpha", "work", "--lines", "5"], env.env, read, lines([]))).toBe(0);
      expect(read.out).toBe("echo hi\n");
      expect(read.err).toMatch(/^cursor [0-9a-f]{12}\.\d+\n$/);

      const listed = io();
      expect(await runCli(["session", "ls", "alpha"], env.env, listed, lines([]))).toBe(0);
      expect(listed.out).toContain("work  agent  agent  0");

      const closed = io();
      expect(await runCli(["session", "close", "alpha", "work"], env.env, closed, lines([]))).toBe(0);
      expect(closed.out).toBe("work\n");
      const gone = io();
      expect(await runCli(["session", "read", "alpha", "work"], env.env, gone, lines([]))).toBe(1);
      expect(gone.err).toContain("Session not found.");
    } finally {
      env.stop();
    }
  });

  test("a send to a session a person has taken over fails with its hint, and a read still works", async () => {
    const env = serve();
    try {
      const created = (await env.app.operations.run("box.create", env.ctx, {
        name: "alpha",
        cpus: 1,
        memoryMb: 256,
      })) as { box: { id: string } };
      const host = env.app.hosts.get();
      await env.app.terminals.start(host, await getBox(host, created.box.id), "desk", "ui");

      const refused = io();
      expect(await runCli(["session", "send", "alpha", "desk", "--key", "Enter"], env.env, refused, lines([]))).toBe(1);
      expect(refused.err).toContain("under human control");
      expect(refused.err).toContain("try again");

      const read = io();
      expect(await runCli(["session", "read", "alpha", "desk"], env.env, read, lines([]))).toBe(0);
      expect(read.err).toMatch(/^cursor /);
    } finally {
      env.stop();
    }
  });

  test("session usage errors exit 2 without calling the server", async () => {
    const env = { MINIBOX_URL: "http://127.0.0.1:9", MINIBOX_ACCESS_KEY: TEST_KEY };
    const cases: string[][] = [
      ["session"],
      ["session", "frobnicate", "alpha"],
      ["session", "ls"],
      ["session", "start", "alpha"],
      ["session", "read", "alpha", "work", "--lines"],
      ["session", "read", "alpha", "work", "--color", "red"],
      ["session", "send", "alpha", "work"],
      ["session", "send", "alpha", "work", "--text", "x", "--key", "Enter"],
      ["session", "send", "alpha", "work", "--text", "x", "--text", "y"],
    ];
    for (const argv of cases) {
      const sink = io();
      expect({ argv, code: await runCli(argv, env, sink, lines([])) }).toEqual({ argv, code: 2 });
      expect(sink.err.length).toBeGreaterThan(0);
    }
  });
});

describe("CLI SSH commands", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("ssh-proxy and ssh-config reject a missing or extra argument before they reach the server", async () => {
    const env = { MINIBOX_URL: "http://127.0.0.1:9", MINIBOX_ACCESS_KEY: TEST_KEY };
    for (const argv of [
      ["ssh-proxy"],
      ["ssh-proxy", "--append"],
      ["ssh-proxy", "alpha", "beta"],
      ["ssh-proxy", ".minibox"],
    ]) {
      const sink = io();
      expect({ argv, code: await runCli(argv, env, sink, lines([])) }).toEqual({ argv, code: 2 });
      expect(sink.err).toContain("ssh-proxy needs one box name");
    }
    const unknown = io();
    expect(await runCli(["ssh-config", "--force"], env, unknown, lines([]))).toBe(2);
    expect(unknown.err).toContain("Unknown option --force");
  });

  test("ssh-config prints the managed block and the host key it pins", async () => {
    const env = serve();
    try {
      const printed = io();
      expect(await runCli(["ssh-config"], env.env, printed, lines([]))).toBe(0);
      expect(printed.out).toContain("Host *.minibox\n  User dev\n  ProxyCommand minibox ssh-proxy %h\n");
      expect(printed.out).toContain("StrictHostKeyChecking yes");
      expect(printed.out).toContain(`*.minibox ${env.app.ssh.hostKeyView().publicKey}`);
    } finally {
      env.stop();
    }
  });

  test("ssh-config --append puts its block above the user's config, pins the key, and rewrites its own block", async () => {
    const env = serve();
    const home = mkdtempSync(join(tmpdir(), "minibox-home-"));
    try {
      const sshDir = join(home, ".ssh");
      mkdirSync(sshDir);
      writeFileSync(join(sshDir, "config"), "Host github.com\n  User git\n");
      const homeEnv = { ...env.env, HOME: home };
      const first = io();
      expect(await runCli(["ssh-config", "--append"], homeEnv, first, lines([]))).toBe(0);
      expect(first.out).toContain(`Pinned ${env.app.ssh.hostKeyView().fingerprint}`);
      expect(await runCli(["ssh-config", "--append"], homeEnv, io(), lines([]))).toBe(0);

      const config = readFileSync(join(sshDir, "config"), "utf8");
      expect(config.startsWith("# BEGIN minibox ssh-config\nHost *.minibox\n")).toBe(true);
      expect(config.split("# BEGIN minibox ssh-config")).toHaveLength(2);
      expect(config.endsWith("\nHost github.com\n  User git\n")).toBe(true);
      expect(readFileSync(join(sshDir, "minibox_known_hosts"), "utf8")).toBe(
        `*.minibox ${env.app.ssh.hostKeyView().publicKey}\n`,
      );

      const fresh = mkdtempSync(join(tmpdir(), "minibox-home-"));
      try {
        expect(await runCli(["ssh-config", "--append"], { ...env.env, HOME: fresh }, io(), lines([]))).toBe(0);
        expect(statSync(join(fresh, ".ssh")).mode & 0o777).toBe(0o700);
        expect(statSync(join(fresh, ".ssh", "config")).mode & 0o777).toBe(0o600);
        expect(statSync(join(fresh, ".ssh", "minibox_known_hosts")).mode & 0o777).toBe(0o600);
      } finally {
        rmSync(fresh, { recursive: true, force: true });
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      env.stop();
    }
  });

  test("ssh-config tells a token without box:ssh what it needs", async () => {
    const env = serve();
    try {
      const sandbox = mint(env.app, { name: "sandbox", preset: "sandboxed-agent", boxes: { type: "all" } });
      const refused = io();
      expect(await runCli(["ssh-config"], { ...env.env, MINIBOX_ACCESS_KEY: sandbox.secret }, refused, lines([]))).toBe(
        1,
      );
      expect(refused.err).toContain("A token needs the box:ssh scope to set up SSH.");
    } finally {
      env.stop();
    }
  });

  test("ssh-proxy prints the server's refusal and does not open the WebSocket", async () => {
    const env = serve();
    try {
      await env.app.operations.run("box.create", env.ctx, { name: "alpha", cpus: 1, memoryMb: 256 });
      const ops = mint(env.app, { name: "ops", scopes: ["box:ssh"] });
      const refused = io();
      const code = await runCli(
        ["ssh-proxy", "alpha.minibox"],
        { ...env.env, MINIBOX_ACCESS_KEY: ops.secret },
        refused,
        lines([]),
      );
      expect(code).toBe(1);
      expect(refused.err).toContain("This credential cannot use that box.");
      expect(env.runtime.execs).toHaveLength(0);
    } finally {
      env.stop();
    }
  });

  test("ssh-proxy carries an SSH client to the box: an exec runs as dev and its status comes back", async () => {
    const env = serve();
    const upstream = byteQueue();
    const transport = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        upstream.push(chunk);
        callback();
      },
      final(callback) {
        upstream.end();
        callback();
      },
      destroy(error, callback) {
        upstream.end();
        callback(error);
      },
    });
    try {
      await env.app.operations.run("box.create", env.ctx, { name: "alpha", cpus: 1, memoryMb: 256 });
      env.runtime.execScript = { stdout: "over the proxy\n", stderr: "", code: 4 };
      const proxyIo = io(upstream.read());
      proxyIo.stdoutBytes = (bytes) => transport.push(Buffer.from(bytes));
      const proxied = runCli(["ssh-proxy", "alpha.minibox"], env.env, proxyIo, lines([]));

      const client = new Client();
      const ready = new Promise<void>((resolve, reject) => {
        client.once("ready", resolve);
        client.once("error", reject);
      });
      client.connect({
        sock: transport,
        username: "dev",
        hostVerifier: (key: Buffer) => fingerprintOf(key) === env.app.ssh.hostKeyView().fingerprint,
      });
      await ready;
      expect(await runCommand(client, "echo hi")).toEqual({ stdout: "over the proxy\n", stderr: "", code: 4 });
      expect(env.runtime.execs.at(-1)?.spec.user).toBe("dev");
      client.end();
      expect(await proxied).toBe(0);
    } finally {
      env.stop();
    }
  });
});
