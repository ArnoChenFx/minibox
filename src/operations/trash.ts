import { z } from "zod";

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
import { getVolume } from "../services/volumes";
import { assertWithinQuota, underQuota } from "../tokens/quota";
import { assertCanCreateDefaultMounts } from "./authz";
import { defineOperation } from "./define";
import { fromEveryHost, hostOfCheckpoint } from "./routing";
import { BoxSchema, OkSchema, TrashEntrySchema } from "./schemas";
import { optionalCpus, optionalMemoryMb, restoredName } from "./validation";
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

export const trashOperations = [trashList, trashRestore, trashPurge];
