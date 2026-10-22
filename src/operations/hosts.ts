import { z } from "zod";

import { endpointLabel, parseEndpoint } from "../host/endpoint";
import type { HostManager, HostView } from "../host/manager";
import { defineOperation } from "./define";
import type { OperationContext } from "./types";

const HostStatusSchema = z.enum(["online", "offline", "unknown"]);

const CapacitySchema = z.object({
  cpus: z
    .number()
    .nullable()
    .meta({ description: "CPUs boxes on this host may take. Null when the engine does not say." }),
  memoryBytes: z.number().nullable().meta({ description: "Memory boxes on this host may take, in bytes." }),
});

export const HostViewSchema = z.object({
  id: z.string().meta({ description: "Host id, such as local or lab. A box names its host in box.host." }),
  name: z.string(),
  transport: z.enum(["local", "unix", "tcp", "ssh"]).meta({
    description:
      "local is the machine MiniBox runs on. unix is another socket, tcp is mutual TLS, and ssh tunnels to the socket.",
  }),
  endpoint: z.string().meta({ description: "The endpoint, without any credential." }),
  status: HostStatusSchema,
  latencyMs: z.number().nullable().meta({ description: "Round trip of the last successful ping, in milliseconds." }),
  capacity: CapacitySchema.nullable(),
  dockerVersion: z.string().nullable(),
  error: z.string().nullable().meta({ description: "The last failed check, as text. Null once a check succeeds." }),
  boxes: z.number().int().meta({ description: "Boxes whose spec names this host." }),
  createdAt: z.string().nullable(),
});

const HostErrorSchema = z.object({
  key: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  message: z.string(),
});

const HostTestSchema = z.object({
  ok: z.boolean(),
  status: HostStatusSchema,
  latencyMs: z.number().nullable(),
  capacity: CapacitySchema.nullable(),
  dockerVersion: z.string().nullable(),
  hostKeyFingerprint: z.string().nullable().meta({
    description:
      "The SSH host key the host presented, as SHA256:…. Confirm it, then send it as hostKeyFingerprint to host.add.",
  }),
  error: HostErrorSchema.nullable(),
});

const CREDENTIAL = {
  ca: "PEM bundle of the CA that signed the engine's certificate. Stored under DATA_DIR and never returned. tcp only.",
  cert: "PEM certificate this control plane presents to the engine. Stored under DATA_DIR and never returned. tcp only.",
  key: "PEM private key matching cert. Stored under DATA_DIR and never returned. tcp only.",
  privateKey:
    "OpenSSH or PKCS#8 private key used to log in. Stored under DATA_DIR and never returned. Passphrase-protected keys are refused. ssh only.",
};

const hostFieldsInput = z.object({
  id: z.string().min(1).max(32).meta({
    description: "Host id: lowercase letters, digits and hyphens, starting with a letter. local is taken.",
  }),
  name: z.string().max(64).optional().meta({ description: "Name shown in the UI. Defaults to the id." }),
  endpoint: z.string().min(1).max(512).meta({
    description:
      "unix:///var/run/docker.sock, tcp://host:2376 (mutual TLS) or ssh://user@host (key login, socket /var/run/docker.sock).",
  }),
  ca: z.string().optional().meta({ description: CREDENTIAL.ca }),
  cert: z.string().optional().meta({ description: CREDENTIAL.cert }),
  key: z.string().optional().meta({ description: CREDENTIAL.key }),
  privateKey: z.string().optional().meta({ description: CREDENTIAL.privateKey }),
  hostKeyFingerprint: z.string().optional().meta({
    description: "The SSH host key confirmed for an ssh host, as SHA256:…, from host.test. A different key is refused.",
  }),
});

/** Credentials never reach the audit log: only the id, the name, the endpoint and the host key fingerprint are recorded. */
function hostDetail(input: z.output<typeof hostFieldsInput>) {
  return {
    id: input.id,
    name: input.name ?? null,
    endpoint: auditedEndpoint(input.endpoint),
    hostKeyFingerprint: input.hostKeyFingerprint ?? null,
  };
}

