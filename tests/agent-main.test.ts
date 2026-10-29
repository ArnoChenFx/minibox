import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateKeyPairPem, IDENTITY_FILE, KEY_FILE, loadIdentity, saveIdentity } from "../src/agent/identity";
import {
  allowedRuntimesOf,
  type Fetcher,
  PairingError,
  pairWith,
  parseArgs,
  runAgent,
  UsageError,
} from "../src/agent/main";
import { AGENT_PAIR_PATH, AGENT_PROTOCOL, isEd25519PublicKey } from "../src/agent/protocol";
import { freshScope, loadScope, OWNER_LABEL, SCOPE_FILE, saveScope } from "../src/agent/scope";
import { FakeRuntime } from "./support/fake-runtime";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "minibox-agent-main-"));
  dirs.push(dir);
  return dir;
}

let restoreLogs: () => void;
beforeEach(() => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const logs = spyOn(console, "log").mockImplementation(() => {});
  const signals = [process.listeners("SIGINT"), process.listeners("SIGTERM")];
  restoreLogs = () => {
    errors.mockRestore();
    logs.mockRestore();
    // An agent that was stopped by one signal leaves the handler it set for the other.
    for (const [index, name] of (["SIGINT", "SIGTERM"] as const).entries()) {
      for (const listener of process.listeners(name))
        if (!signals[index]?.includes(listener)) process.off(name, listener);
    }
  };
});
afterEach(() => {
  restoreLogs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PAIR_REQUEST = {
  code: "ABCDE-FGHJK",
  publicKey: generateKeyPairPem().publicKeyPem,
  version: "0.4.0",
  protocol: AGENT_PROTOCOL,
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A stand-in for the control plane that answers every request with what `reply` returns. */
function answering(reply: () => Response): Fetcher {
  return async () => reply();
}

describe("command-line arguments", () => {
  test("--server and --pair are read, the server is normalised to a URL, and the code is trimmed", () => {
    expect(parseArgs(["--server", "https://minibox.example.com", "--pair", " ABCDE-FGHJK "])).toEqual({
      server: "https://minibox.example.com/",
      pair: "ABCDE-FGHJK",
      help: false,
    });
  });

  test("the equals form is read the same way", () => {
    expect(parseArgs(["--server=http://10.0.0.5:3920", "--pair=ABCDE-FGHJK"])).toMatchObject({
      server: "http://10.0.0.5:3920/",
      pair: "ABCDE-FGHJK",
    });
  });

  test("help is recognised", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  test("an unknown flag is a usage error, so a typo is never ignored", () => {
    expect(() => parseArgs(["--token", "x"])).toThrow(UsageError);
    expect(() => parseArgs(["--token", "x"])).toThrow("unknown argument --token");
  });

  test("a flag without its value, or followed by another flag, is a usage error", () => {
    expect(() => parseArgs(["--server"])).toThrow("--server needs a value");
    expect(() => parseArgs(["--server", "--pair", "ABCDE"])).toThrow("--server needs a value");
  });

  test("the server must be an http or https URL", () => {
    expect(() => parseArgs(["--server", "ftp://minibox.example.com"])).toThrow(
      "--server must start with http:// or https://",
    );
    expect(() => parseArgs(["--server", "not a url"])).toThrow("--server must be a URL");
  });
});

describe("the agent's identity on disk", () => {
  test("a new key pair is an Ed25519 pair in PEM", () => {
    const keys = generateKeyPairPem();
    expect(keys.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(keys.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(isEd25519PublicKey(keys.publicKeyPem)).toBe(true);
  });

  test("a saved identity loads back with its key, and both files are private", () => {
    const dir = tempDir();
    const keys = generateKeyPairPem();
    saveIdentity(
      dir,
      {
        agentId: "9c1f0e2d8b7a4f6e5d4c3b2a1f0e9d8c",
        hostId: "edge",
        server: "https://minibox.example.com/",
        pairedAt: "2026-10-22T00:00:00.000Z",
      },
      keys.privateKeyPem,
    );
    for (const file of [IDENTITY_FILE, KEY_FILE]) {
      expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    }
    const stored = loadIdentity(dir);
    expect(stored?.identity).toMatchObject({ agentId: "9c1f0e2d8b7a4f6e5d4c3b2a1f0e9d8c", hostId: "edge" });
    expect(stored?.publicKeyPem).toBe(keys.publicKeyPem);
  });

  test("a directory with no identity is not paired", () => {
    expect(loadIdentity(tempDir())).toBeNull();
  });

  test("an identity without its key cannot prove who it is, and the error says how to fix it", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, IDENTITY_FILE),
      JSON.stringify({
        agentId: "9c1f0e2d8b7a4f6e5d4c3b2a1f0e9d8c",
        hostId: "edge",
        server: "https://minibox.example.com/",
        pairedAt: "2026-10-22T00:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    expect(() => loadIdentity(dir)).toThrow(`${KEY_FILE} is missing`);
    expect(existsSync(join(dir, KEY_FILE))).toBe(false);
  });

  test("the private key lives in its own file, so the identity record holds no secret", () => {
    const dir = tempDir();
    saveIdentity(
      dir,
      { agentId: "9c1f0e2d8b7a4f6e5d4c3b2a1f0e9d8c", hostId: "edge", server: "https://m.example/", pairedAt: "x" },
      generateKeyPairPem().privateKeyPem,
    );
    expect(readFileSync(join(dir, KEY_FILE), "utf8")).toContain("PRIVATE KEY");
    expect(readFileSync(join(dir, IDENTITY_FILE), "utf8")).not.toContain("PRIVATE");
  });
});

describe("pairing with the control plane", () => {
  test("a successful pairing returns the agent id and the host it serves", async () => {
    const sent: { url: string; body: unknown }[] = [];
    const fetcher: Fetcher = async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return jsonResponse({ agentId: "9c1f0e2d8b7a4f6e5d4c3b2a1f0e9d8c", hostId: "edge", protocol: 1 }, 201);
    };
    const reply = await pairWith("https://minibox.example.com/", PAIR_REQUEST, fetcher);
    expect(reply).toEqual({ agentId: "9c1f0e2d8b7a4f6e5d4c3b2a1f0e9d8c", hostId: "edge", protocol: 1 });
    expect(sent).toEqual([{ url: `https://minibox.example.com${AGENT_PAIR_PATH}`, body: PAIR_REQUEST }]);
  });

  test("the control plane's reason is passed on when it refuses the code", async () => {
    const fetcher = answering(() =>
      jsonResponse({ error: { code: "unauthorized", message: "That code was already used." } }, 401),
    );
    await expect(pairWith("https://minibox.example.com", PAIR_REQUEST, fetcher)).rejects.toThrow(
      "That code was already used.",
    );
  });

  test("a refusal without a readable reason names the HTTP status", async () => {
    const fetcher = answering(() => new Response("oops", { status: 500 }));
    await expect(pairWith("https://minibox.example.com", PAIR_REQUEST, fetcher)).rejects.toThrow("HTTP 500");
  });

  test("an unreachable control plane is a pairing error that says so", async () => {
    const fetcher = answering(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const failure = await pairWith("https://minibox.example.com", PAIR_REQUEST, fetcher).catch((e) => e);
    expect(failure).toBeInstanceOf(PairingError);
    expect(failure.message).toContain("could not be reached");
  });

  test("a reply this agent cannot read is a pairing error", async () => {
    const fetcher = answering(() => jsonResponse({ unexpected: true }, 201));
    await expect(pairWith("https://minibox.example.com", PAIR_REQUEST, fetcher)).rejects.toThrow(
      "pairing response this agent cannot read",
    );
  });
});

const AGENT = "9c1f0e2d8b7a4f6e5d4c3b2a1f0e9d8c";

/** Starts an agent, lets it get as far as waiting for a signal, then stops it with one, as a service manager would. */
async function startedAndStopped(start: () => Promise<number>): Promise<number> {
  const before = process.listenerCount("SIGTERM");
  const run = start();
  const deadline = Date.now() + 2_000;
  while (process.listenerCount("SIGTERM") === before) {
    if (Date.now() > deadline) throw new Error("the agent did not start");
    await Bun.sleep(5);
  }
  process.emit("SIGTERM");
  return run;
}

describe("the container runtimes a box may ask for", () => {
  test("they come from a comma-separated setting, trimmed, and a name no engine could use is dropped", () => {
    expect(allowedRuntimesOf(" runsc , kata-runtime,,bad name,x/y,.hidden")).toEqual(["runsc", "kata-runtime"]);
    expect(allowedRuntimesOf("")).toEqual([]);
    expect(allowedRuntimesOf(undefined)).toEqual([]);
  });
});

/** What a stand-in control plane heard back for each request it sent, by request id. */
type Answers = Map<string, { ok: boolean; error?: { kind?: string } }>;

/**
 * A stand-in for the control plane on a real socket. It challenges, welcomes the agent (naming `labelPrefix` when it has
 * one), asks for each of `requests` as `r1`, `r2`, and so on, and keeps the answers. `answered` settles with the last.
 */
async function controlPlane(options: { labelPrefix?: string; requests: Array<[string, unknown]> }) {
  const answers: Answers = new Map();
  const everyAnswer = Promise.withResolvers<void>();
  const server = Bun.serve({
    port: 0,
    fetch: (request, self) => (self.upgrade(request) ? undefined : new Response("no", { status: 404 })),
    websocket: {
      open: (ws) => {
        ws.send(
          JSON.stringify({
            type: "challenge",
            nonce: "n".repeat(32),
            protocol: AGENT_PROTOCOL,
            serverVersion: "0.4.0",
          }),
        );
      },
      message: (ws, raw) => {
        const frame = JSON.parse(String(raw)) as {
          type: string;
          id?: string;
          ok?: boolean;
          error?: { kind?: string };
        };
        if (frame.type === "hello") {
          const prefix = options.labelPrefix === undefined ? {} : { labelPrefix: options.labelPrefix };
          ws.send(JSON.stringify({ type: "welcome", hostId: "edge", protocol: AGENT_PROTOCOL, ...prefix }));
          options.requests.forEach(([op, args], index) => {
            ws.send(JSON.stringify({ type: "request", id: `r${index + 1}`, op, args }));
          });
        }
        if (frame.type === "response" && frame.id !== undefined) {
          answers.set(frame.id, {
            ok: frame.ok === true,
            ...(frame.error === undefined ? {} : { error: frame.error }),
          });
          if (answers.size === options.requests.length) everyAnswer.resolve();
        }
      },
    },
  });
  return {
    answers,
    answered: everyAnswer.promise,
    url: `http://127.0.0.1:${server.port}/`,
    stop: () => server.stop(true),
  };
}

/** Runs a paired agent on `dir` over `engine` against `plane` until every request is answered, then stops it. */
async function servedBy(
  dir: string,
  engine: FakeRuntime,
  plane: Awaited<ReturnType<typeof controlPlane>>,
  env: Record<string, string> = {},
): Promise<void> {
  saveIdentity(
    dir,
    { agentId: AGENT, hostId: "edge", server: plane.url, pairedAt: "2026-10-29T00:00:00.000Z" },
    generateKeyPairPem().privateKeyPem,
  );
  // The agent is paired, so it waits for a signal once `runAgent` is under way.
  const run = runAgent([], { DATA_DIR: dir, ...env }, { runtime: engine });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the agent answered ${[...plane.answers.keys()].join(", ") || "nothing"}`)),
      5_000,
    );
  });
  try {
    await Promise.race([plane.answered, expired]);
  } finally {
    clearTimeout(timer);
    process.emit("SIGTERM");
    plane.stop();
  }
  expect(await run).toBe(0);
}

describe("what the agent may touch, from the first start", () => {
  test("an agent that has just paired keeps a scope that adopts nothing, next to its identity and as private as it", async () => {
    const dir = tempDir();
    const fetcher = answering(() => jsonResponse({ agentId: AGENT, hostId: "edge", protocol: 1 }, 201));
    const now = new Date("2026-10-29T10:00:00.000Z");
    const run = () =>
      runAgent(
        ["--server", "http://127.0.0.1:1", "--pair", "ABCDE-FGHJK"],
        { DATA_DIR: dir },
        { fetch: fetcher, runtime: new FakeRuntime(), now: () => now },
      );
    expect(await startedAndStopped(run)).toBe(0);
    expect(loadScope(dir, "edge")).toEqual(freshScope("edge", now));
    expect(statSync(join(dir, SCOPE_FILE)).mode & 0o777).toBe(0o600);
  });

  test("an agent paired before scopes existed writes none when it starts: it adopts only when the control plane welcomes it", async () => {
    const dir = tempDir();
    saveIdentity(
      dir,
      { agentId: AGENT, hostId: "edge", server: "http://127.0.0.1:1/", pairedAt: "2026-10-01T00:00:00.000Z" },
      generateKeyPairPem().privateKeyPem,
    );
    expect(await startedAndStopped(() => runAgent([], { DATA_DIR: dir }, { runtime: new FakeRuntime() }))).toBe(0);
    expect(existsSync(join(dir, SCOPE_FILE))).toBe(false);
  });

  test("it serves the control plane through its scope: what is not MiniBox's is not found, and is left alone", async () => {
    const dir = tempDir();
    const engine = new FakeRuntime();
    engine.seedImage("alpine:3.20");
    const foreign = engine.seedContainer({ image: "alpine:3.20", name: "someone-elses", running: true, labels: {} });
    const own = engine.seedContainer({
      image: "alpine:3.20",
      name: "mine",
      running: true,
      labels: { [OWNER_LABEL]: "edge" },
    });
    saveScope(dir, freshScope("edge", new Date()));
    const plane = await controlPlane({
      labelPrefix: "mbtest",
      requests: [
        ["removeContainer", { id: foreign, force: true }],
        ["inspectContainer", { id: own }],
      ],
    });
    await servedBy(dir, engine, plane);
    expect(plane.answers.get("r1")).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(plane.answers.get("r2")).toMatchObject({ ok: true });
    expect(engine.containers.has(foreign)).toBe(true);
    expect(engine.callsTo("removeContainer")).toEqual([]);
  });

  test("an agent paired before scopes existed adopts what MiniBox made when the control plane welcomes it, and nothing else", async () => {
    const dir = tempDir();
    const engine = new FakeRuntime();
    engine.seedImage("alpine:3.20");
    // What an older MiniBox made: its labels, and none of the agent's. And somebody else's, which has neither.
    const legacy = engine.seedContainer({
      image: "alpine:3.20",
      name: "old-box",
      running: true,
      labels: { mbtest: "true", "mbtest.box": "true" },
    });
    const stranger = engine.seedContainer({ image: "alpine:3.20", name: "stranger", running: true, labels: {} });
    const plane = await controlPlane({
      labelPrefix: "mbtest",
      requests: [
        ["inspectContainer", { id: legacy }],
        ["inspectContainer", { id: stranger }],
      ],
    });
    await servedBy(dir, engine, plane);
    expect(plane.answers.get("r1")).toMatchObject({ ok: true });
    expect(plane.answers.get("r2")).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(loadScope(dir, "edge")?.adopted.containers).toEqual([legacy]);
  });

  test("a control plane that names no label prefix gets no adoption: the old boxes are not found until it does", async () => {
    const dir = tempDir();
    const engine = new FakeRuntime();
    engine.seedImage("alpine:3.20");
    const legacy = engine.seedContainer({
      image: "alpine:3.20",
      name: "old-box",
      running: true,
      labels: { mbtest: "true", "mbtest.box": "true" },
    });
    const plane = await controlPlane({ requests: [["inspectContainer", { id: legacy }]] });
    await servedBy(dir, engine, plane);
    expect(plane.answers.get("r1")).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(existsSync(join(dir, SCOPE_FILE))).toBe(false);
  });

  test("a container runtime besides runc is allowed only when AGENT_ALLOWED_RUNTIMES says so", async () => {
    const create = [
      "createContainer",
      { spec: { image: "alpine:3.20", name: "sandboxed", hardening: { runtime: "runsc" } } },
    ];
    for (const [env, outcome] of [
      [{}, { ok: false, error: { kind: "invalid" } }],
      [{ AGENT_ALLOWED_RUNTIMES: "kata-runtime, runsc" }, { ok: true }],
    ] as const) {
      const dir = tempDir();
      const engine = new FakeRuntime();
      engine.seedImage("alpine:3.20");
      saveScope(dir, freshScope("edge", new Date()));
      const plane = await controlPlane({ labelPrefix: "mbtest", requests: [create as [string, unknown]] });
      await servedBy(dir, engine, plane, env);
      expect(plane.answers.get("r1")).toMatchObject(outcome);
    }
  });

  test("a scope that cannot be read stops the agent before it serves anything, and one for another host is not trusted", async () => {
    const unreadable = tempDir();
    saveIdentity(
      unreadable,
      { agentId: AGENT, hostId: "edge", server: "http://127.0.0.1:1/", pairedAt: "2026-10-01T00:00:00.000Z" },
      generateKeyPairPem().privateKeyPem,
    );
    writeFileSync(join(unreadable, SCOPE_FILE), "not json", { mode: 0o600 });
    expect(await runAgent([], { DATA_DIR: unreadable }, { runtime: new FakeRuntime() })).toBe(1);

    const foreign = tempDir();
    saveIdentity(
      foreign,
      { agentId: AGENT, hostId: "edge", server: "http://127.0.0.1:1/", pairedAt: "2026-10-01T00:00:00.000Z" },
      generateKeyPairPem().privateKeyPem,
    );
    saveScope(foreign, freshScope("another-host", new Date()));
    expect(await runAgent([], { DATA_DIR: foreign }, { runtime: new FakeRuntime() })).toBe(1);
  });
});

describe("starting the agent", () => {
  test("--help prints the usage and exits 0", async () => {
    expect(await runAgent(["--help"], {})).toBe(0);
  });

  test("a bad argument exits 2 without starting", async () => {
    expect(await runAgent(["--bogus"], {})).toBe(2);
  });

  test("--pair without --server exits 2, because the code needs a server to be spent on", async () => {
    expect(await runAgent(["--pair", "ABCDE-FGHJK"], { DATA_DIR: tempDir() })).toBe(2);
  });

  test("an agent that was never paired and has no code exits 2 and says how to pair", async () => {
    expect(await runAgent([], { DATA_DIR: tempDir() })).toBe(2);
  });

  test("a code the control plane refuses exits 1 and keeps no identity, so the code can be fixed and used", async () => {
    const dir = tempDir();
    const refuse = answering(() => jsonResponse({ error: { message: "That code has expired." } }, 401));
    const status = await runAgent(
      ["--server", "https://minibox.example.com", "--pair", "ABCDE-FGHJK"],
      {
        DATA_DIR: dir,
      },
      { fetch: refuse },
    );
    expect(status).toBe(1);
    expect(loadIdentity(dir)).toBeNull();
  });
});
