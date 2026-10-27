import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { gunzipSync } from "node:zlib";

import { Client } from "ssh2";

import { createApp } from "../src/app";
import { isNewerVersion, runCli } from "../src/cli";
import type { Config } from "../src/config";
import type { OperationContext, Principal } from "../src/operations/types";
import type { HelperSpec } from "../src/runtime";
import { startServer } from "../src/server";
import { getBox } from "../src/services/boxes";
import { parseTar } from "../src/services/files-tar";
import { createVolume } from "../src/services/volumes";
import { compileToken } from "../src/tokens/model";
import { createTestApp, silenceLogs, TEST_KEY, testConfig } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";
import { FakeCheckpointEngine } from "./support/fake-snapshots";
import { fingerprintOf, runCommand } from "./support/ssh";
import { call, mint } from "./support/tokens";

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

async function* bytesOf(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
}

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

function serve(overrides: Partial<Config> = {}) {
  const { app, runtime } = createTestApp({ labelPrefix: "mbtest", ...overrides });
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
    expect(help.out).toContain("minibox box startup-command set <box> (--command TEXT | --stdin) [--apply] [--json]");
    expect(help.out).toContain("[--self-token]");
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
    const env = serve({ mcpAllowOwnerKey: true });
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

  describe("owner access key and token create", () => {
    const initLine = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    });

    test("mcp warns once on stderr when it runs on the owner access key", async () => {
      const env = serve({ mcpAllowOwnerKey: true });
      try {
        const sink = io();
        expect(await runCli(["mcp"], env.env, sink, lines([initLine, initLine]))).toBe(0);
        expect(sink.err.match(/owner access key/g)).toHaveLength(1);
        expect(sink.err).toContain("minibox token create <name>");
      } finally {
        env.stop();
      }
    });

    test("mcp stays quiet on stderr when it runs on an agent token", async () => {
      const env = serve();
      try {
        const { secret } = mint(env.app, { name: "agent", preset: "sandboxed-agent" });
        const sink = io();
        expect(await runCli(["mcp"], { ...env.env, MINIBOX_ACCESS_KEY: secret }, sink, lines([initLine]))).toBe(0);
        expect(sink.err).toBe("");
        expect(sink.out).toContain("protocolVersion");
      } finally {
        env.stop();
      }
    });

    test("mcp exits 1 with the refusal and a token-create hint, by default", async () => {
      const env = serve();
      try {
        const sink = io();
        expect(await runCli(["mcp"], env.env, sink, lines([initLine]))).toBe(1);
        expect(sink.err).toContain(
          "the server refuses the owner access key on /mcp, because MCP_ALLOW_OWNER_KEY is false",
        );
        expect(sink.err).toContain("The owner access key is not accepted on /mcp. Use an agent token.");
        expect(sink.err).toContain("minibox token create <name>");
        expect(sink.err).not.toContain("owner access key, and the server accepts it");
      } finally {
        env.stop();
      }
    });

    test("token create prints the secret once on stdout, and the summary on stderr", async () => {
      const env = serve();
      try {
        const out = io();
        expect(await runCli(["token", "create", "agent-one"], env.env, out, lines([]))).toBe(0);
        const secret = out.out.trim();
        expect(secret).toMatch(/^mbx_/);
        expect(out.err).toContain("Created token agent-one");
        expect(out.err).not.toContain(secret);
        expect(env.app.tokens.authenticate(secret, "127.0.0.1")).toMatchObject({ type: "token" });
        expect(env.app.tokens.list().find((record) => record.name === "agent-one")).toMatchObject({
          preset: "sandboxed-agent",
          expiresAt: null,
        });
      } finally {
        env.stop();
      }
    });

    test("token create takes a preset, a scope list, an expiry, and --json", async () => {
      const env = serve();
      try {
        const json = io();
        const args = ["token", "create", "reader", "--preset", "readonly", "--expires-in", "3600", "--json"];
        expect(await runCli(args, env.env, json, lines([]))).toBe(0);
        const body = JSON.parse(json.out) as {
          token: string;
          record: { name: string; preset: string; expiresAt: string };
        };
        expect(body.token).toMatch(/^mbx_/);
        expect(body.record).toMatchObject({ name: "reader", preset: "readonly" });
        expect(Date.parse(body.record.expiresAt) - Date.now()).toBeGreaterThan(3500 * 1000);

        const scoped = io();
        expect(
          await runCli(["token", "create", "scoped", "--scopes", "box:read,exec"], env.env, scoped, lines([])),
        ).toBe(0);
        const record = env.app.tokens.list().find((item) => item.name === "scoped");
        expect(record?.preset).toBeNull();
        expect([...(record?.scopes ?? [])].toSorted()).toEqual(["box:read", "exec"]);
      } finally {
        env.stop();
      }
    });

    test("token delete removes an ended token's record and refuses a live one; token prune removes them all", async () => {
      const env = serve();
      try {
        const live = env.app.tokens.create(compileToken({ name: "live", preset: "readonly" }), "owner").record;
        const ended = env.app.tokens.create(compileToken({ name: "ended", preset: "readonly" }), "owner").record;
        const also = env.app.tokens.create(compileToken({ name: "also", preset: "readonly" }), "owner").record;
        env.app.tokens.revoke(ended.id);
        env.app.tokens.revoke(also.id);

        const refused = io();
        expect(await runCli(["token", "delete", live.id], env.env, refused, lines([]))).toBe(1);
        expect(refused.err).toContain("still live");
        expect(env.app.tokens.list()).toHaveLength(3);

        const removed = io();
        expect(await runCli(["token", "delete", ended.id], env.env, removed, lines([]))).toBe(0);
        expect(removed.out).toContain(`Deleted token ended (${ended.id})`);

        const missing = io();
        expect(await runCli(["token", "delete", ended.id], env.env, missing, lines([]))).toBe(1);
        const noId = io();
        expect(await runCli(["token", "delete"], env.env, noId, lines([]))).toBe(2);
        expect(noId.err).toContain("needs exactly one token id");

        const pruned = io();
        expect(await runCli(["token", "prune"], env.env, pruned, lines([]))).toBe(0);
        expect(pruned.out).toContain(`Deleted token also (${also.id})`);
        expect(pruned.out).toContain("1 deleted");
        expect(env.app.tokens.list().map((token) => token.name)).toEqual(["live"]);

        const none = io();
        expect(await runCli(["token", "prune", "--json"], env.env, none, lines([]))).toBe(0);
        expect(JSON.parse(none.out)).toEqual({ deleted: [] });
      } finally {
        env.stop();
      }
    });

    test("token create refuses a missing name, a bad expiry and an unknown preset, and creates nothing", async () => {
      const env = serve();
      try {
        const bare = io();
        expect(await runCli(["token"], env.env, bare, lines([]))).toBe(2);
        expect(bare.err).toContain("minibox token needs create");

        const noName = io();
        expect(await runCli(["token", "create"], env.env, noName, lines([]))).toBe(2);
        expect(noName.err).toContain("needs exactly one name");

        const soon = io();
        expect(await runCli(["token", "create", "x", "--expires-in", "soon"], env.env, soon, lines([]))).toBe(2);
        expect(soon.err).toContain("--expires-in needs a number");

        const unknown = io();
        expect(await runCli(["token", "create", "x", "--preset", "root"], env.env, unknown, lines([]))).toBe(1);
        expect(unknown.err).not.toBe("");
        expect(env.app.tokens.list()).toEqual([]);
      } finally {
        env.stop();
      }
    });

    test("help lists token create", async () => {
      const help = io();
      expect(await runCli(["token", "--help"], {}, help, lines([]))).toBe(0);
      expect(help.out).toContain("minibox token create <name>");
    });
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

  test("tool custom put, list and delete manage tools.d, and a refused entry writes nothing", async () => {
    const env = serve();
    try {
      const entry = {
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
      const file = join(mkdtempSync(join(tmpdir(), "mb-cli-tool-")), "sample.json");
      writeFileSync(file, JSON.stringify(entry));
      const toolsDir = join(env.app.cfg.dataDir, "tools.d");

      const saved = io();
      expect(await runCli(["tool", "custom", "put", "sample-tool", "--file", file], env.env, saved, lines([]))).toBe(0);
      expect(saved.out).toBe("sample-tool\n");
      expect(JSON.parse(readFileSync(join(toolsDir, "sample-tool.json"), "utf8"))).toMatchObject({
        id: "sample-tool",
        category: "agents",
        needsRoot: false,
      });

      const piped = io(bytesOf(JSON.stringify({ ...entry, name: "Piped" })));
      expect(await runCli(["tool", "custom", "put", "sample-tool", "--stdin"], env.env, piped, lines([]))).toBe(0);
      const listed = io();
      expect(await runCli(["tool", "custom", "list"], env.env, listed, lines([]))).toBe(0);
      expect(listed.out).toContain("sample-tool  Piped  npm  sample-tool  sample-tool  false");

      const refused = io(bytesOf(JSON.stringify(entry)));
      expect(await runCli(["tool", "custom", "put", "uv", "--stdin"], env.env, refused, lines([]))).toBe(1);
      expect(refused.err).toContain("built-in tool");
      expect(existsSync(join(toolsDir, "uv.json"))).toBe(false);

      const replaced = io(bytesOf(JSON.stringify(entry)));
      expect(
        await runCli(
          ["tool", "custom", "put", "uv", "--stdin", "--override-builtin", "--json"],
          env.env,
          replaced,
          lines([]),
        ),
      ).toBe(0);
      expect(JSON.parse(replaced.out)).toMatchObject({ tool: { id: "uv", overridesBuiltin: true } });

      const removed = io();
      expect(await runCli(["tool", "custom", "delete", "uv", "--json"], env.env, removed, lines([]))).toBe(0);
      expect(JSON.parse(removed.out)).toEqual({ id: "uv", restoredBuiltin: true });

      const deleted = io();
      expect(await runCli(["tool", "custom", "delete", "sample-tool"], env.env, deleted, lines([]))).toBe(0);
      expect(deleted.out).toBe("sample-tool\n");
      const gone = io();
      expect(await runCli(["tool", "custom", "delete", "sample-tool"], env.env, gone, lines([]))).toBe(1);
      expect(gone.err).toContain("No custom tool");
      const empty = io();
      expect(await runCli(["tool", "custom", "list"], env.env, empty, lines([]))).toBe(0);
      expect(empty.out).toBe("ID  NAME  SOURCE  PACKAGE  BIN  REPLACES BUILT-IN\n");
    } finally {
      env.stop();
    }
  });

  test("tool custom usage errors exit 2 without calling the server", async () => {
    const env = { MINIBOX_URL: "http://127.0.0.1:9", MINIBOX_ACCESS_KEY: TEST_KEY };
    const cases: string[][] = [
      ["tool"],
      ["tool", "install", "claude-code"],
      ["tool", "custom"],
      ["tool", "custom", "frobnicate"],
      ["tool", "custom", "list", "extra"],
      ["tool", "custom", "put", "sample-tool"],
      ["tool", "custom", "put", "--stdin"],
      ["tool", "custom", "put", "sample-tool", "--stdin", "--file", "entry.json"],
      ["tool", "custom", "put", "sample-tool", "--file"],
      ["tool", "custom", "put", "--file", "entry.json"],
      ["tool", "custom", "delete"],
      ["tool", "custom", "delete", "sample-tool", "--stdin"],
      ["tool", "custom", "delete", "sample-tool", "--color", "red"],
    ];
    for (const argv of cases) {
      const sink = io(bytesOf("{}"));
      expect({ argv, code: await runCli(argv, env, sink, lines([])) }).toEqual({ argv, code: 2 });
      expect(sink.err.length).toBeGreaterThan(0);
    }
  });
});

