import { z } from "zod";

import { TRASH_KINDS } from "../checkpoints/types";
import type { EventTarget } from "../events/types";
import {
  assertRestorable,
  listTrash,
  purgeEntry,
  restoreResources,
  restoreTrash,
  type TrashRecord,
  trashRecord,
} from "../services/trash";
import { type PurgedEntry, previewEmptyTrash, purgeScanned, scanTrash } from "../services/trash-empty";
import { confirmationRequired, getVolume } from "../services/volumes";
import { assertWithinQuota, underQuota } from "../tokens/quota";
import { assertCanCreateDefaultMounts } from "./authz";
import { defineOperation } from "./define";
import { fromEveryHost, hostOfCheckpoint } from "./routing";
import { BoxSchema, OkSchema, OutcomeSchema, TrashEntrySchema } from "./schemas";
import { optionalCpus, optionalMemoryMb, restoredName, storageConfirmFlag } from "./validation";
import { VolumeSchema } from "./volumes";

export const trashId = () => z.string().meta({ description: "Recycle bin entry id (ck_…), as trash.list shows it." });

const trashTarget = (entry: TrashRecord): EventTarget => ({
  kind: "trash",
  id: entry.id,
  name: entry.trash.sourceName,
});

export const trashList = defineOperation({
  name: "trash.list",
  tag: "trash",
  summary: "List the recycle bin",
  kind: "read",
  scope: "trash:read",
  async: false,
  input: z.object({}),
  output: z.object({ trash: z.array(TrashEntrySchema) }),
  rest: [{ method: "GET", path: "/api/trash" }],
  cli: "trash ls",
  mcp: {
    toolset: "storage",
    name: "list_trash",
    description:
      "List the recycle bin: the deleted boxes and volumes whose data is kept, newest deletion first, with the time each one expires. restore_trash brings an entry back as a new box or volume, and purge_trash removes it now. Owner only.",
  },
  run: async ({ host, allHosts }) => ({ trash: await fromEveryHost(allHosts?.() ?? [host], listTrash) }),
});

export const trashRestore = defineOperation({
  name: "trash.restore",
  tag: "trash",
  summary: "Restore a recycle bin entry as a new box or volume",
  kind: "write",
  scope: "trash:restore",
  async: true,
  conflicts: true,
  input: z.object({
    id: trashId(),
    name: restoredName(),
    cpus: optionalCpus(),
    memoryMb: optionalMemoryMb(),
  }),
  output: z.object({ box: BoxSchema.nullable(), volume: VolumeSchema.nullable() }),
  rest: [{ method: "POST", path: "/api/trash/:id/restore", body: true, status: 202 }],
  cli: "trash restore",
  mcp: {
    toolset: "storage",
    name: "restore_trash",
    description:
      "Restore a recycle bin entry as a new box or volume, under the given name or the name it had when it was deleted. A box keeps its template, data, resources and profile, and not its environment, startup command, labels, network, TTL or shared mounts. A box needs a free name and room on its host. The entry is removed once the restore has finished. Owner only.",
  },
  hostFor: (ctx, input) => hostOfCheckpoint(ctx, input.id),
  resolve: async ({ host }, input) => trashRecord(host, input.id),
  beforeTask: async (ctx, input, found) => {
    await assertRestorable(ctx.host, found, input);
    if (found.trash.kind !== "box") return;
    await assertCanCreateDefaultMounts(ctx, input.name ?? found.trash.sourceName);
    assertWithinQuota(ctx, { kind: "create", ...restoreResources(found, input) });
  },
  exclusive: ({ host }, _input, found) => `trash.item:${host.host.id}:${found.id}`,
  activity: { action: () => "trash.restore", target: (_input, found) => found.trash.sourceName },
  audit: { target: (_input, found) => found && trashTarget(found) },
  run: async (ctx, input, found) => {
    const restore = () => restoreTrash(ctx.host, found.id, input, ctx.principal.id, ctx.task, ctx.record);
    const result =
      found.trash.kind === "box"
        ? await underQuota(ctx, { kind: "create", ...restoreResources(found, input) }, restore)
        : await restore();
    return {
      box: result.box,
      volume: result.volume ? await getVolume(ctx.host, result.volume.id) : null,
    };
  },
});

export const trashPurge = defineOperation({
  name: "trash.purge",
  tag: "trash",
  summary: "Purge a recycle bin entry now",
  kind: "destructive",
  scope: "trash:purge",
  async: true,
  conflicts: true,
  input: z.object({ id: trashId() }),
  output: OkSchema,
  rest: [{ method: "DELETE", path: "/api/trash/:id", status: 202 }],
  cli: "trash purge",
  mcp: {
    toolset: "storage",
    name: "purge_trash",
    description:
      "Remove a recycle bin entry and its kept data now, before its retention ends. The data cannot be restored afterwards. Owner only.",
  },
  hostFor: (ctx, input) => hostOfCheckpoint(ctx, input.id),
  resolve: async ({ host }, input) => trashRecord(host, input.id),
  exclusive: ({ host }, _input, found) => `trash.item:${host.host.id}:${found.id}`,
  activity: { action: () => "trash.purge", target: (_input, found) => found.trash.sourceName },
  audit: { target: (_input, found) => found && trashTarget(found) },
  run: async (ctx, input) => {
    await purgeEntry(ctx.host, input.id, "requested", ctx.record);
    return { ok: true as const };
  },
});

