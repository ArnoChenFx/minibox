import { z } from "zod";

import { createBox, getBox } from "../services/boxes";
import { assertCapacity } from "../services/capacity";
import { createSnapshot, deleteSnapshot, listSnapshots } from "../services/snapshots";
import { boxTarget, DEFAULT_RESOURCES } from "./boxes";
import { defineOperation } from "./define";
import { BoxSchema, ImageSchema, OkSchema, SnapshotSchema } from "./schemas";
import {
  boxId,
  boxName,
  boxProfile,
  cpusWithDefault,
  memoryWithDefault,
  snapshotName,
  snapshotRef,
} from "./validation";

export const snapshotCreate = defineOperation({
  name: "snapshot.create",
  tag: "snapshots",
  summary: "Snapshot a box",
  kind: "write",
  scope: "snapshot:write",
  async: false,
  input: z.object({ id: boxId(), name: snapshotName() }),
  output: z.object({ snapshot: SnapshotSchema }),
  rest: [{ method: "POST", path: "/api/boxes/:id/snapshots", body: true, status: 201 }],
  cli: "snapshot create",
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: () => "snapshot.create", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host }, input) => ({ snapshot: await createSnapshot(host, input.id, input.name) }),
});

export const snapshotFork = defineOperation({
  name: "snapshot.fork",
  tag: "snapshots",
  summary: "Create a box from a snapshot",
  kind: "write",
  scope: "box:write",
  async: false,
  conflicts: true,
  input: z.object({
    name: boxName(),
    ref: snapshotRef(),
    cpus: cpusWithDefault(DEFAULT_RESOURCES.cpus),
    memoryMb: memoryWithDefault(DEFAULT_RESOURCES.memoryMb),
    profile: boxProfile(),
  }),
  output: z.object({ box: BoxSchema }),
  rest: [{ method: "POST", path: "/api/snapshots/:ref/boxes", body: true, status: 201 }],
  cli: "snapshot fork",
  precondition: ({ host }, input) => assertCapacity(host, input),
  activity: { action: () => "box.create", target: (input) => input.name },
  audit: { target: (input, _box, result) => ({ kind: "box", id: result?.box.id, name: input.name }) },
  run: async ({ host, principal }, input) => ({
    box: await createBox(host, {
      name: input.name,
      image: input.ref.trim(),
      cpus: input.cpus,
      memoryMb: input.memoryMb,
      profile: input.profile,
      templateLabel: `snapshot:${input.ref}`,
      createdBy: principal.type,
    }),
  }),
});

export const snapshotList = defineOperation({
  name: "snapshot.list",
  tag: "snapshots",
  summary: "List snapshots",
  kind: "read",
  scope: "snapshot:read",
  async: false,
  input: z.object({}),
  output: z.object({ snapshots: z.array(ImageSchema) }),
  rest: [{ method: "GET", path: "/api/snapshots" }],
  cli: "snapshot list",
  run: async ({ host }) => ({ snapshots: await listSnapshots(host) }),
});

export const snapshotDelete = defineOperation({
  name: "snapshot.delete",
  tag: "snapshots",
  summary: "Delete a snapshot",
  kind: "destructive",
  scope: "snapshot:delete",
  async: false,
  input: z.object({ ref: snapshotRef() }),
  output: OkSchema,
  rest: [{ method: "DELETE", path: "/api/snapshots/:ref" }],
  cli: "snapshot rm",
  activity: { action: () => "snapshot.delete", target: ({ ref }) => ref },
  audit: { target: ({ ref }) => ({ kind: "snapshot", name: ref }) },
  run: async ({ host }, input) => {
    await deleteSnapshot(host, input.ref);
    return { ok: true as const };
  },
});

export const snapshotOperations = [snapshotList, snapshotCreate, snapshotFork, snapshotDelete];
