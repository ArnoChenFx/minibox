import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runCli } from "../src/cli";
import type { OperationContext, Principal } from "../src/operations/types";
import { startServer } from "../src/server";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";

const OWNER: Principal = { type: "owner", id: "owner", name: "owner" };

interface Io {
  out: string;
  err: string;
  stdout(text: string): void;
  stderr(text: string): void;
}

function io(): Io {
  const sink: Io = {
    out: "",
    err: "",
    stdout(text) {
      sink.out += text;
    },
    stderr(text) {
      sink.err += text;
    },
  };
  return sink;
}

async function* lines(rows: string[]): AsyncGenerator<string> {
  for (const row of rows) yield row;
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
});
