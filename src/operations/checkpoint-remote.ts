import { z } from "zod";

import { notFound } from "../lib/errors";
import { msg } from "../lib/messages";
import type { TargetService } from "../services/targets";
import { defineOperation } from "./define";
import { hostById } from "./routing";
import { OkSchema } from "./schemas";
import { hostId } from "./validation";

/** The host's checkpoint repository and its credentials are the owner's alone: no token holds this scope. */
const REMOTE_SCOPE = "target:manage";

const RemoteRepoSchema = z.object({
  hostId: z.string().meta({ description: "The host whose snapshots are copied." }),
  targetId: z.string().meta({ description: "The target the remote repository lives on." }),
  targetName: z.string().meta({ description: "The target's name, for display." }),
  kind: z.enum(["s3", "sftp"]).meta({ description: "The target kind. A WebDAV target cannot hold a repository." }),
  path: z.string().meta({
    description:
      "The folder on the target that holds this host's restic repository, with the host id appended. No credential is in it.",
  }),
  lastSyncAt: z.string().nullable().meta({
    description: "When the last copy succeeded, or null when none has. A failed copy does not move it.",
  }),
  lastError: z.string().nullable().meta({
    description: "Why the last copy failed, or null when it succeeded. Cleared by the next successful copy.",
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const RemoteSyncSummarySchema = z.object({
  hostId: z.string(),
  targetId: z.string(),
  checkpoints: z.number().int().min(0).meta({ description: "How many checkpoint records were copied or confirmed." }),
  snapshots: z.number().int().min(0).meta({ description: "How many snapshots were asked of the remote repository." }),
});

const setInput = z.object({
  id: hostId().meta({ description: "Host id whose checkpoints are copied." }),
  targetId: z.string().max(64).meta({
    description: "The target to keep the remote repository on. It must be an S3 or an SFTP target.",
  }),
  path: z.string().max(512).optional().meta({
    description:
      "The base folder under the target. The host id is appended to it, so each host keeps a repository of its own. Empty or omitted puts it at the target's root.",
  }),
});

function targetsOf(targets: TargetService | undefined): TargetService {
  if (!targets) throw new Error("the target service is not running");
  return targets;
}

const checkpointRemoteGet = defineOperation({
  name: "checkpoint.remote.get",
  tag: "checkpoints",
  summary: "Read a host's remote checkpoint repository",
  kind: "read",
  scope: REMOTE_SCOPE,
  async: false,
  input: z.object({ id: hostId() }),
  output: z.object({ remote: RemoteRepoSchema.nullable() }),
  rest: [{ method: "GET", path: "/api/hosts/:id/checkpoint-remote" }],
  hostFor: (ctx, input) => hostById(ctx, input.id),
  run: async ({ targets }, input) => ({ remote: targetsOf(targets).remoteOf(input.id) }),
});

const checkpointRemoteSet = defineOperation({
  name: "checkpoint.remote.set",
  tag: "checkpoints",
  summary: "Set a host's remote checkpoint repository",
  kind: "write",
  scope: REMOTE_SCOPE,
  async: false,
  conflicts: true,
  input: setInput,
  output: z.object({ remote: RemoteRepoSchema }),
  rest: [{ method: "PUT", path: "/api/hosts/:id/checkpoint-remote", body: true }],
  hostFor: (ctx, input) => hostById(ctx, input.id),
  activity: { action: () => "checkpoint.remote.set", target: (input) => input.targetId },
  audit: {
    target: (input, _resolved, result) => ({
      kind: "target",
      id: input.targetId,
      name: result?.remote.targetName ?? input.targetId,
    }),
    detail: (input, _resolved, result) => ({
      hostId: input.id,
      targetId: input.targetId,
      path: result?.remote.path ?? input.path ?? "",
    }),
  },
  run: async ({ targets }, input) => ({ remote: targetsOf(targets).setRemote(input.id, input) }),
});

const checkpointRemoteClear = defineOperation({
  name: "checkpoint.remote.clear",
  tag: "checkpoints",
  summary: "Clear a host's remote checkpoint repository",
  kind: "write",
  scope: REMOTE_SCOPE,
  async: false,
  input: z.object({ id: hostId() }),
  output: OkSchema,
  rest: [{ method: "DELETE", path: "/api/hosts/:id/checkpoint-remote" }],
  hostFor: (ctx, input) => hostById(ctx, input.id),
  activity: { action: () => "checkpoint.remote.clear", target: (input) => input.id },
  audit: {
    target: (input) => ({ kind: "host", id: input.id, name: input.id }),
    detail: (input) => ({ hostId: input.id }),
  },
  run: async ({ targets }, input) => {
    targetsOf(targets).clearRemote(input.id);
    return { ok: true as const };
  },
});

const checkpointRemoteSync = defineOperation({
  name: "checkpoint.remote.sync",
  tag: "checkpoints",
  summary: "Copy a host's pending checkpoints to its remote repository",
  kind: "write",
  scope: REMOTE_SCOPE,
  async: true,
  conflicts: true,
  input: z.object({ id: hostId() }),
  output: z.object({ synced: RemoteSyncSummarySchema }),
  rest: [{ method: "POST", path: "/api/hosts/:id/checkpoint-remote/sync", status: 202 }],
  hostFor: (ctx, input) => hostById(ctx, input.id),
  resolve: async ({ host, targets }, _input) => {
    const remote = targetsOf(targets).remoteOf(host.host.id);
    if (!remote) throw notFound(msg("checkpoint_remote_not_set", { host: host.host.id }));
    return remote;
  },
  exclusive: ({ host }) => `checkpoint.remote:${host.host.id}`,
  activity: { action: () => "checkpoint.remote.sync", target: (_input, remote) => remote.targetName },
  audit: {
    target: (input, remote) => ({ kind: "target", id: remote?.targetId, name: remote?.targetName ?? input.id }),
    detail: (input, remote, result) => ({
      hostId: input.id,
      targetId: remote?.targetId ?? null,
      checkpoints: result?.synced.checkpoints ?? null,
      snapshots: result?.synced.snapshots ?? null,
    }),
  },
  run: async ({ host, checkpointRemote }) => {
    if (!checkpointRemote) throw new Error("the checkpoint remote sync is not running");
    return { synced: await checkpointRemote.syncHost(host) };
  },
});

export const checkpointRemoteOperations = [
  checkpointRemoteGet,
  checkpointRemoteSet,
  checkpointRemoteClear,
  checkpointRemoteSync,
];