async function settleTasks(env: ReturnType<typeof serve>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const res = await fetch(`${env.env.MINIBOX_URL}/api/tasks?status=running`, {
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    const body = (await res.json()) as { tasks: unknown[] };
    if (body.tasks.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("CLI box create and startup command", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("box create takes the egress tier with its presets and domains, and the box reports them", async () => {
    const env = serve();
    try {
      const sealed = io();
      expect(await runCli(["box", "create", "sealed", "--egress", "none"], env.env, sealed, lines([]))).toBe(0);
      expect(sealed.out).toBe("sealed\n");

      const walled = io();
      const walledArgs = [
        "box",
        "create",
        "walled",
        "--egress",
        "proxy-only",
        "--egress-preset",
        "agent-default",
        "--egress-domain",
        "*.example.org",
        "--egress-domain",
        "example.com",
      ];
      expect(await runCli(walledArgs, env.env, walled, lines([]))).toBe(0);

      const boxes = (await env.app.operations.run("box.list", env.ctx, {})) as { boxes: { name: string }[] };
      expect(boxes.boxes.map((box) => box.name).toSorted()).toEqual(["sealed", "walled"]);
      const walledBox = (await env.app.operations.run("box.get", env.ctx, { id: "walled" })) as {
        box: { egress?: { mode: string; presets: string[]; domains: string[] } };
      };
      expect(walledBox.box.egress).toMatchObject({
        mode: "proxy-only",
        presets: ["agent-default"],
        domains: ["*.example.org", "example.com"],
      });
      const sealedBox = (await env.app.operations.run("box.get", env.ctx, { id: "sealed" })) as {
        box: { egress?: unknown };
      };
      expect(sealedBox.box.egress).toEqual({ mode: "none", presets: [], domains: [], allow: [] });
    } finally {
      env.stop();
    }
  });

  test("box create --self-token gives the box a self token, and a box created without the flag has none", async () => {
    const env = serve();
    try {
      const withToken = io();
      expect(await runCli(["box", "create", "delta", "--self-token", "--json"], env.env, withToken, lines([]))).toBe(0);
      expect(JSON.parse(withToken.out)).toMatchObject({ box: { name: "delta", selfToken: true } });

      const plain = io();
      expect(await runCli(["box", "create", "epsilon"], env.env, plain, lines([]))).toBe(0);
      const epsilon = (await env.app.operations.run("box.get", env.ctx, { id: "epsilon" })) as {
        box: { selfToken?: boolean };
      };
      expect(epsilon.box.selfToken).toBeFalsy();
    } finally {
      env.stop();
    }
  });

  test("box create takes the startup command from a flag or stdin, and get reads it back as typed", async () => {
    const env = serve();
    try {
      const created = io();
      expect(
        await runCli(
          ["box", "create", "alpha", "--cpus", "0.5", "--memory", "256", "--startup-command", "npm run dev"],
          env.env,
          created,
          lines([]),
        ),
      ).toBe(0);
      expect(created.out).toBe("alpha\n");
      const alpha = (await env.app.operations.run("box.get", env.ctx, { id: "alpha" })) as { box: { cpus: number } };
      expect(alpha.box.cpus).toBe(0.5);

      const piped = io(bytesOf("echo from-stdin\n"));
      expect(
        await runCli(["box", "create", "beta", "--startup-command-stdin", "--json"], env.env, piped, lines([])),
      ).toBe(0);
      expect(JSON.parse(piped.out)).toMatchObject({ box: { name: "beta" } });

      const read = io();
      expect(await runCli(["box", "startup-command", "get", "beta"], env.env, read, lines([]))).toBe(0);
      expect(read.out).toBe("echo from-stdin\n");
      expect(read.err).toMatch(/^status: \w+\n$/);

      const plain = io();
      expect(await runCli(["box", "startup-command", "get", "alpha"], env.env, plain, lines([]))).toBe(0);
      expect(plain.out).toBe("npm run dev\n");

      const bare = io();
      expect(await runCli(["box", "create", "gamma"], env.env, bare, lines([]))).toBe(0);
      const none = io();
      expect(await runCli(["box", "startup-command", "get", "gamma", "--json"], env.env, none, lines([]))).toBe(0);
      expect(JSON.parse(none.out)).toMatchObject({ revision: 1, command: null, status: "none" });
    } finally {
      env.stop();
    }
  });

  test("set, get and rm change the command one revision at a time, and read as the server answers", async () => {
    const env = serve();
    try {
      await env.app.operations.run("box.create", env.ctx, { name: "alpha", cpus: 1, memoryMb: 256 });

      const set = io();
      expect(
        await runCli(["box", "startup-command", "set", "alpha", "--command", "echo one"], env.env, set, lines([])),
      ).toBe(0);
      expect(set.out).toBe("echo one\n");
      expect(set.err).toMatch(/^status: waiting\n$/);

      const replaced = io(bytesOf("echo two\n"));
      expect(
        await runCli(["box", "startup-command", "set", "alpha", "--stdin", "--json"], env.env, replaced, lines([])),
      ).toBe(0);
      expect(JSON.parse(replaced.out)).toMatchObject({ revision: 3, command: "echo two\n", status: "waiting" });

      const removed = io();
      expect(await runCli(["box", "startup-command", "rm", "alpha", "--json"], env.env, removed, lines([]))).toBe(0);
      expect(JSON.parse(removed.out)).toMatchObject({ revision: 4, command: null, status: "none" });

      const gone = io();
      expect(await runCli(["box", "startup-command", "run", "alpha"], env.env, gone, lines([]))).toBe(1);
      expect(gone.err).toContain("No startup command is set on this box.");
    } finally {
      env.stop();
    }
  });

  test("set --apply and run start the command on a running box, and its status reads back", async () => {
    const env = serve();
    try {
      await env.app.operations.run("box.create", env.ctx, { name: "alpha", cpus: 1, memoryMb: 256 });
      const waiting = io();
      expect(
        await runCli(["box", "startup-command", "set", "alpha", "--command", "echo one"], env.env, waiting, lines([])),
      ).toBe(0);
      expect(waiting.err).toBe("status: waiting\n");

      const applied = io();
      expect(
        await runCli(
          ["box", "startup-command", "set", "alpha", "--command", "echo two", "--apply", "--json"],
          env.env,
          applied,
          lines([]),
        ),
      ).toBe(0);
      expect(JSON.parse(applied.out)).toMatchObject({ revision: 3, command: "echo two", status: "running" });

      const ran = io();
      expect(await runCli(["box", "startup-command", "run", "alpha", "--json"], env.env, ran, lines([]))).toBe(0);
      expect(JSON.parse(ran.out)).toMatchObject({ revision: 3, command: "echo two", status: "running" });

      const read = io();
      expect(await runCli(["box", "startup-command", "get", "alpha"], env.env, read, lines([]))).toBe(0);
      expect(read.out).toBe("echo two\n");
      expect(read.err).toBe("status: running\n");
    } finally {
      env.stop();
    }
  });

  test("a stopped box takes a new command, and run says why it cannot start the command", async () => {
    const env = serve();
    try {
      await env.app.operations.run("box.create", env.ctx, { name: "alpha", cpus: 1, memoryMb: 256 });
      await env.app.operations.run("box.action", env.ctx, { id: "alpha", action: "stop" });

      const set = io();
      expect(
        await runCli(
          ["box", "startup-command", "set", "alpha", "--command", "echo later", "--json"],
          env.env,
          set,
          lines([]),
        ),
      ).toBe(0);
      expect(JSON.parse(set.out)).toMatchObject({ command: "echo later", status: "waiting" });

      const stopped = io();
      expect(await runCli(["box", "startup-command", "run", "alpha"], env.env, stopped, lines([]))).toBe(1);
      expect(stopped.err).toContain("The box is stopped, so the startup command cannot run now.");
      expect(stopped.err).toContain("Start the box. The command runs at every start.");
    } finally {
      env.stop();
    }
  });

  test("the server's refusals reach the CLI as its message and exit 1, and a bad template is refused too", async () => {
    const env = serve();
    try {
      const badCpus = io();
      expect(await runCli(["box", "create", "alpha", "--cpus", "lots"], env.env, badCpus, lines([]))).toBe(2);
      expect(badCpus.err).toContain("--cpus needs a number");

      const tooLong = io();
      expect(
        await runCli(["box", "create", "alpha", "--startup-command", "x".repeat(4097)], env.env, tooLong, lines([])),
      ).toBe(1);
      expect(tooLong.err).toContain("The startup command is longer than 4096 bytes.");

      const badTemplate = io();
      expect(await runCli(["box", "create", "alpha", "--template", "bad ref!"], env.env, badTemplate, lines([]))).toBe(
        1,
      );
      expect(badTemplate.err.length).toBeGreaterThan(0);

      const empty = io();
      await env.app.operations.run("box.create", env.ctx, { name: "alpha", cpus: 1, memoryMb: 256 });
      expect(
        await runCli(["box", "startup-command", "set", "alpha", "--command", "   "], env.env, empty, lines([])),
      ).toBe(1);
      expect(empty.err).toContain("The startup command is empty.");
    } finally {
      env.stop();
    }
  });

  test("box create --host-label goes with --host auto only, and the box lands on a host that carries the label", async () => {
    const env = serve();
    try {
      const labelled = io();
      expect(
        await runCli(
          ["host", "labels", "set", "local", "--label", "gpu=true", "--label", "org/arch=amd64"],
          env.env,
          labelled,
          lines([]),
        ),
      ).toBe(0);
      expect(labelled.out).toBe('local {"gpu":"true","org/arch":"amd64"}\n');

      const read = io();
      expect(await runCli(["host", "labels", "get", "local"], env.env, read, lines([]))).toBe(0);
      expect(JSON.parse(read.out)).toEqual({ gpu: "true", "org/arch": "amd64" });

      // An auto create considers only online hosts, and the local host's first check runs here.
      await env.app.hostAdmin.refresh();

      const created = io();
      expect(
        await runCli(
          ["box", "create", "pinned", "--host", "auto", "--host-label", "gpu=true", "--json"],
          env.env,
          created,
          lines([]),
        ),
      ).toBe(0);
      // A control plane with one host names no host on the box, so the container the local engine made is the evidence.
      expect(JSON.parse(created.out).box.name).toBe("pinned");
      expect(env.runtime.callsTo("createContainer")).toHaveLength(1);

      // A key with no value asks for a label whose value is empty, and the host does not carry that one.
      const missing = io();
      expect(
        await runCli(
          ["box", "create", "absent", "--host", "auto", "--host-label", "zone=eu"],
          env.env,
          missing,
          lines([]),
        ),
      ).toBe(1);
      expect(missing.err).toContain("No online host carries every label this create asks for (zone=eu)");

      const cleared = io();
      expect(await runCli(["host", "labels", "set", "local"], env.env, cleared, lines([]))).toBe(0);
      expect(cleared.out).toBe("local {}\n");
    } finally {
      env.stop();
    }
  });

  test("box create and startup-command usage errors exit 2 before any request is sent", async () => {
    const env = { MINIBOX_URL: "http://127.0.0.1:9", MINIBOX_ACCESS_KEY: TEST_KEY };
    const cases: [string[], string][] = [
      [["box", "create"], "minibox box create needs one box name"],
      [["box", "create", "alpha", "beta"], "minibox box create needs one box name"],
      [["box", "create", "alpha", "--startup-command"], "--startup-command needs a value"],
      [
        ["box", "create", "alpha", "--startup-command", "echo", "--startup-command-stdin"],
        "minibox box create takes --startup-command or --startup-command-stdin, not both",
      ],
      [["box", "create", "alpha", "--cpus"], "--cpus needs a value"],
      [
        ["box", "create", "alpha", "--egress-domain", "example.com"],
        "minibox box create takes --egress-preset and --egress-domain only with --egress",
      ],
      [["box", "create", "alpha", "--egress", "none", "--egress-preset"], "--egress-preset needs a value"],
      [["box", "create", "alpha", "--color", "red"], "Unknown option --color"],
      [
        ["box", "create", "alpha", "--host-label", "gpu=true"],
        "minibox box create takes --host-label only with --host auto",
      ],
      [["box", "create", "alpha", "--host", "local", "--host-label"], "--host-label needs a value"],
      [["host", "labels"], "minibox host needs: labels get <id>, or labels set <id> [--label KEY=VALUE]..."],
      [["host", "labels", "get"], "minibox host labels get needs one host id"],
      [["host", "labels", "set", "local", "--label"], "--label needs a value"],
      [["box", "startup-command"], "minibox box startup-command needs one of get, set, rm, run"],
      [["box", "startup-command", "frobnicate", "alpha"], "minibox box startup-command needs one of get, set, rm, run"],
      [["box", "startup-command", "get"], "minibox box startup-command get needs one box name or id"],
      [["box", "startup-command", "get", "alpha", "beta"], "minibox box startup-command get needs one box name or id"],
      [
        ["box", "startup-command", "get", "alpha", "--command", "echo"],
        "minibox box startup-command get takes no --command, --stdin or --apply",
      ],
      [
        ["box", "startup-command", "rm", "alpha", "--stdin"],
        "minibox box startup-command rm takes no --command, --stdin or --apply",
      ],
      [
        ["box", "startup-command", "run", "alpha", "--apply"],
        "minibox box startup-command run takes no --command, --stdin or --apply",
      ],
      [
        ["box", "startup-command", "set", "alpha"],
        "minibox box startup-command set needs exactly one of --command TEXT or --stdin",
      ],
      [
        ["box", "startup-command", "set", "alpha", "--command", "echo", "--stdin"],
        "minibox box startup-command set needs exactly one of --command TEXT or --stdin",
      ],
      [["box", "startup-command", "set", "alpha", "--command"], "--command needs a value"],
    ];
    for (const [argv, message] of cases) {
      const sink = io(bytesOf("echo\n"));
      expect({ argv, code: await runCli(argv, env, sink, lines([])) }).toEqual({ argv, code: 2 });
      expect(sink.err).toContain(message);
    }
  });
});

describe("CLI templates, images and box clones", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("box create with --repo prints the box, follows the clone, and clones the branch with the secret's token", async () => {
    const env = serve();
    try {
      env.app.hosts.get().secrets.set("gh-token", "ghp_cli_secret", "2026-10-22T00:00:00.000Z");
      const clones: HelperSpec[] = [];
      env.runtime.helperHandler = (spec) => {
        if (spec.cmd[2]?.includes("credential.helper=")) {
          clones.push(spec);
          return { exitCode: 0, logs: "Cloning into '/workspace'...\n" };
        }
        return { exitCode: 0, logs: "" };
      };
      const created = io();
      const code = await runCli(
        [
          "box",
          "create",
          "alpha",
          "--repo",
          "https://github.com/org/app.git",
          "--branch",
          "main",
          "--secret",
          "gh-token",
          "--cpus",
          "1",
          "--memory",
          "256",
        ],
        env.env,
        created,
        lines([]),
      );
      expect(code).toBe(0);
      expect(created.out).toBe("alpha\n");
      expect(created.err).toContain("Cloning into '/workspace'");
      expect(created.err).not.toContain("ghp_cli_secret");
      expect(clones).toHaveLength(1);
      expect(clones[0]?.cmd.slice(5, 7)).toEqual(["https://github.com/org/app.git", "main"]);
    } finally {
      env.stop();
    }
  });

  test("a clone that fails keeps the box, names the failure, and exits 1; --no-wait returns before the clone ends", async () => {
    const env = serve();
    try {
      env.runtime.helperHandler = (spec) =>
        spec.cmd[2]?.includes("credential.helper=")
          ? { exitCode: 128, logs: "fatal: repository 'https://github.com/org/missing.git/' not found\n" }
          : { exitCode: 0, logs: "" };
      const failed = io();
      expect(
        await runCli(
          ["box", "create", "beta", "--repo", "https://github.com/org/missing.git"],
          env.env,
          failed,
          lines([]),
        ),
      ).toBe(1);
      expect(failed.out).toBe("beta\n");
      expect(failed.err).toContain("beta was created, but its setup did not finish");
      const listed = io();
      expect(await runCli(["box", "ls"], env.env, listed, lines([]))).toBe(0);
      expect(listed.out).toContain("beta");

      const detached = io();
      expect(
        await runCli(
          ["box", "create", "gamma", "--repo", "https://github.com/org/missing.git", "--no-wait"],
          env.env,
          detached,
          lines([]),
        ),
      ).toBe(0);
      expect(detached.out).toBe("gamma\n");
      expect(detached.err).toMatch(/The setup runs as task [0-9A-HJKMNP-TV-Z]{26}/);
      await settleTasks(env);
    } finally {
      env.stop();
    }
  });

  test("template create reads a Dockerfile from a file or stdin, prints the ref after the build log, and --json prints the task", async () => {
    const env = serve();
    try {
      const file = join(mkdtempSync(join(tmpdir(), "mb-cli-dockerfile-")), "Dockerfile");
      writeFileSync(file, "FROM alpine:3.20\nRUN echo built\n");
      const built = io();
      const code = await runCli(
        ["template", "create", "tool", "--dockerfile", file, "--description", "Build tools"],
        env.env,
        built,
        lines([]),
      );
      expect(code).toBe(0);
      expect(built.out).toBe("mbtest-template:tool\n");
      expect(built.err).toContain("Successfully built");
      expect(env.runtime.builds.at(-1)?.tag).toBe("mbtest-template:tool");

      const piped = io(bytesOf("FROM alpine:3.20\n"));
      expect(
        await runCli(["template", "create", "piped", "--dockerfile", "-", "--json"], env.env, piped, lines([])),
      ).toBe(0);
      expect(JSON.parse(piped.out)).toMatchObject({
        status: "succeeded",
        result: { template: { ref: "mbtest-template:piped", name: "piped" } },
      });
    } finally {
      env.stop();
    }
  });

  test("template rebuild and image pull follow their tasks; a pull the registry refuses exits 1 with its message", async () => {
    const env = serve();
    try {
      const file = join(mkdtempSync(join(tmpdir(), "mb-cli-rebuild-")), "Dockerfile");
      writeFileSync(file, "FROM alpine:3.20\n");
      expect(await runCli(["template", "create", "tool", "--dockerfile", file], env.env, io(), lines([]))).toBe(0);

      const rebuilt = io();
      expect(await runCli(["template", "rebuild", "mbtest-template:tool"], env.env, rebuilt, lines([]))).toBe(0);
      expect(rebuilt.out).toBe("mbtest-template:tool\n");

      const pulled = io();
      expect(await runCli(["image", "pull", "node:24-bookworm-slim"], env.env, pulled, lines([]))).toBe(0);
      expect(pulled.out).toBe("node:24-bookworm-slim\n");
      expect(await env.runtime.inspectImage("node:24-bookworm-slim")).toBeDefined();

      env.runtime.unpullable.add("ghost:latest");
      const refused = io();
      expect(await runCli(["image", "pull", "ghost:latest"], env.env, refused, lines([]))).toBe(1);
      expect(refused.out).toBe("");
      expect(refused.err).toContain("was not found in its registry");
    } finally {
      env.stop();
    }
  });

  test("template fork copies a template under a new name and prints its ref; a taken name exits 1 with the message", async () => {
    const env = serve();
    try {
      const file = join(mkdtempSync(join(tmpdir(), "mb-cli-fork-")), "Dockerfile");
      writeFileSync(file, "FROM alpine:3.20\n");
      expect(await runCli(["template", "create", "tool", "--dockerfile", file], env.env, io(), lines([]))).toBe(0);

      const forked = io();
      expect(
        await runCli(
          ["template", "fork", "mbtest-template:tool", "tool-copy", "--description", "Ours"],
          env.env,
          forked,
          lines([]),
        ),
      ).toBe(0);
      expect(forked.out).toBe("mbtest-template:tool-copy\n");
      expect((await env.runtime.inspectImage("mbtest-template:tool-copy")).labels["mbtest.template.description"]).toBe(
        "Ours",
      );

      const asJson = io();
      expect(await runCli(["template", "fork", "tool", "tool-2", "--json"], env.env, asJson, lines([]))).toBe(0);
      expect(JSON.parse(asJson.out)).toEqual({ template: { ref: "mbtest-template:tool-2", name: "tool-2" } });

      const again = io();
      expect(await runCli(["template", "fork", "tool", "tool-copy"], env.env, again, lines([]))).toBe(1);
      expect(again.out).toBe("");
      expect(again.err).toContain("A template named “tool-copy” already exists.");
    } finally {
      env.stop();
    }
  });

  test("template edit changes the Dockerfile a template rebuilds from, and template get prints what it reads", async () => {
    const env = serve();
    try {
      const dir = mkdtempSync(join(tmpdir(), "mb-cli-edit-"));
      const first = join(dir, "Dockerfile");
      writeFileSync(first, "FROM alpine:3.20\n");
      expect(await runCli(["template", "create", "tool", "--dockerfile", first], env.env, io(), lines([]))).toBe(0);

      const edited = io();
      expect(
        await runCli(
          ["template", "edit", "tool", "--dockerfile", first, "--description", "Ours"],
          env.env,
          edited,
          lines([]),
        ),
      ).toBe(0);
      expect(edited.out).toBe("mbtest-template:tool\n");
      expect(env.runtime.builds).toHaveLength(1);
      expect((await env.runtime.inspectImage("mbtest-template:tool")).labels["mbtest.template.description"]).toBe(
        "Ours",
      );

      const asJson = io();
      expect(
        await runCli(
          ["template", "edit", "mbtest-template:tool", "--forward-port", "3000,8080", "--json"],
          env.env,
          asJson,
          lines([]),
        ),
      ).toBe(0);
      expect(JSON.parse(asJson.out)).toEqual({
        template: { ref: "mbtest-template:tool", name: "tool", buildKind: "dockerfile" },
      });

      const read = io();
      expect(await runCli(["template", "get", "tool", "--json"], env.env, read, lines([]))).toBe(0);
      const recipe = JSON.parse(read.out).recipe;
      expect(recipe.source).toEqual({ kind: "dockerfile", text: "FROM alpine:3.20\n" });
      expect(recipe.forwardPorts).toEqual([3000, 8080]);

      const cleared = io();
      expect(await runCli(["template", "edit", "tool", "--clear-setup", "--json"], env.env, cleared, lines([]))).toBe(
        0,
      );
      const afterClear = io();
      expect(await runCli(["template", "get", "tool", "--json"], env.env, afterClear, lines([]))).toBe(0);
      expect(JSON.parse(afterClear.out).recipe.forwardPorts).toBeUndefined();

      const nothing = io();
      expect(await runCli(["template", "edit", "tool"], env.env, nothing, lines([]))).toBe(1);
      expect(nothing.err).toContain("Nothing to change");
    } finally {
      env.stop();
    }
  });

  test("template build-official builds the official template on a host and prints its ref; a name the host holds is refused", async () => {
    const env = serve();
    try {
      const built = io();
      expect(
        await runCli(["template", "build-official", "minimal", "--host", "local"], env.env, built, lines([])),
      ).toBe(0);
      expect(built.out).toBe("mbtest-template:minimal\n");
      expect(env.runtime.builds.at(-1)?.tag).toBe("mbtest-template:minimal");

      const again = io();
      expect(await runCli(["template", "build-official", "minimal"], env.env, again, lines([]))).toBe(1);
      expect(again.out).toBe("");
      expect(again.err).toContain("A template named “minimal” already exists.");
    } finally {
      env.stop();
    }
  });

  test("the new commands take --help, and their usage errors exit 2 without calling the server", async () => {
    const env = { MINIBOX_URL: "http://127.0.0.1:9", MINIBOX_ACCESS_KEY: TEST_KEY };
    const dir = mkdtempSync(join(tmpdir(), "mb-cli-usage-"));
    const dockerfile = join(dir, "Dockerfile");
    writeFileSync(dockerfile, "FROM alpine:3.20\n");
    const helped = io();
    expect(await runCli(["template", "create", "--help"], env, helped, lines([]))).toBe(0);
    expect(helped.out).toContain("minibox template create");
    const cases: string[][] = [
      ["box", "create"],
      ["box", "create", "alpha", "extra"],
      ["box", "create", "alpha", "--branch", "main"],
      ["box", "create", "alpha", "--cpus", "lots"],
      ["box", "create", "alpha", "--color", "red"],
      ["template"],
      ["template", "frobnicate"],
      ["template", "create", "tool"],
      ["template", "create", "tool", "--dockerfile", dockerfile, "--repo", "https://github.com/org/app.git"],
      ["template", "create", "tool", "--dockerfile", join(dir, "missing")],
      ["template", "create", "tool", "--dockerfile", dockerfile, "--branch", "main"],
      ["template", "create", "tool", "--context", "https://example.com/context.tar", "--branch", "main"],
      ["template", "create", "tool", "--repo", "https://github.com/org/app.git", "--devcontainer-path", "x.json"],
      ["template", "create", "tool", "--repo"],
      ["template", "rebuild"],
      ["template", "rebuild", "a", "b"],
      ["template", "fork"],
      ["template", "fork", "mbtest-template:tool"],
      ["template", "fork", "a", "b", "c"],
      ["template", "edit"],
      ["template", "edit", "a", "b"],
      ["template", "edit", "tool", "--dockerfile", dockerfile, "--repo", "https://github.com/org/app.git"],
      ["template", "edit", "tool", "--branch", "main"],
      ["template", "get"],
      ["template", "build-official"],
      ["template", "build-official", "minimal", "extra"],
      ["image"],
      ["image", "pull"],
      ["image", "pull", "alpine", "--color", "red"],
    ];
    for (const argv of cases) {
      const sink = io(bytesOf("FROM alpine:3.20\n"));
      expect({ argv, code: await runCli(argv, env, sink, lines([])) }).toEqual({ argv, code: 2 });
      expect(sink.err.length).toBeGreaterThan(0);
      expect(sink.out).toBe("");
    }
  });
});

const EDGE_SOCKET = "/run/minibox-test/edge-docker.sock";

/** The local host and an edge host over one checkpoint engine. The edge host is added through the API. */
async function serveTwoHosts() {
  const local = new FakeRuntime();
  const edge = new FakeRuntime();
  const app = createApp(testConfig({ labelPrefix: "mbtest" }), "0.0.0-test", {
    runtime: local,
    connect: (target) => ("socketPath" in target && target.socketPath === EDGE_SOCKET ? edge : new FakeRuntime()),
    checkpointEngine: new FakeCheckpointEngine(),
    eventsPath: ":memory:",
  });
  const keys = app.hosts.get().keys;
  for (const runtime of [local, edge]) {
    runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  }
  const server = startServer(app);
  const base = `http://127.0.0.1:${server.port}`;
  const added = await call(base, "/api/hosts", { body: { id: "edge", endpoint: `unix://${EDGE_SOCKET}` } });
  expect(added.status).toBe(201);
  return {
    app,
    base,
    env: { MINIBOX_URL: base, MINIBOX_ACCESS_KEY: TEST_KEY },
    stop: () => {
      app.hostAdmin.close();
      app.sessions.stop();
      app.tokens.stop();
      app.throttle.stop();
      server.stop(true);
    },
  };
}

type TwoHosts = Awaited<ReturnType<typeof serveTwoHosts>>;

async function newBox(served: TwoHosts, name: string): Promise<string> {
  const created = await call(served.base, "/api/boxes", { body: { name, cpus: 1, memoryMb: 256 } });
  expect(created.status).toBe(201);
  return created.json.box?.boxId ?? "";
}

async function checkpointOf(served: TwoHosts, boxId: string): Promise<string> {
  const started = await call(served.base, `/api/boxes/${boxId}/checkpoints`, { body: {} });
  expect(started.status).toBe(202);
  await served.app.tasks.drain();
  const task = (await call(served.base, `/api/tasks/${started.json.taskId ?? ""}`)).json as unknown as {
    status: string;
    result?: { checkpoint: { id: string } };
  };
  expect(task.status).toBe("succeeded");
  return task.result?.checkpoint.id ?? "";
}

async function checkpointIdsOn(served: TwoHosts, hostId: string): Promise<string[]> {
  const listed = (await call(served.base, "/api/checkpoints")).json as unknown as {
    checkpoints: { id: string; hostId: string }[];
  };
  return listed.checkpoints.filter((item) => item.hostId === hostId).map((item) => item.id);
}

describe("CLI checkpoint copy", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("checkpoint copy waits for the copy, prints the copy's id, and its log says what it moves", async () => {
    const served = await serveTwoHosts();
    try {
      const origin = await checkpointOf(served, await newBox(served, "alpha"));
      const copied = io();
      expect(await runCli(["checkpoint", "copy", origin, "--host", "edge"], served.env, copied, lines([]))).toBe(0);

      const ids = await checkpointIdsOn(served, "edge");
      expect(ids).toHaveLength(1);
      expect(copied.out).toBe(`${ids[0]}\n`);
      expect(copied.err).toContain("Packing");
      expect(copied.err).toContain("Restoring");
    } finally {
      served.stop();
    }
  });

  test("--json prints the finished task, and --no-wait prints only the task's id, leaving the copy to run", async () => {
    const served = await serveTwoHosts();
    try {
      const boxId = await newBox(served, "alpha");
      const first = await checkpointOf(served, boxId);
      const second = await checkpointOf(served, boxId);

      const json = io();
      expect(await runCli(["checkpoint", "copy", first, "--host", "edge", "--json"], served.env, json, lines([]))).toBe(
        0,
      );
      expect(JSON.parse(json.out)).toMatchObject({
        status: "succeeded",
        result: { checkpoint: { hostId: "edge", boxName: "alpha" } },
      });

      const detached = io();
      expect(
        await runCli(["checkpoint", "copy", second, "--host", "edge", "--no-wait"], served.env, detached, lines([])),
      ).toBe(0);
      expect(detached.out).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}\n$/);
      expect(detached.err).toBe("");
      await served.app.tasks.drain();
      expect(await checkpointIdsOn(served, "edge")).toHaveLength(2);
    } finally {
      served.stop();
    }
  });

  test("a copy that is refused prints the server's message and exits 1, and makes no copy", async () => {
    const served = await serveTwoHosts();
    try {
      const origin = await checkpointOf(served, await newBox(served, "alpha"));

      const nohost = io();
      expect(await runCli(["checkpoint", "copy", origin, "--host", "nowhere"], served.env, nohost, lines([]))).toBe(1);
      expect(nohost.out).toBe("");
      expect(nohost.err).toContain("Host “nowhere” was not found.");

      const missing = io();
      expect(
        await runCli(["checkpoint", "copy", "ck_neverexisted", "--host", "edge"], served.env, missing, lines([])),
      ).toBe(1);
      expect(missing.err).toContain("Checkpoint ck_neverexisted was not found.");

      expect(await runCli(["checkpoint", "copy", origin, "--host", "edge"], served.env, io(), lines([]))).toBe(0);
      const again = io();
      expect(await runCli(["checkpoint", "copy", origin, "--host", "edge"], served.env, again, lines([]))).toBe(1);
      expect(again.out).toBe("");
      expect(again.err).toContain("already has a copy on host edge");
      expect(await checkpointIdsOn(served, "edge")).toHaveLength(1);
    } finally {
      served.stop();
    }
  });

  test("usage errors exit 2 before any request, and --help names the command", async () => {
    const env = { MINIBOX_URL: "http://127.0.0.1:9", MINIBOX_ACCESS_KEY: TEST_KEY };
    const helped = io();
    expect(await runCli(["checkpoint", "copy", "--help"], env, helped, lines([]))).toBe(0);
    expect(helped.out).toContain("minibox checkpoint copy <id> --host ID");

    const cases: string[][] = [
      ["checkpoint"],
      ["checkpoint", "frobnicate"],
      ["checkpoint", "copy"],
      ["checkpoint", "copy", "ck_a"],
      ["checkpoint", "copy", "--host", "edge"],
      ["checkpoint", "copy", "ck_a", "ck_b", "--host", "edge"],
      ["checkpoint", "copy", "ck_a", "--host"],
      ["checkpoint", "copy", "ck_a", "--host", "edge", "--color", "red"],
    ];
    for (const argv of cases) {
      const sink = io();
      expect({ argv, code: await runCli(argv, env, sink, lines([])) }).toEqual({ argv, code: 2 });
      expect(sink.err.length).toBeGreaterThan(0);
      expect(sink.out).toBe("");
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

async function carrierBox(env: ReturnType<typeof serve>): Promise<void> {
  await env.app.operations.run("box.create", env.ctx, { name: "carrier", cpus: 1, memoryMb: 256 });
}

/** The files of the volume a box mounts at `mount`, keyed by their path inside it. */
async function volumeFilesAt(env: ReturnType<typeof serve>, mount: string) {
  const { box } = (await env.app.operations.run("box.get", env.ctx, { id: "carrier" })) as {
    box: { mounts: { path: string; volumeId: string | null }[] };
  };
  const host = env.app.hosts.get();
  const volumeId = box.mounts.find((item) => item.path === mount)?.volumeId ?? "";
  const record = host.volumes.resolve(volumeId, host.host.id);
  if (!record) throw new Error(`no volume at ${mount}`);
  return env.runtime.filesOf(record.engineName);
}

describe("CLI file transfers", () => {
  let restoreLogs: () => void;
  let dir: string;
  beforeEach(() => {
    restoreLogs = silenceLogs();
    dir = mkdtempSync(join(tmpdir(), "minibox-cli-files-"));
  });
  afterEach(() => {
    restoreLogs();
    rmSync(dir, { recursive: true, force: true });
  });

  test("upload sends a file into a box, and download brings it back, refusing to replace either side by default", async () => {
    const env = serve();
    try {
      await carrierBox(env);
      const local = join(dir, "note.txt");
      writeFileSync(local, "hello box\n");
      const sent = io();
      expect(await runCli(["upload", local, "carrier:/workspace/notes/note.txt"], env.env, sent, lines([]))).toBe(0);
      expect(sent.out).toBe(`${local} -> carrier:/workspace/notes/note.txt\n`);
      const inBox = await volumeFilesAt(env, "/workspace");
      expect(inBox.get("notes/note.txt")).toMatchObject({ type: "file", uid: 1000, gid: 1000 });
      expect(inBox.get("notes/note.txt")?.content?.toString("utf8")).toBe("hello box\n");

      const refused = io();
      expect(await runCli(["upload", local, "carrier:/workspace/notes/note.txt"], env.env, refused, lines([]))).toBe(1);
      expect(refused.err).toContain("already exists");

      writeFileSync(local, "replaced\n");
      expect(
        await runCli(["upload", local, "carrier:/workspace/notes/note.txt", "--overwrite"], env.env, io(), lines([])),
      ).toBe(0);
      expect(inBox.get("notes/note.txt")?.content?.toString("utf8")).toBe("replaced\n");

      const out = join(dir, "back");
      mkdirSync(out);
      const fetched = io();
      expect(await runCli(["download", "carrier:/workspace/notes/note.txt", out], env.env, fetched, lines([]))).toBe(0);
      expect(fetched.out).toBe(`carrier:/workspace/notes/note.txt -> ${join(out, "note.txt")}\n`);
      expect(readFileSync(join(out, "note.txt"), "utf8")).toBe("replaced\n");

      const kept = io();
      expect(await runCli(["download", "carrier:/workspace/notes/note.txt", out], env.env, kept, lines([]))).toBe(1);
      expect(kept.err).toContain("already exists");
      expect(readFileSync(join(out, "note.txt"), "utf8")).toBe("replaced\n");
    } finally {
      env.stop();
    }
  });

  test("a folder uploads with its tree, skips symbolic links, and downloads as a tar.gz named after it", async () => {
    const env = serve();
    try {
      await carrierBox(env);
      const tree = join(dir, "tree");
      mkdirSync(join(tree, "sub"), { recursive: true });
      writeFileSync(join(tree, "a.txt"), "A");
      writeFileSync(join(tree, "sub", "b.txt"), "B");
      symlinkSync(join(tree, "a.txt"), join(tree, "link"));

      const sent = io();
      expect(await runCli(["upload", tree, "carrier:/workspace/out/"], env.env, sent, lines([]))).toBe(0);
      expect(sent.err).toContain("skipped");
      const inBox = await volumeFilesAt(env, "/workspace");
      expect(inBox.get("out/tree/a.txt")?.content?.toString("utf8")).toBe("A");
      expect(inBox.get("out/tree/sub/b.txt")?.content?.toString("utf8")).toBe("B");
      expect(inBox.has("out/tree/link")).toBe(false);

      const dl = join(dir, "dl");
      mkdirSync(dl);
      expect(await runCli(["download", "carrier:/workspace/out/tree", `${dl}/`], env.env, io(), lines([]))).toBe(0);
      const names = parseTar(gunzipSync(readFileSync(join(dl, "tree.tar.gz")))).map((entry) => entry.name);
      expect(names.some((name) => name.endsWith("a.txt"))).toBe(true);
      expect(names.some((name) => name.endsWith("b.txt"))).toBe(true);
    } finally {
      env.stop();
    }
  });

  test("cp copies in either direction, and refuses two box paths, two local paths or one argument", async () => {
    const env = serve();
    try {
      await carrierBox(env);
      const local = join(dir, "cp.txt");
      writeFileSync(local, "cp data");
      expect(await runCli(["cp", local, "carrier:/workspace/cp.txt"], env.env, io(), lines([]))).toBe(0);
      const back = join(dir, "back.txt");
      expect(await runCli(["cp", "carrier:/workspace/cp.txt", back], env.env, io(), lines([]))).toBe(0);
      expect(readFileSync(back, "utf8")).toBe("cp data");

      expect(await runCli(["cp", local, back], env.env, io(), lines([]))).toBe(2);
      expect(await runCli(["cp", "carrier:/workspace/a", "carrier:/workspace/b"], env.env, io(), lines([]))).toBe(2);
      expect(await runCli(["cp", local], env.env, io(), lines([]))).toBe(2);
      expect(await runCli(["upload", local], env.env, io(), lines([]))).toBe(2);
      expect(await runCli(["download"], env.env, io(), lines([]))).toBe(2);
    } finally {
      env.stop();
    }
  });

  test("a missing box, a path no volume backs and an unknown option answer clearly", async () => {
    const env = serve();
    try {
      await carrierBox(env);
      const local = join(dir, "x.txt");
      writeFileSync(local, "x");
      const ghost = io();
      expect(await runCli(["download", "ghost:/workspace/x", dir], env.env, ghost, lines([]))).toBe(1);
      expect(ghost.err).not.toBe("");

      const unmounted = io();
      expect(await runCli(["upload", local, "carrier:/nowhere/x.txt"], env.env, unmounted, lines([]))).toBe(1);
      expect(unmounted.err).toContain("has no mounted volume at /nowhere/x.txt");

      expect(await runCli(["upload", local, "carrier:/workspace/x.txt", "--force"], env.env, io(), lines([]))).toBe(2);
    } finally {
      env.stop();
    }
  });
});

async function api(base: string, method: string, path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${TEST_KEY}` } });
  const text = await res.text();
  return { status: res.status, json: text === "" ? null : JSON.parse(text) };
}

async function boxIdNamed(base: string, name: string): Promise<string> {
  const listed = (await api(base, "GET", "/api/boxes")).json as { boxes: { boxId: string; name: string }[] };
  return listed.boxes.find((box) => box.name === name)?.boxId ?? "";
}

describe("CLI recycle bin", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("trash ls shows the entries, trash restore brings one back as a new box, and trash purge removes one", async () => {
    const env = serve();
    try {
      for (const name of ["alpha", "beta"]) {
        expect(await runCli(["box", "create", name, "--cpus", "1", "--memory", "256"], env.env, io(), lines([]))).toBe(
          0,
        );
      }
      const alphaId = await boxIdNamed(env.env.MINIBOX_URL, "alpha");
      const betaId = await boxIdNamed(env.env.MINIBOX_URL, "beta");
      expect((await api(env.env.MINIBOX_URL, "DELETE", `/api/boxes/${alphaId}`)).status).toBe(200);
      expect((await api(env.env.MINIBOX_URL, "DELETE", `/api/boxes/${betaId}`)).status).toBe(200);

      const listed = (await api(env.env.MINIBOX_URL, "GET", "/api/trash")).json as {
        trash: { id: string; sourceName: string }[];
      };
      const alphaEntry = listed.trash.find((entry) => entry.sourceName === "alpha")?.id ?? "";
      const betaEntry = listed.trash.find((entry) => entry.sourceName === "beta")?.id ?? "";
      expect(listed.trash).toHaveLength(2);

      const table = io();
      expect(await runCli(["trash", "ls"], env.env, table, lines([]))).toBe(0);
      expect(table.out.split("\n")[0]).toBe("ID  NAME  KIND  DELETED  EXPIRES  BYTES");
      expect(table.out).toContain(`${alphaEntry}  alpha  box  `);

      const asJson = io();
      expect(await runCli(["trash", "ls", "--json"], env.env, asJson, lines([]))).toBe(0);
      expect(JSON.parse(asJson.out)).toEqual({
        trash: expect.arrayContaining([expect.objectContaining({ id: betaEntry })]),
      });

      const restored = io();
      expect(await runCli(["trash", "restore", alphaEntry, "--name", "alpha-back"], env.env, restored, lines([]))).toBe(
        0,
      );
      expect(restored.out).toBe("alpha-back\n");
      expect(await boxIdNamed(env.env.MINIBOX_URL, "alpha-back")).not.toBe("");

      const purged = io();
      expect(await runCli(["trash", "purge", betaEntry], env.env, purged, lines([]))).toBe(0);
      expect(purged.out).toBe(`${betaEntry}\n`);

      const left = (await api(env.env.MINIBOX_URL, "GET", "/api/trash")).json as { trash: unknown[] };
      expect(left.trash).toEqual([]);
    } finally {
      env.stop();
    }
  });

  test("a restore or purge of an entry that does not exist exits 1 with the server's message", async () => {
    const env = serve();
    try {
      const restore = io();
      expect(await runCli(["trash", "restore", "ck_0000000000000000000000000"], env.env, restore, lines([]))).toBe(1);
      expect(restore.err).toContain("ck_0000000000000000000000000");

      const purge = io();
      expect(await runCli(["trash", "purge", "ck_0000000000000000000000000"], env.env, purge, lines([]))).toBe(1);
      expect(purge.err).toContain("ck_0000000000000000000000000");
    } finally {
      env.stop();
    }
  });

  test("trash empty lists what it would purge, and with --yes purges exactly those entries", async () => {
    const env = serve();
    try {
      for (const name of ["alpha", "beta"]) {
        expect(await runCli(["box", "create", name, "--cpus", "1", "--memory", "256"], env.env, io(), lines([]))).toBe(
          0,
        );
        const boxId = await boxIdNamed(env.env.MINIBOX_URL, name);
        expect((await api(env.env.MINIBOX_URL, "DELETE", `/api/boxes/${boxId}`)).status).toBe(200);
      }
      const trashLeft = async () =>
        ((await api(env.env.MINIBOX_URL, "GET", "/api/trash")).json as { trash: unknown[] }).trash;

      const preview = io();
      expect(await runCli(["trash", "empty"], env.env, preview, lines([]))).toBe(0);
      expect(preview.out.split("\n")[0]).toBe("ID  NAME  KIND  HOST  BYTES  ACTION");
      expect(preview.out).toContain("alpha  box  local  ");
      expect(preview.out).toContain("Nothing was purged. Add --yes");
      expect(await trashLeft()).toHaveLength(2);

      const asJson = io();
      expect(await runCli(["trash", "empty", "--json"], env.env, asJson, lines([]))).toBe(0);
      expect(JSON.parse(asJson.out).error.details.preview).toMatchObject({ action: "empty_trash", count: 2 });
      expect(await trashLeft()).toHaveLength(2);

      const done = io();
      expect(await runCli(["trash", "empty", "--yes"], env.env, done, lines([]))).toBe(0);
      expect(done.out).toContain("2 purged, 0 left in use, 0 failed");
      expect(await trashLeft()).toEqual([]);

      const again = io();
      expect(await runCli(["trash", "empty", "--yes"], env.env, again, lines([]))).toBe(0);
      expect(again.out).toBe("The recycle bin is empty.\n");
    } finally {
      env.stop();
    }
  });

  test("trash usage errors exit 2 without calling the server", async () => {
    const env = { MINIBOX_URL: "http://127.0.0.1:9", MINIBOX_ACCESS_KEY: TEST_KEY };
    const cases: string[][] = [
      ["trash"],
      ["trash", "frobnicate"],
      ["trash", "ls", "extra"],
      ["trash", "restore"],
      ["trash", "restore", "ck_1", "extra"],
      ["trash", "restore", "ck_1", "--cpus", "lots"],
      ["trash", "purge"],
      ["trash", "purge", "ck_1", "--color", "red"],
      ["trash", "empty", "extra"],
      ["trash", "empty", "--force"],
    ];
    for (const argv of cases) {
      const sink = io();
      expect({ argv, code: await runCli(argv, env, sink, lines([])) }).toEqual({ argv, code: 2 });
      expect(sink.err.length).toBeGreaterThan(0);
      expect(sink.out).toBe("");
    }
  });
});

type Served = ReturnType<typeof serve>;

async function volumeNames(served: Served): Promise<string[]> {
  const listed = (await api(served.env.MINIBOX_URL, "GET", "/api/volumes")).json as { volumes: { name: string }[] };
  return listed.volumes.map((volume) => volume.name);
}

/** A volume no box uses, dated two days back so the five-minute grace period has passed for it. */
async function orphanVolume(served: Served, name: string): Promise<void> {
  const host = served.app.hosts.get();
  await createVolume(host, { name, role: null, createdBy: null });
  const record = host.volumes.resolve(name);
  if (!record) throw new Error(`volume ${name} was not created`);
  host.volumes.write({ ...record, createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() });
}

describe("CLI volume prune and delete", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("volume prune lists the orphans, and --yes removes them", async () => {
    const env = serve();
    try {
      await orphanVolume(env, "notes");

      const listed = io();
      expect(await runCli(["volume", "prune"], env.env, listed, lines([]))).toBe(0);
      expect(listed.out.split("\n")[0]).toBe("NAME  HOST  POOL  BYTES  LAST USED  FORMER BOX  STATUS");
      expect(listed.out).toContain("notes  local  local");
      expect(listed.out).toContain("Nothing was removed. Add --yes to remove these volumes.");
      expect(await volumeNames(env)).toContain("notes");

      const removed = io();
      expect(await runCli(["volume", "prune", "--yes"], env.env, removed, lines([]))).toBe(0);
      expect(removed.out).toMatch(/^notes\s.*removed$/m);
      expect(await volumeNames(env)).not.toContain("notes");

      await orphanVolume(env, "scratch");
      await orphanVolume(env, "keep");
      const named = io();
      expect(await runCli(["volume", "prune", "scratch", "--yes"], env.env, named, lines([]))).toBe(0);
      expect(named.out).toMatch(/^scratch\s.*removed$/m);
      expect(named.out).not.toContain("keep");
      expect(await volumeNames(env)).toContain("keep");
    } finally {
      env.stop();
    }
  });

  test("volume prune --older-than keeps the volumes used more recently, --json prints the reply, and a bad span exits 1", async () => {
    const env = serve();
    try {
      await orphanVolume(env, "notes");

      const recent = io();
      expect(await runCli(["volume", "prune", "--older-than", "7d"], env.env, recent, lines([]))).toBe(0);
      expect(recent.out).toContain("No orphaned volumes.");

      const json = io();
      expect(await runCli(["volume", "prune", "--older-than", "1d", "--json"], env.env, json, lines([]))).toBe(0);
      expect(JSON.parse(json.out)).toMatchObject({
        dryRun: true,
        olderThan: "1d",
        volumes: [expect.objectContaining({ name: "notes", status: "candidate" })],
      });

      const nonsense = io();
      expect(await runCli(["volume", "prune", "--older-than", "soon"], env.env, nonsense, lines([]))).toBe(1);
      expect(nonsense.err).toContain("olderThan must be a whole number followed by s, m, h, d or w");
      expect(await volumeNames(env)).toContain("notes");
    } finally {
      env.stop();
    }
  });

  test("volume delete previews without --yes, then --yes deletes the volumes a box does not use and refuses the rest", async () => {
    const env = serve();
    try {
      expect(await runCli(["box", "create", "alpha", "--cpus", "1", "--memory", "256"], env.env, io(), lines([]))).toBe(
        0,
      );
      await createVolume(env.app.hosts.get(), { name: "notes", role: null, createdBy: null });

      const preview = io();
      expect(await runCli(["volume", "delete", "alpha-workspace", "notes"], env.env, preview, lines([]))).toBe(0);
      expect(preview.out.split("\n")[0]).toBe("NAME  HOST  ACTION");
      expect(preview.out).toContain("alpha-workspace  local  skip (in_use)");
      expect(preview.out).toContain("notes  local  delete, kept in the recycle bin");
      expect(preview.out).toContain("Nothing was deleted. Add --yes to delete the volumes that are not skipped.");
      expect(await volumeNames(env)).toEqual(expect.arrayContaining(["alpha-workspace", "notes"]));

      const applied = io();
      expect(await runCli(["volume", "delete", "alpha-workspace", "notes", "--yes"], env.env, applied, lines([]))).toBe(
        1,
      );
      expect(applied.out).toContain("alpha-workspace  local  refused  Volume alpha-workspace is in use");
      expect(applied.out).toContain("notes  local  removed  -");
      expect(await volumeNames(env)).toContain("alpha-workspace");
      expect(await volumeNames(env)).not.toContain("notes");
    } finally {
      env.stop();
    }
  });

  test("volume snapshot prints the checkpoint it took, and --pin keeps it", async () => {
    const env = serve();
    try {
      await createVolume(env.app.hosts.get(), { name: "notes", role: null, createdBy: null });

      const out = io();
      expect(
        await runCli(["volume", "snapshot", "notes", "--label", "before the edit", "--pin"], env.env, out, lines([])),
      ).toBe(0);
      const checkpointId = out.out.trim();
      expect(checkpointId).toMatch(/^ck_/);

      const read = await api(env.env.MINIBOX_URL, "GET", `/api/checkpoints/${checkpointId}`);
      expect(read.json).toMatchObject({
        checkpoint: { id: checkpointId, boxId: null, boxName: "notes", label: "before the edit", pinned: true },
      });

      const cache = io();
      await createVolume(env.app.hosts.get(), { name: "cache-a", role: "cache", createdBy: null });
      expect(await runCli(["volume", "snapshot", "cache-a"], env.env, cache, lines([]))).toBe(1);
      expect(cache.err).toContain("is never part of a checkpoint");
    } finally {
      env.stop();
    }
  });

  test("volume usage errors exit 2 without calling the server", async () => {
    const env = { MINIBOX_URL: "http://127.0.0.1:9", MINIBOX_ACCESS_KEY: TEST_KEY };
    const cases: [string[], string][] = [
      [["volume"], "needs delete, prune or snapshot"],
      [["volume", "frobnicate"], "needs delete, prune or snapshot"],
      [["volume", "delete"], "needs one or more volume ids or names"],
      [["volume", "delete", "notes", "--color", "red"], "Unknown option --color"],
      [["volume", "prune", "--older-than"], "--older-than needs a value"],
      [["volume", "prune", "--color", "red"], "Unknown option --color"],
      [["volume", "snapshot"], "needs one volume id or name"],
      [["volume", "snapshot", "notes", "other"], "needs one volume id or name"],
      [["volume", "snapshot", "notes", "--label"], "--label needs a value"],
      [["volume", "snapshot", "notes", "--color", "red"], "Unknown option --color"],
    ];
    for (const [argv, message] of cases) {
      const sink = io();
      expect({ argv, code: await runCli(argv, env, sink, lines([])) }).toEqual({ argv, code: 2 });
      expect(sink.err).toContain(message);
      expect(sink.out).toBe("");
    }
    expect(await runCli(["volume", "prune", "--help"], env, io(), lines([]))).toBe(0);
  });
});
