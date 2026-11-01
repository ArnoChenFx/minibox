import { z } from "zod";

import { AppError, conflict, notFound } from "../lib/errors";
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
  mode: z.enum(["sync", "only"]).meta({
    description:
      "sync keeps a local checkpoint repository and copies to this one. only has no local repository: every checkpoint is taken, restored and deleted on the remote, so every one of those needs a network connection to the target.",
  }),
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

/** The last failed copy, as the read of a configured remote reports it. */
const RemoteFailureSchema = z.object({
  targetId: z.string().meta({ description: "The target the failed copy was sent to." }),
  at: z.string().meta({ description: "When that copy failed, ISO 8601." }),
  message: z.string().meta({ description: "Why it failed, as the engine or the target reported it." }),
});

/**
 * A configured remote, with the sync service's in-memory failure state. A successful copy clears both fields; the
 * count is not durable, so a restart reads it as zero. An unset remote keeps the shape of `{ remote: null }`.
 */
const RemoteRepoStateSchema = RemoteRepoSchema.extend({
  failures: z
    .number()
    .int()
    .min(0)
    .meta({ description: "How many copies in a row have failed. Zero after a success." }),
  lastFailure: RemoteFailureSchema.nullable().meta({
    description: "The last failed copy, or null when the last copy succeeded or none has run.",
  }),
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
  mode: z.enum(["sync", "only"]).optional().meta({
    description:
      "How the host uses the repository. sync (default) keeps the local repository and copies to this one. only keeps no local repository and does everything on the remote. Moving to, from or within only needs a host with no checkpoint records, including those in the recycle bin.",
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
  output: z.object({
    remote: RemoteRepoStateSchema.nullable(),
    records: z.number().int().min(0).meta({
      description:
        "How many checkpoint records the host holds, recycle bin entries included. A bin entry still names a snapshot in the repository it was taken in, so it locks a remote-only host's position.",
    }),
  }),
  rest: [{ method: "GET", path: "/api/hosts/:id/checkpoint-remote" }],
  hostFor: (ctx, input) => hostById(ctx, input.id),
  run: async ({ targets, checkpointRemote }, input) => {
    const service = targetsOf(targets);
    const records = service.checkpointRecordCount(input.id);
    const remote = service.remoteOf(input.id);
    if (!remote) return { remote: null, records };
    const state = checkpointRemote?.stateOf(input.id) ?? { failures: 0, lastFailure: null };
    return { remote: { ...remote, ...state }, records };
  },
});

const checkpointRemoteSet = defineOperation({
  name: "checkpoint.remote.set",
  tag: "checkpoints",
  summary: "Set a host's remote checkpoint repository",
  kind: "write",
  scope: REMOTE_SCOPE,
  async: false,
  conflicts: true,
  longSync: true,
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
  run: async ({ host, targets, checkpointRemote }, input) => {
    const service = targetsOf(targets);
    const move = service.remoteMove(input.id, input);
    // A save that changes nothing is answered from what is stored: it is not a reason to open the remote again.
    if (!move.changed) {
      const current = service.remoteOf(input.id);
      if (current) return { remote: current };
    }
    const apply = async () => {
      const before = service.remoteOf(input.id);
      // A remote-only host has no local repository to fall back on, so the repository is opened before the position is
      // saved. A wrong password or an unreachable target refuses the save with the reason restic gave.
      if (move.mode === "only") {
        const repository = await service.previewRemoteRepository(input.id, input);
        try {
          await host.checkpointEngine.checkRemote(host, repository);
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          throw new AppError(502, "bad_gateway", msg("checkpoint_remote_check_failed", { reason }), { reason });
        }
      }
      const remote = service.setRemote(input.id, input);
      if (
        before &&
        (before.targetId !== remote.targetId || before.path !== remote.path || before.mode !== remote.mode)
      ) {
        checkpointRemote?.forgetMarks(input.id, before.targetId);
      }
      return { remote };
    };
    // Only a change that involves the remote-only mode is a relocation: a sync host may still change its folder with
    // records, as before, and does not hold the gate while it does.
    return move.involvesOnly ? await host.checkpoints.relocating(input.id, apply) : await apply();
  },
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
  run: async ({ host, targets, checkpointRemote }, input) => {
    const service = targetsOf(targets);
    const before = service.remoteOf(input.id);
    const apply = async () => {
      service.clearRemote(input.id);
      if (before) checkpointRemote?.forgetMarks(input.id, before.targetId);
      return { ok: true as const };
    };
    // Clearing a remote-only repository is a relocation, so a checkpoint write in flight is refused and a take during
    // the clear cannot leave snapshots with no record. A sync remote is cleared as before.
    return before?.mode === "only" ? await host.checkpoints.relocating(input.id, apply) : await apply();
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
    if (remote.mode === "only") throw conflict(msg("checkpoint_remote_only_no_sync", { host: host.host.id }));
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
