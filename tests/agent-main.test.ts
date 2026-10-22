import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateKeyPairPem, IDENTITY_FILE, KEY_FILE, loadIdentity, saveIdentity } from "../src/agent/identity";
import { type Fetcher, PairingError, pairWith, parseArgs, runAgent, UsageError } from "../src/agent/main";
import { AGENT_PAIR_PATH, AGENT_PROTOCOL, isEd25519PublicKey } from "../src/agent/protocol";

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
  restoreLogs = () => {
    errors.mockRestore();
    logs.mockRestore();
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
