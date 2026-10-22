import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import { AGENT_OPERATION_NAMES } from "../src/agent/executor";
import {
  AgentFrameSchema,
  decodeBytes,
  encodeBytes,
  isEd25519PublicKey,
  parseFrame,
  REFUSED_OPERATIONS,
  REQUEST_OPERATIONS,
  STREAM_OPERATIONS,
  SESSION_OPERATIONS,
  ServerFrameSchema,
  signHello,
  verifyHello,
} from "../src/agent/protocol";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const NONCE = "n".repeat(32);
const AGENT = "a".repeat(32);

describe("hello signatures", () => {
  test("a signature made with the agent's key verifies for the same nonce, agent and protocol", () => {
    const signature = signHello(privateKey, NONCE, AGENT, 1);
    expect(verifyHello(publicPem, NONCE, AGENT, 1, signature)).toBe(true);
  });

  test("a signature does not verify for another nonce, agent id or protocol, so it cannot be replayed", () => {
    const signature = signHello(privateKey, NONCE, AGENT, 1);
    expect(verifyHello(publicPem, "m".repeat(32), AGENT, 1, signature)).toBe(false);
    expect(verifyHello(publicPem, NONCE, "b".repeat(32), 1, signature)).toBe(false);
    expect(verifyHello(publicPem, NONCE, AGENT, 2, signature)).toBe(false);
  });

  test("a signature from another key is refused, and so is a key that is not Ed25519", () => {
    const other = generateKeyPairSync("ed25519");
    const signature = signHello(other.privateKey, NONCE, AGENT, 1);
    expect(verifyHello(publicPem, NONCE, AGENT, 1, signature)).toBe(false);

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPem = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(verifyHello(rsaPem, NONCE, AGENT, 1, signature)).toBe(false);
  });

  test("a key that is not a PEM public key is refused without throwing", () => {
    expect(verifyHello("not a key", NONCE, AGENT, 1, "AAAA")).toBe(false);
    expect(isEd25519PublicKey("not a key")).toBe(false);
  });

  test("only Ed25519 public keys are accepted for pairing", () => {
    expect(isEd25519PublicKey(publicPem)).toBe(true);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(isEd25519PublicKey(rsa.publicKey.export({ type: "spki", format: "pem" }).toString())).toBe(false);
  });
});

describe("frames", () => {
  test("text that is not JSON, or JSON of no known frame, parses to null", () => {
    expect(parseFrame(AgentFrameSchema, "{not json")).toBeNull();
    expect(parseFrame(AgentFrameSchema, JSON.stringify({ type: "shell", command: "ls" }))).toBeNull();
    expect(parseFrame(ServerFrameSchema, JSON.stringify({ type: "welcome", hostId: "edge" }))).toBeNull();
  });

  test("an agent frame keeps its fields", () => {
    const hello = { type: "hello" as const, agentId: AGENT, protocol: 1, version: "0.4.0", signature: "c2ln" };
    expect(parseFrame(AgentFrameSchema, JSON.stringify(hello))).toEqual(hello);
    const end = { type: "end" as const, id: "r1", exit: { running: false, exitCode: 0, pid: 7 } };
    expect(parseFrame(AgentFrameSchema, JSON.stringify(end))).toEqual(end);
  });

  test("a frame's unknown keys are dropped, and its known keys must have the right type", () => {
    const heartbeat = parseFrame(AgentFrameSchema, JSON.stringify({ type: "heartbeat", at: "x", extra: true }));
    expect(heartbeat).toEqual({ type: "heartbeat", at: "x" });
    const badExit = { type: "end", id: "r1", exit: { running: "yes", exitCode: 0, pid: 7 } };
    expect(parseFrame(AgentFrameSchema, JSON.stringify(badExit))).toBeNull();
  });

  test("bytes travel as base64 and come back unchanged", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(Array.from(decodeBytes(encodeBytes(bytes)))).toEqual(Array.from(bytes));
  });
});

describe("the operation lists", () => {
  test("the executor runs exactly the operations the protocol lists, and no refused one", () => {
    const listed = [...REQUEST_OPERATIONS, ...STREAM_OPERATIONS, ...SESSION_OPERATIONS].toSorted();
    expect([...AGENT_OPERATION_NAMES].toSorted()).toEqual(listed);
    const runnable: readonly string[] = AGENT_OPERATION_NAMES;
    for (const refused of REFUSED_OPERATIONS) expect(runnable).not.toContain(refused);
  });

  test("no operation is listed twice", () => {
    const all = [...REQUEST_OPERATIONS, ...STREAM_OPERATIONS, ...SESSION_OPERATIONS];
    expect(new Set(all).size).toBe(all.length);
  });
});