/**
 * The endpoint as the audit records it. A valid endpoint is written in its credential-free form. One that does not parse,
 * such as a URL with a password, which is refused, is recorded without whatever came before an `@`.
 */
function auditedEndpoint(raw: string): string {
  try {
    return endpointLabel(parseEndpoint(raw));
  } catch {
    return raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1***@").slice(0, 512);
  }
}

function hostsOf(ctx: OperationContext): HostManager {
  if (!ctx.hostAdmin) throw new Error("the host manager is not running");
  return ctx.hostAdmin;
}

export const hostList = defineOperation({
  name: "host.list",
  tag: "hosts",
  summary: "List hosts",
  kind: "read",
  scope: "host:manage",
  async: false,
  input: z.object({}),
  output: z.object({ hosts: z.array(HostViewSchema) }),
  rest: [{ method: "GET", path: "/api/hosts" }],
  cli: "host list",
  mcp: {
    toolset: "meta",
    name: "list_hosts",
    description:
      "List the hosts MiniBox runs boxes on, with each one's status, latency, capacity and box count. Owner only. A host that is offline keeps its entry.",
  },
  run: async (ctx) => ({ hosts: hostsOf(ctx).list() }),
});

export const hostAdd = defineOperation({
  name: "host.add",
  tag: "hosts",
  summary: "Add a host",
  kind: "write",
  scope: "host:manage",
  async: false,
  conflicts: true,
  input: hostFieldsInput,
  output: z.object({ host: HostViewSchema }),
  rest: [{ method: "POST", path: "/api/hosts", body: true, status: 201 }],
  cli: "host add",
  mcp: {
    toolset: "meta",
    name: "add_host",
    description:
      "Add a Docker host. Run test_host first to see the SSH host key, then add with that fingerprint. Credentials are stored on the control plane and are never returned. Owner only.",
  },
  activity: { action: () => "host.add", target: (input) => input.id },
  audit: {
    target: ({ id }, _resolved, result) => ({ kind: "host", id, name: result?.host.name ?? id }),
    detail: (input) => hostDetail(input),
  },
  run: async (ctx, input) => ({ host: await hostsOf(ctx).add(input) }),
});

export const hostTest = defineOperation({
  name: "host.test",
  tag: "hosts",
  summary: "Test a host connection",
  kind: "write",
  scope: "host:manage",
  async: false,
  input: hostFieldsInput,
  output: HostTestSchema,
  rest: [{ method: "POST", path: "/api/hosts/test", body: true }],
  cli: "host test",
  mcp: {
    toolset: "meta",
    name: "test_host",
    description:
      "Check a host connection without saving it: reach the engine, read its version and capacity, and for ssh report the host key it presents. Nothing is stored. Owner only.",
  },
  activity: { action: () => "host.test", target: (input) => input.id },
  audit: {
    target: ({ id }) => ({ kind: "host", id, name: id }),
    detail: (input) => hostDetail(input),
  },
  run: async (ctx, input) => hostsOf(ctx).test(input),
});

export const hostRemove = defineOperation({
  name: "host.remove",
  tag: "hosts",
  summary: "Remove a host",
  kind: "destructive",
  scope: "host:manage",
  async: false,
  conflicts: true,
  input: z.object({
    id: z.string().min(1).max(32).meta({ description: "Host id. The local host cannot be removed." }),
  }),
  output: z.object({ host: HostViewSchema }),
  rest: [{ method: "DELETE", path: "/api/hosts/:id" }],
  cli: "host remove",
  mcp: {
    toolset: "meta",
    name: "remove_host",
    description:
      "Remove a host and delete its stored credentials. Refused while the host still has boxes, volumes or checkpoints. Owner only.",
  },
  activity: { action: () => "host.remove", target: (input) => input.id },
  audit: {
    target: ({ id }, _resolved, result) => ({ kind: "host", id, name: result?.host.name ?? id }),
    detail: ({ id }) => ({ id }),
  },
  run: async (ctx, input): Promise<{ host: HostView }> => ({ host: await hostsOf(ctx).remove(input.id) }),
});

export const hostOperations = [hostList, hostAdd, hostTest, hostRemove];
