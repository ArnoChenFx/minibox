import { z } from "zod";

import { assertNoSecretInImage } from "../secrets/env";
import { createBox, getBox } from "../services/boxes";
import { assertNewBox } from "../services/capacity";
import { createSnapshot, deleteSnapshot, listSnapshots } from "../services/snapshots";
import { snapshotVisible, specViews, ttlFor } from "../tokens/model";
import { underQuota } from "../tokens/quota";
import { assertCanCreateDefaultMounts } from "./authz";
import { boxTarget, DEFAULT_RESOURCES } from "./boxes";
import { defineOperation } from "./define";
import { fromEveryHost, hostOfBox, hostOfImage, imageHosts, refuseAgent } from "./routing";
import { BoxSchema, ImageSchema, OkSchema, SnapshotSchema } from "./schemas";
import {
  boxId,
  boxName,
  boxProfile,
  cpusWithDefault,
  egressInput,
  hostId,
  memoryWithDefault,
  snapshotName,
  snapshotRef,
  startupCommandOption,
  ttl,
} from "./validation";

export const snapshotCreate = defineOperation({
  name: "snapshot.create",
  tag: "snapshots",
  summary: "Snapshot a box",
  kind: "write",
  scope: "snapshot:write",
  async: true,
  conflicts: true,
  input: z.object({ id: boxId(), name: snapshotName() }),
  output: z.object({ snapshot: SnapshotSchema }),
  rest: [{ method: "POST", path: "/api/boxes/:id/snapshots", body: true, status: 202 }],
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  precondition: async ({ host }) => refuseAgent(host, "snapshots"),
  resolve: ({ host }, input) => getBox(host, input.id),
  beforeTask: async ({ host }, _input, box) => assertNoSecretInImage(host.specs.read(box.boxId)?.env ?? []),
  exclusive: ({ host }, _input, box) => `snapshot.create:${host.host.id}:${box.id}`,
  subject: (input) => input.name,
  activity: { action: () => "snapshot.create", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host, task, principal }, input) => ({
    snapshot: await createSnapshot(host, input.id, input.name, task, principal.id),
  }),
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
    egress: egressInput(),
    ttlSec: ttl("create"),
    startupCommand: startupCommandOption(),
  }),
  output: z.object({ box: BoxSchema }),
  rest: [{ method: "POST", path: "/api/snapshots/:ref/boxes", body: true, status: 201 }],
  hostFor: (ctx, input) => hostOfImage(ctx, input.ref.trim()),
  precondition: ({ host }, input) => assertNewBox(host, input),
  activity: { action: () => "box.create", target: (input) => input.name },
  audit: { target: (input, _box, result) => ({ kind: "box", id: result?.box.id, name: input.name }) },
  run: async (ctx, input) => {
    const { host, principal, record } = ctx;
    await assertCanCreateDefaultMounts(ctx, input.name);
    return underQuota(ctx, { kind: "create", cpus: input.cpus, memoryMb: input.memoryMb }, async () => ({
      box: await createBox(
        host,
        {
          name: input.name,
          image: input.ref.trim(),
          cpus: input.cpus,
          memoryMb: input.memoryMb,
          profile: input.profile,
          templateLabel: `snapshot:${input.ref}`,
          createdBy: principal.id,
          ttlSec: ttlFor(principal, input.ttlSec),
          startupCommand: input.startupCommand,
          egress: input.egress,
        },
        record,
      ),
    }));
  },
});

const snapshotList = defineOperation({
  name: "snapshot.list",
  tag: "snapshots",
  summary: "List snapshots",
  kind: "read",
  scope: "snapshot:read",
  async: false,
  input: z.object({ host: hostId().optional() }),
  output: z.object({ snapshots: z.array(ImageSchema) }),
  rest: [{ method: "GET", path: "/api/snapshots", query: ["host"] }],
  run: async (ctx, input) => {
    const { principal, host } = ctx;
    const snapshots = await fromEveryHost(imageHosts(ctx, input.host), async (on) =>
      (await listSnapshots(on)).map((image) => ({ ...image, hostId: on.host.id })),
    );
    if (principal.type === "owner") return { snapshots };
    const boxes = specViews(host.specs.list());
    return {
      snapshots: snapshots.filter((image) =>
        snapshotVisible(principal, { createdBy: image.createdBy, sourceId: image.sourceId }, boxes),
      ),
    };
  },
});

const snapshotDelete = defineOperation({
  name: "snapshot.delete",
  tag: "snapshots",
  summary: "Delete a snapshot",
  kind: "destructive",
  scope: "snapshot:delete",
  async: false,
  input: z.object({ ref: snapshotRef(), host: hostId().optional() }),
  output: OkSchema,
  rest: [{ method: "DELETE", path: "/api/snapshots/:ref", query: ["host"] }],
  hostFor: (ctx, input) => hostOfImage(ctx, input.ref, input.host),
  precondition: async ({ host }) => refuseAgent(host, "snapshots"),
  activity: { action: () => "snapshot.delete", target: ({ ref }) => ref },
  audit: { target: ({ ref }) => ({ kind: "snapshot", name: ref }) },
  run: async ({ host }, input) => {
    await deleteSnapshot(host, input.ref);
    return { ok: true as const };
  },
});

export const snapshotOperations = [snapshotList, snapshotCreate, snapshotFork, snapshotDelete];