/** An empty names at most this many entries, so one request stays bounded. */
const EMPTY_IDS_MAX = 1000;

const EmptiedEntrySchema = z.object({
  id: z.string(),
  hostId: z.string(),
  kind: z.enum(TRASH_KINDS),
  sourceId: z.string(),
  sourceName: z.string(),
  bytes: z.number(),
  status: z.enum(["removed", "refused", "failed"]),
  blocked: z.enum(["exporting", "busy", "offline"]).nullable().meta({ description: "Why a refused entry was left." }),
  error: OutcomeSchema.nullable(),
});

const EmptiedHostSchema = z.object({
  hostId: z.string(),
  name: z.string(),
  status: z.enum(["checked", "offline", "failed"]),
  error: OutcomeSchema.nullable(),
});

const tally = (entries: readonly PurgedEntry[]) => {
  const count = (status: PurgedEntry["status"]) => entries.filter((row) => row.status === status).length;
  return {
    removed: count("removed"),
    refused: count("refused"),
    failed: count("failed"),
    bytes: entries.reduce((sum, row) => sum + (row.status === "removed" ? row.bytes : 0), 0),
  };
};

export const trashEmpty = defineOperation({
  name: "trash.empty",
  tag: "trash",
  summary: "Empty the recycle bin",
  kind: "destructive",
  scope: "trash:purge",
  async: false,
  conflicts: true,
  longSync: true,
  input: z.object({
    confirm: storageConfirmFlag(),
    ids: z
      .array(z.string().min(1))
      .min(1)
      .max(EMPTY_IDS_MAX)
      .optional()
      .meta({
        description: `Purge only these entries (ck_…), the ids trash.list showed. Without it every entry on every host is purged. An id that is no longer in the recycle bin is skipped. At most ${EMPTY_IDS_MAX}.`,
      }),
  }),
  output: z.object({
    removed: z.number().meta({ description: "How many entries were purged." }),
    refused: z.number().meta({ description: "How many entries were left, because something is using them." }),
    failed: z.number().meta({ description: "How many entries could not be purged." }),
    bytes: z.number().meta({ description: "The size of the data the purged entries kept." }),
    entries: z
      .array(EmptiedEntrySchema)
      .meta({ description: "One result per entry, newest deletion first on each host." }),
    hosts: z.array(EmptiedHostSchema).meta({
      description: "One entry per host. An offline or failing host is reported, and its entries are left.",
    }),
  }),
  rest: [{ method: "POST", path: "/api/trash/empty", body: true }],
  cli: "trash empty",
  mcp: {
    toolset: "storage",
    name: "empty_trash",
    description:
      "Permanently remove every entry in the recycle bin, on every host, now. The data cannot be restored afterwards. Each entry gets its own result, and one that cannot be purged, because it is being restored, purged or exported, or its host is offline, is reported and the rest are still purged. Without confirm true the call changes nothing and returns confirmation_required with details.preview, which lists the entries. ids limits the empty to the entries list_trash showed. Owner only.",
  },
  // The handler records the entry itself, once it knows the counts.
  activity: { action: () => "trash.empty", target: () => "recycle bin", when: () => false },
  audit: {
    detail: (input, _resolved, result) => ({
      named: input.ids?.length ?? null,
      removed: result?.removed ?? 0,
      refused: result?.refused ?? 0,
      failed: result?.failed ?? 0,
      bytes: result?.bytes ?? 0,
    }),
  },
  run: async (ctx, input) => {
    const hosts = ctx.allHosts?.() ?? [ctx.host];
    const opts = { ids: input.ids ?? null, tasks: ctx.tasks, record: ctx.record };
    const scan = await scanTrash(hosts, opts);
    if (!input.confirm) throw confirmationRequired(previewEmptyTrash(scan));
    const entries = await purgeScanned(hosts, scan, opts);
    const counts = tally(entries);
    if (entries.length > 0) {
      const problems = counts.refused + counts.failed;
      ctx.recordActivity?.({
        action: "trash.empty",
        target: `${counts.removed}/${entries.length}`,
        ok: problems === 0,
        ...(problems > 0 ? { message: entries.find((row) => row.error)?.error?.message ?? "" } : {}),
      });
    }
    return { ...counts, entries, hosts: scan.hosts };
  },
});

export const trashOperations = [trashList, trashRestore, trashPurge, trashEmpty];
