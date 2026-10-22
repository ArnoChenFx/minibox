import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";

import { Client } from "ssh2";

import { isNewerVersion, runCli } from "../src/cli";
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

  test("help exits 0 on stdout, while a bare command or an unknown one exits 2 on stderr", async () => {
    const help = io();
    expect(await runCli(["--help"], {}, help, lines([]))).toBe(0);
    expect(help.out).toContain("minibox exec");
    expect(help.out).toContain("minibox box ls");
    expect(help.err).toBe("");
    const bare = io();
    expect(await runCli([], {}, bare, lines([]))).toBe(2);
    expect(bare.err).toContain("minibox exec");
    expect(bare.out).toBe("");
    const missing = io();
    expect(await runCli(["box", "ls"], {}, missing, lines([]))).toBe(2);
    expect(missing.err).toContain("MINIBOX_ACCESS_KEY");
    const unknown = io();
    expect(await runCli(["nope"], { MINIBOX_ACCESS_KEY: "x" }, unknown, lines([]))).toBe(2);
  });

  test("--version reports the build it came from, and dev when it runs from source", async () => {
    const fromSource = io();
    expect(await runCli(["--version"], {}, fromSource, lines([]))).toBe(0);
    expect(fromSource.out).toBe("minibox dev\n");
    for (const flag of ["version", "-v"]) {
      const built = io();
      expect(await runCli([flag], {}, built, lines([]), "0.3.0-62-gef442f5")).toBe(0);
      expect(built.out).toBe("minibox 0.3.0-62-gef442f5\n");
      expect(built.err).toBe("");
    }
  });

  test("every command takes --help, which exits 0 before it needs a key or reaches the server", async () => {
    const sink = io();
    expect(await runCli(["ssh-config", "--help"], { MINIBOX_URL: "http://127.0.0.1:9" }, sink, lines([]))).toBe(0);
    expect(sink.out).toContain("minibox ssh-config [--append]");
    expect(sink.err).toBe("");
  });

  test("--help after -- is the box command's argument, not the CLI's", async () => {
    const env = serve();
    try {
      await env.app.operations.run("box.create", env.ctx, { name: "alpha", cpus: 1, memoryMb: 256 });
      env.runtime.execScript = { stdout: "npm usage\n", stderr: "", code: 0 };
      const ran = io();
      expect(await runCli(["exec", "alpha", "--", "npm", "--help"], env.env, ran, lines([]))).toBe(0);
      expect(ran.out).toBe("npm usage\n");
      expect(env.runtime.execs.at(-1)?.spec.cmd).toEqual(["npm", "--help"]);
      const asked = io();
      expect(await runCli(["exec", "alpha", "--help"], env.env, asked, lines([]))).toBe(0);
      expect(asked.out).toContain("minibox exec");
    } finally {
      env.stop();
    }
  });

  test("isNewerVersion compares release and git-describe builds, and never guesses about a dev build", () => {
    expect(isNewerVersion("0.4.0", "0.3.0")).toBe(true);
    expect(isNewerVersion("0.10.0", "0.9.0")).toBe(true);
    expect(isNewerVersion("0.3.0", "0.3.0")).toBe(false);
    expect(isNewerVersion("0.3.0", "0.4.0")).toBe(false);
    expect(isNewerVersion("0.3.0-62-gef442f5", "0.3.0")).toBe(true);
    expect(isNewerVersion("0.3.0", "0.3.0-62-gef442f5")).toBe(false);
    expect(isNewerVersion("0.3.0-62-gef442f5-dirty", "0.3.0-61-gabc1234")).toBe(true);
    expect(isNewerVersion("0.3.1", "0.3.0-62-gef442f5")).toBe(true);
    expect(isNewerVersion("0.4.0", "dev")).toBe(false);
    expect(isNewerVersion("dev", "0.3.0")).toBe(false);
  });

  test("the SSH probe names the server's version, and ssh-proxy warns once when the server is newer", async () => {
    const env = serve();
    try {
      await env.app.operations.run("box.create", env.ctx, { name: "alpha", cpus: 1, memoryMb: 256 });
      const ops = mint(env.app, { name: "ops", scopes: ["box:ssh"], boxes: { type: "all" } });
      const probe = await fetch(`${env.env.MINIBOX_URL}/api/ssh/alpha`, {
        headers: { authorization: `Bearer ${ops.secret}` },
      });
      expect(probe.status).toBe(204);
      expect(probe.headers.get("x-minibox-version")).toBe("0.0.0-test");

      env.app.version = "0.4.0";
      const newer = io();
      await runCli(
        ["ssh-proxy", "alpha.minibox"],
        { ...env.env, MINIBOX_ACCESS_KEY: ops.secret },
        newer,
        lines([]),
        "0.3.0",
      );
      expect(newer.err.match(/newer than this CLI \(0\.3\.0\)/g)).toHaveLength(1);
      expect(newer.err).toContain(`Update it with: curl -fsSL ${env.env.MINIBOX_URL}/cli/install.sh | sh`);

      const same = io();
      await runCli(
        ["ssh-proxy", "alpha.minibox"],
        { ...env.env, MINIBOX_ACCESS_KEY: ops.secret },
        same,
        lines([]),
        "0.4.0",
      );
      expect(same.err).not.toContain("newer than this CLI");
    } finally {
      env.stop();
    }
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
      expect(config).toContain(`  UserKnownHostsFile "${join(sshDir, "minibox_known_hosts")}"\n`);
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
        const saved = join(fresh, ".config", "minibox", "ssh-credentials.json");
        expect(statSync(saved).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(saved, "utf8"))).toEqual({
          url: env.env.MINIBOX_URL,
          key: env.env.MINIBOX_ACCESS_KEY,
        });
        // ssh starts the ProxyCommand without the shell's exports, so ssh-proxy falls back to the saved credentials.
        const proxied = io();
        expect(await runCli(["ssh-proxy", "missing.minibox"], { HOME: fresh }, proxied, lines([]))).toBe(1);
        expect(proxied.err).not.toContain("Set MINIBOX_ACCESS_KEY");
        expect(proxied.err).toContain("Box not found");
      } finally {
        rmSync(fresh, { recursive: true, force: true });
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      env.stop();
    }
  });

  test("ssh-config --url and --token save the server and key without exported variables, and override them", async () => {
    const env = serve();
    const home = mkdtempSync(join(tmpdir(), "minibox-home-"));
    try {
      const saved = io();
      const flags = ["ssh-config", "--append", "--url", `${env.env.MINIBOX_URL}/`, "--token", TEST_KEY];
      expect(await runCli(flags, { HOME: home }, saved, lines([]))).toBe(0);
      expect(saved.out).toContain(`Pinned ${env.app.ssh.hostKeyView().fingerprint}`);
      expect(JSON.parse(readFileSync(join(home, ".config", "minibox", "ssh-credentials.json"), "utf8"))).toEqual({
        url: env.env.MINIBOX_URL,
        key: TEST_KEY,
      });

      const overridden = io();
      const stale = { HOME: home, MINIBOX_URL: "http://127.0.0.1:9", MINIBOX_ACCESS_KEY: "stale" };
      expect(
        await runCli(["ssh-config", "--url", env.env.MINIBOX_URL, "--token", TEST_KEY], stale, overridden, lines([])),
      ).toBe(0);
      expect(overridden.out).toContain(`*.minibox ${env.app.ssh.hostKeyView().publicKey}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
      env.stop();
    }
  });

  test("ssh-config --url needs an http or https address, and each flag needs its value", async () => {
    const env = { MINIBOX_URL: "http://127.0.0.1:9", MINIBOX_ACCESS_KEY: TEST_KEY };
    for (const [argv, message] of [
      [["ssh-config", "--url", "minibox.example"], "--url needs an http:// or https:// address, not minibox.example"],
      [
        ["ssh-config", "--url", "ftp://minibox.example"],
        "--url needs an http:// or https:// address, not ftp://minibox.example",
      ],
      [["ssh-config", "--url"], "--url needs a value"],
      [["ssh-config", "--token", "--append"], "--token needs a value"],
    ] as const) {
      const sink = io();
      expect(await runCli([...argv], env, sink, lines([]))).toBe(2);
      expect(sink.err).toContain(message);
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
