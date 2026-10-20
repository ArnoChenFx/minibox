import { z } from "zod";

import { createBox, getBox } from "../services/boxes";
import { assertCapacity } from "../services/capacity";
import { createSnapshot } from "../services/snapshots";
import { DEFAULT_RESOURCES } from "./boxes";
import { defineOperation } from "./define";
import { BoxSchema, SnapshotSchema } from "./schemas";
import { boxId, boxName, cpusWithDefault, memoryWithDefault, snapshotName, snapshotRef } from "./validation";

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
  }),
  output: z.object({ box: BoxSchema }),
  rest: [{ method: "POST", path: "/api/snapshots/:ref/boxes", body: true, status: 201 }],
  cli: "snapshot fork",
  precondition: ({ host }, input) => assertCapacity(host, input),
  activity: { action: () => "box.create", target: (input) => input.name },
  run: async ({ host }, input) => ({
    box: await createBox(host, {
      name: input.name,
      image: input.ref.trim(),
      cpus: input.cpus,
      memoryMb: input.memoryMb,
      templateLabel: `snapshot:${input.ref}`,
    }),
  }),
});

export const snapshotOperations = [snapshotCreate, snapshotFork];
