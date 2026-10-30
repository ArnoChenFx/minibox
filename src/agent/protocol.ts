import { createPublicKey, type KeyObject, sign, verify } from "node:crypto";

import { z } from "zod";

/**
 * The wire protocol between the control plane and a MiniBox agent. Every frame is one JSON text message on the WebSocket.
 * The version changes when a frame or an operation changes shape. A control plane refuses an agent that speaks another
 * version, and the console then asks for an upgrade.
 */
export const AGENT_PROTOCOL = 1;
export const AGENT_CONNECT_PATH = "/api/agent/connect";
export const AGENT_PAIR_PATH = "/api/agent/pair";

/** Close codes of the agent socket. They sit in the range WebSocket leaves to applications. */
export const AGENT_CLOSE = {
  authFailed: 4401,
  revoked: 4403,
  helloTimeout: 4408,
  replaced: 4409,
  silent: 4410,
  /** Too many sockets were already waiting for a hello, so this one was closed before it was challenged. */
  tooManyPending: 4411,
  protocolMismatch: 4426,
} as const;

/** How long a socket may stay open without a valid hello. The agent signs as soon as the challenge arrives, so this is generous. */
export const AGENT_HELLO_TIMEOUT_MS = 5_000;
/** How often an agent sends a heartbeat. The control plane's idle timeout is longer than this. */
export const AGENT_HEARTBEAT_MS = 10_000;

/** Operations that answer once. */
export const REQUEST_OPERATIONS = [
  "ping",
  "info",
  "listContainers",
  "inspectContainer",
  "inspectEnv",
  "createContainer",
  "startContainer",
  "stopContainer",
  "restartContainer",
  "pauseContainer",
  "unpauseContainer",
  "removeContainer",
  "renameContainer",
  "updateContainer",
  "containerLogs",
  "containerStats",
  "containerDiff",
  "listImages",
  "inspectImage",
  "pullImage",
  "inspectVolume",
  "listVolumes",
  "createVolume",
  "removeVolume",
  "setVolumeRootOwner",
  "ensureBridgeNetwork",
  "removeNetwork",
  "connectNetwork",
  "listNetworks",
  "reattachNetwork",
  "setHostIngressBlock",
] as const;

/** Operations that open a stream. The request's id names the stream in every later frame. */
export const STREAM_OPERATIONS = ["startExec", "followLogs", "events"] as const;

/** Operations on an open exec session, named by the id of the `startExec` request that opened it. */
export const SESSION_OPERATIONS = ["execResize", "execInspect", "execKill"] as const;

/**
 * Runtime methods an agent never runs. A control plane that asks for one gets `unsupported`, and so does an agent that
 * is sent one. They read or write archives or files in a box, build or save images, run arbitrary helper containers,
 * or measure the disk. An agent host has no `docker system df` read either: the agent's engine is not the control
 * plane's to measure.
 */
export const REFUSED_OPERATIONS = [
  "commitContainer",
  "checkHostForward",
  "allowHostForward",
  "putArchive",
  "writeContainerFile",
  "getArchive",
  "statPath",
  "volumeRootOwner",
  "removeImage",
  "saveImage",
  "loadImage",
  "buildImage",
  "runHelper",
  "diskUsage",
  "diskBreakdown",
] as const;

const ERROR_KINDS = ["not_found", "conflict", "invalid", "unavailable", "engine", "unsupported", "aborted"] as const;
type AgentErrorKind = (typeof ERROR_KINDS)[number];

export interface AgentErrorInfo {
  kind: AgentErrorKind;
  message: string;
  detail: string;
}

const ID = z.string().min(1).max(64);
const TEXT = z.string().max(4096);
const ErrorInfoSchema = z.object({
  kind: z.enum(ERROR_KINDS),
  message: z.string().max(4096),
  detail: z.string().max(4096),
});

/** An exec's state once it has ended. It travels with the `end` frame, so its exit code outlives the agent's session. */
const ExecExitSchema = z.object({
  running: z.boolean(),
  exitCode: z.number().int().nullable(),
  pid: z.number().int().nullable(),
});
export type ExecExit = z.infer<typeof ExecExitSchema>;

/** A frame the control plane sends to an agent. */
export const ServerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("challenge"),
    nonce: z.string().min(16).max(128),
    protocol: z.number().int(),
    serverVersion: TEXT,
  }),
  z.object({ type: z.literal("welcome"), hostId: ID, protocol: z.number().int() }),
  z.object({
    type: z.literal("refused"),
    code: z.enum(["auth_failed", "protocol_mismatch", "revoked"]),
    message: TEXT,
  }),
  z.object({ type: z.literal("request"), id: ID, op: z.string().min(1).max(64), args: z.unknown() }),
  z.object({ type: z.literal("input"), id: ID, data: z.string() }),
  z.object({ type: z.literal("input_end"), id: ID }),
  z.object({ type: z.literal("cancel"), id: ID }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

/** A frame an agent sends to the control plane. */
export const AgentFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    agentId: ID,
    protocol: z.number().int(),
    version: z.string().max(64),
    signature: z.string().min(1).max(256),
  }),
  z.object({
    type: z.literal("response"),
    id: ID,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: ErrorInfoSchema.optional(),
  }),
  z.object({ type: z.literal("item"), id: ID, value: z.unknown() }),
  z.object({
    type: z.literal("data"),
    id: ID,
    channel: z.enum(["stdout", "stderr"]),
    data: z.string(),
  }),
  z.object({ type: z.literal("end"), id: ID, error: ErrorInfoSchema.optional(), exit: ExecExitSchema.optional() }),
  z.object({ type: z.literal("heartbeat"), at: z.string().max(64) }),
]);
export type AgentFrame = z.infer<typeof AgentFrameSchema>;

/** Body of `POST /api/agent/pair`. The public key is the agent's Ed25519 key in SPKI PEM form. */
export const PairRequestSchema = z.object({
  code: z.string().min(1).max(32),
  publicKey: z.string().min(1).max(2048),
  version: z.string().max(64),
  protocol: z.number().int(),
});
export type PairRequest = z.infer<typeof PairRequestSchema>;

export const PairResponseSchema = z.object({
  agentId: ID,
  hostId: ID,
  protocol: z.number().int(),
});
export type PairResponse = z.infer<typeof PairResponseSchema>;

/** The bytes an agent signs to prove it holds the key. The nonce is per connection, so a signature cannot be replayed. */
function helloMessage(nonce: string, agentId: string, protocol: number): Buffer {
  return Buffer.from(`minibox-agent-hello\n${nonce}\n${agentId}\n${protocol}`);
}

export function signHello(key: KeyObject, nonce: string, agentId: string, protocol: number): string {
  return sign(null, helloMessage(nonce, agentId, protocol), key).toString("base64");
}

export function verifyHello(
  publicKeyPem: string,
  nonce: string,
  agentId: string,
  protocol: number,
  signature: string,
): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verify(null, helloMessage(nonce, agentId, protocol), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/** Whether a PEM string is an Ed25519 public key, the only kind an agent may pair with. */
export function isEd25519PublicKey(publicKeyPem: string): boolean {
  try {
    return createPublicKey(publicKeyPem).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

/** Parses one frame. Returns null for anything that is not valid JSON of the frame's shape. */
export function parseFrame<T>(schema: z.ZodType<T>, text: string): T | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export function encodeBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function decodeBytes(text: string): Buffer {
  return Buffer.from(text, "base64");
}
