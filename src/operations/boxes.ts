import { z } from "zod";

import type { EventTarget } from "../events/types";
import { type HostCtx, LOCAL_HOST_ID } from "../host/registry";
import { AUTO_HOST } from "../host/store";
import { AppError, badRequest, conflict } from "../lib/errors";
import { msg, type Msg } from "../lib/messages";
import { assertSecretsSet } from "../secrets/env";
import { forwardBoxPorts, runPostCreate } from "../services/box-setup";
import {
  type Box,
  type BoxUpdate,
  createBox,
  getBox,
  getLogs,
  getStats,
  getStatsWithHistory,
  listAllBoxes,
  readBox,
  restartBox,
  startBox,
  statsOf,
  stopBox,
  updateBox,
} from "../services/boxes";
import { assertCapacity, assertNewBox, assertResizeRoom } from "../services/capacity";
import { assertRepoSecretSet, cloneIntoWorkspace, WORKSPACE } from "../services/git-clone";
import { moveBox, moveConfirmation, previewMove } from "../services/move";
import { officialOfRef } from "../services/official-templates";
import { placeBox } from "../services/placement";
import { rebuildBox, rebuildWithSafety } from "../services/rebuild";
import { preRebuildSafety } from "../services/safety";
import { assertSelfTokenHost } from "../services/self-token";
import { finishSetup } from "../services/startup";
import { templateSetupOf } from "../services/template-builds";
import { deleteBoxToTrash } from "../services/trash";
import { hasRebuildFields } from "../specs/plan";
import { requireRevision } from "../specs/revision";
import { boxVisible, hostAllowed, refusal, ttlFor, viewOfBox } from "../tokens/model";
import { underQuota } from "../tokens/quota";
import { type CreateMount, isRoleMount } from "../volumes/create-mounts";
import { assertHostDiskRoom } from "../volumes/disk";
import {
  assertCanChangeMounts,
  assertCanCreateDefaultMounts,
  assertCanCreateMounts,
  assertCanSkipTrash,
  assertTemplateSetupAllowed,
} from "./authz";
import { defineOperation } from "./define";
import { hostById, hostOfBox } from "./routing";
import {
  BoxSchema,
  BoxWithStatsSchema,
  CloneStartedSchema,
  OkSchema,
  SafetyCheckpointSchema,
  SetupStartedSchema,
  StatSampleSchema,
  StatsSchema,
  TaskAcceptedSchema,
  TrashRefSchema,
} from "./schemas";
import { ensureTemplateOn } from "./templates";
import type { OperationContext } from "./types";
import {
  boxEnv,
  boxId,
  boxName,
  boxProfile,
  confirmFlag,
  createMounts,
  cpusWithDefault,
  deleteVolumeFlag,
  egressInput,
  expectedRevision,
  idleTimeout,
  safetyCheckpointFlag,
  skipTrashFlag,
  memoryWithDefault,
  optionalBoxName,
  optionalCpus,
  optionalMemoryMb,
  optionalPids,
  rebuildEnv,
  repoSource,
  rebuildMounts,
  rebuildNetwork,
  requireResources,
  requireUpdate,
  historyFlag,
  hostId,
  hostOrAuto,
  statsFlag,
  selfTokenOption,
  startupCommandOption,
  storageConfirmFlag,
  tail,
  templateImage,
  ttl,
  userLabels,
} from "./validation";

export const DEFAULT_RESOURCES = { cpus: 2, memoryMb: 4096 } as const;

export const boxTarget = (box: Pick<Box, "id" | "name">): EventTarget => ({ kind: "box", id: box.id, name: box.name });

/** Only names reach audit records: the values of plain entries and the secrets they reference stay out. */
const envNames = (env: { name: string }[] | undefined): string[] | undefined => env?.map((entry) => entry.name);

const ACTIONS: Record<"start" | "stop" | "restart", (host: HostCtx, id: string) => Promise<Box>> = {
  start: startBox,
  stop: (host, id) => stopBox(host, id, "manual"),
  restart: restartBox,
};

export const boxList = defineOperation({
  name: "box.list",
  tag: "boxes",
  summary: "List boxes",
  kind: "read",
  scope: "box:read",
  async: false,
  input: z.object({ stats: statsFlag(), host: hostId().optional() }),
  output: z.object({ boxes: z.array(BoxWithStatsSchema) }),
  rest: [{ method: "GET", path: "/api/boxes", query: ["stats", "host"] }],
  cli: "box list",
  mcp: {
    toolset: "core",
    name: "list_boxes",
    description:
      "List the boxes with the current resource usage of running boxes. Boxes on every host are listed; pass host to list one host. A box on a host that cannot be reached is listed with state unreachable.",
  },
  run: async (ctx, input) => {
    const { principal } = ctx;
    if (input.host !== undefined) hostById(ctx, input.host);
    const boxes = await listAllBoxes(ctx.allHosts?.() ?? [ctx.host], { withStats: input.stats, host: input.host });
    if (principal.type === "owner") return { boxes };
    return { boxes: boxes.filter((box) => boxVisible(principal, viewOfBox(box, box.hostId ?? LOCAL_HOST_ID))) };
  },
});

export const boxGet = defineOperation({
  name: "box.get",
  tag: "boxes",
  summary: "Get one box",
  kind: "read",
  scope: "box:read",
  async: false,
  input: z.object({ id: boxId() }),
  output: z.object({ box: BoxSchema.extend({ stats: StatsSchema.nullable() }) }),
  rest: [{ method: "GET", path: "/api/boxes/:id" }],
  cli: "box get",
  mcp: {
    toolset: "core",
    name: "get_box",
    description: "Get one box by container id, container name, stable id or box name, with its current resource usage.",
  },
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => readBox(host, input.id),
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host }, _input, box) => ({
    box: {
      ...box,
      env: host.specs.read(box.boxId)?.env ?? box.env,
      stats: await statsOf(host, box).catch(() => null),
    },
  }),
});

/**
 * The hosts a create may place a box on: every host for the owner, and only the granted ones for a token. Automatic
 * placement never picks, or even reads, a host the caller cannot use.
 */
function grantedHosts(ctx: OperationContext): HostCtx[] {
  const hosts = ctx.allHosts?.() ?? [ctx.host];
  const { principal } = ctx;
  if (principal.type !== "token") return [...hosts];
  const granted = hosts.filter((host) => hostAllowed(principal.grants.hosts, host.host.id));
  if (granted.length === 0) throw refusal("host_not_granted", { host: AUTO_HOST });
  return granted;
}

/**
 * Prepares a new box after its create: clones the repository, forwards the ports its template's devcontainer.json names,
 * and runs the template's postCreateCommand, in that order. Box create starts it as a child task, so the create answers
 * before a large clone or a slow command finishes. It is not in the registry: the API reaches it only through box create.
 */
const SETUP_INPUT = z.object({
  id: z.string(),
  repo: z.object({ url: z.string(), branch: z.string().optional(), secretRef: z.string().optional() }).optional(),
  init: z
    .object({ postCreate: z.array(z.string()).optional(), forwardPorts: z.array(z.number().int()).optional() })
    .optional(),
});

const setupOperation = defineOperation<typeof SETUP_INPUT, typeof OkSchema, Box>({
  name: "box.setup",
  tag: "boxes",
  summary: "Set up a new box: clone its repository, forward its ports, run its postCreateCommand",
  kind: "write",
  scope: "box:write",
  async: true,
  input: SETUP_INPUT,
  output: OkSchema,
  rest: [],
  exclusive: (_ctx, _input, box) => `box.setup:${box.boxId}`,
  activity: { action: () => "box.setup", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host, task, previewBaseDomain }, input) => {
    if (!task) throw new Error("box.setup runs as a task");
    const log = (text: string) => task.log(text);
    // The startup command waits for the whole setup, not just the clone: a postCreateCommand that installs the box's
    // dependencies must have ended before the command runs. A failure of either step records why and keeps the command
    // back until the box's next start. A box with no command has no flag, so this releases nothing.
    try {
      if (input.repo) await cloneIntoWorkspace(host, input.id, input.repo, log);
      if (input.init?.forwardPorts?.length) {
        await forwardBoxPorts(host, input.id, input.init.forwardPorts, previewBaseDomain ?? null, log);
      }
      if (input.init?.postCreate) await runPostCreate(host, input.id, input.init.postCreate, log, task.signal);
    } catch (e) {
      await finishSetup(host, input.id, setupFailureOf(e));
      throw e;
    }
    await finishSetup(host, input.id, null);
    return { ok: true as const };
  },
});

/**
 * Why the setup stopped short, as the startup command's status reports it. A failed clone says so; a `postCreateCommand`
 * that exited non-zero or timed out says that it failed, and the task log holds its output and the reason.
 */
function setupFailureOf(e: unknown): Msg {
  return e instanceof AppError && e.key === "clone_failed"
    ? msg("startup_command_clone_failed")
    : msg("startup_command_setup_failed");
}

/** A clone writes into the workspace, so the new box must mount one writable. The default mounts create an empty one. */
function assertCloneWorkspace(input: { mounts?: CreateMount[]; repo?: unknown }): void {
  if (input.repo === undefined || input.mounts === undefined) return;
  if (!input.mounts.some((mount) => isRoleMount(mount) || (mount.path === WORKSPACE && mount.mode === "rw"))) {
    throw badRequest(msg("repo_needs_workspace"), { field: "repo" });
  }
}

export const boxCreate = defineOperation({
  name: "box.create",
  tag: "boxes",
  summary: "Create and start a box",
  kind: "write",
  scope: "box:write",
  async: false,
  conflicts: true,
  longSync: true,
  input: z.object({
    name: boxName(),
    template: templateImage(),
    cpus: cpusWithDefault(DEFAULT_RESOURCES.cpus),
    memoryMb: memoryWithDefault(DEFAULT_RESOURCES.memoryMb),
    profile: boxProfile(),
    egress: egressInput(),
    mounts: createMounts(),
    env: boxEnv("create"),
    idleTimeoutSec: idleTimeout(),
    ttlSec: ttl("create"),
    host: hostOrAuto().optional().meta({
      description:
        "Host to create the box on: a host id, or auto to pick the online host with the most room that holds the template. When no holder has room for an owner's official template, auto picks the roomiest other host, which builds it. Omitted, the box goes on the local host.",
    }),
    tools: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(63)
          .regex(/^[a-z][a-z0-9-]*$/),
      )
      .max(32)
      .optional()
      .meta({
        description:
          "Catalog tool ids to record on the box spec (version latest). After create, call reconcile_tools (or install_tool) to install them onto the shared tools volume.",
      }),
    startupCommand: startupCommandOption(),
    selfToken: selfTokenOption(),
    repo: repoSource(),
  }),
  output: z.object({
    box: BoxSchema,
    clone: CloneStartedSchema.optional(),
    sync: TaskAcceptedSchema.optional(),
    setup: SetupStartedSchema.optional(),
  }),
  rest: [{ method: "POST", path: "/api/boxes", body: true, status: 201 }],
  cli: "box create",
  mcp: {
    toolset: "core",
    name: "create_box",
    description:
      "Create and start a box from a template with the given CPU and memory limits and security profile. Optional selfToken gives the box's agent a self token, written to /run/minibox/self-token, for the self operations (see get_info); the token is rotated on every start and removed on stop. Optional repo clones a Git repository into /workspace once, on this first create: url, optional branch, and secretRef for a token or base64 deploy key, which is read from the secret store and never stored in the box. A template built from a devcontainer.json may also forward its ports and run its postCreateCommand once, in /workspace as dev; creating from it needs the exec scope for the command and port:expose for the ports. The setup runs as a task, returned as setup.taskId (clone.taskId as well when repo is given), and the clone needs a writable /workspace. When the host lacks the template, an owner's create first copies it from another host that holds it, or builds an official template (node, python, go or minimal) there, as a task returned as sync.taskId, and waits for it. Optional host names the machine to create it on: a host id from list_hosts, or auto to pick the online host with the most room that holds the template, or, for an owner's official template when no holder has room, the roomiest other host, which builds it (default local). Running boxes on a host may not book more CPU or memory than the host has times its overcommit ratio, checked on a control plane with more than one host. Omitting the profile uses the host default. Optional egress sets the box's network access: open (the default, which reaches the internet), none (a private network with no route out, while exec, SSH and preview still work), or proxy-only with presets and domains, which reach the internet only through a MiniBox proxy that logs each host it allows or refuses. Omitting mounts creates workspace, home, tools and cache volumes. A mounts entry is either { volume, path, mode } for a volume that exists, or { role } for a volume MiniBox creates for this box: workspace, home, tools or cache. A role the list omits is not created, so the custom list can mount the shared tools volume without the other three, or create any subset of the roles. The tools role mounts the host's shared tools volume and creates it when the host has none. An empty mounts list creates a box with no mounts. Optional idleTimeoutSec (0 disables sleep) and ttlSec set lifecycle. Optional tools is a list of catalog ids recorded on the spec; call reconcile_tools afterwards to install them. Optional env entries are { name, value } for a plain value or { name, secretRef } for a secret set with the secret API; a secret that is not set fails the create, and a reference needs the secret:use scope. Optional startupCommand is a shell command the box runs at every start, through bash -lc in /workspace; it needs the exec and secret:use scopes, and get_startup_command reads it back. A box created from a template does not inherit a startup command unless one is passed. Mounting an existing volume requires volume:attach. A read-write mount, and every role volume a new box creates, also require volume:write; the tools role also needs volume:attach when the shared volume already exists.",
  },
  hostFor: (ctx, input) => {
    if (input.host !== AUTO_HOST) return hostById(ctx, input.host ?? LOCAL_HOST_ID);
    const image = input.template ?? ctx.host.baseTemplateTag;
    return placeBox(grantedHosts(ctx), {
      cpus: input.cpus,
      memoryMb: input.memoryMb,
      image,
      buildable: ctx.principal.type === "owner" && officialOfRef(ctx.host, image) !== undefined,
    });
  },
  precondition: async ({ host }, input) => {
    assertCloneWorkspace(input);
    assertRepoSecretSet(host, input.repo);
    if (input.selfToken) assertSelfTokenHost(host);
    await assertNewBox(host, input);
  },
  activity: { action: () => "box.create", target: (input) => input.name },
  audit: {
    target: ({ name }, _box, result) => ({ kind: "box", id: result?.box.id, name }),
    detail: ({ startupCommand, ...input }) => ({
      ...input,
      env: envNames(input.env),
      ...(startupCommand === undefined ? {} : { startupCommand: "set" }),
    }),
  },
  run: async (ctx, input) => {
    const { host, principal, record } = ctx;
    if (input.mounts) {
      await assertCanCreateMounts(ctx, input.mounts, input.name);
    } else {
      await assertCanCreateDefaultMounts(ctx, input.name);
    }
    // Checked before any copy, so a create that createBox would refuse does not first move a template across.
    if (host.specs.findByName(input.name)) throw conflict(msg("box_exists", { name: input.name }));
    assertSecretsSet(host.secrets, input.env ?? []);
    const sync = await ensureTemplateOn(ctx, host, input.template ?? host.baseTemplateTag);
    const init = input.template === undefined ? null : await templateSetupOf(host, input.template);
    await assertTemplateSetupAllowed(ctx, init);
    const created = await underQuota(ctx, { kind: "create", cpus: input.cpus, memoryMb: input.memoryMb }, async () => ({
      box: await createBox(
        host,
        {
          name: input.name,
          image: input.template,
          cpus: input.cpus,
          memoryMb: input.memoryMb,
          profile: input.profile,
          createdBy: principal.id,
          mounts: input.mounts,
          env: input.env,
          idleTimeoutSec: input.idleTimeoutSec,
          ttlSec: ttlFor(principal, input.ttlSec),
          tools: input.tools,
          startupCommand: input.startupCommand,
          awaitsSetup: input.repo !== undefined || init !== null,
          egress: input.egress,
          selfToken: input.selfToken,
        },
        record,
      ),
    }));
    const started = sync === undefined ? created : { ...created, sync };
    if (input.repo === undefined && init === null) return started;
    let taskId: string;
    try {
      if (!ctx.startTask) throw new Error("box.create needs the executor to start a setup task");
      ({ taskId } = await ctx.startTask(
        setupOperation,
        { id: created.box.boxId, repo: input.repo, init: init ?? undefined },
        created.box,
      ));
    } catch (e) {
      // The setup never ran, so the command must not wait for it.
      if (input.repo !== undefined || init !== null) {
        await finishSetup(host, created.box.boxId, msg("startup_command_setup_failed"));
      }
      throw e;
    }
    const setup = { taskId };
    return input.repo === undefined ? { ...started, setup } : { ...started, clone: setup, setup };
  },
});

export const boxDelete = defineOperation({
  name: "box.delete",
  tag: "boxes",
  summary: "Delete a box",
  kind: "destructive",
  scope: "box:delete",
  async: false,
  longSync: true,
  input: z.object({ id: boxId(), deleteVolume: deleteVolumeFlag(), skipTrash: skipTrashFlag() }),
  output: z.object({
    name: z.string(),
    volumeDeleted: z.boolean(),
    volumeError: z.string().optional(),
    trash: TrashRefSchema.nullable().meta({
      description: "The recycle bin entry that kept the box's data until expiresAt, or null when none was kept.",
    }),
  }),
  rest: [{ method: "DELETE", path: "/api/boxes/:id", query: ["deleteVolume", "skipTrash"] }],
  cli: "box rm",
  mcp: {
    toolset: "core",
    name: "delete_box",
    description:
      "Delete a box and its container. Its data is first kept in the recycle bin for the retention period, and restore_trash brings it back as a new box. Pass deleteVolume to remove volumes that this box owns and that no other box mounts. Independent volumes, including the shared tools volume, are kept. Pass skipTrash true to delete without keeping a copy; that needs the owner, or a token with the trash:skip scope.",
  },
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  precondition: async (ctx, input) => {
    if (input.skipTrash) await assertCanSkipTrash(ctx);
  },
  activity: { action: () => "box.delete", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: ({ host, principal, record }, input) =>
    deleteBoxToTrash(host, input.id, input.deleteVolume, {
      skipTrash: input.skipTrash,
      createdBy: principal.id,
      record,
    }),
});

export const boxAction = defineOperation({
  name: "box.action",
  tag: "boxes",
  summary: "Start, stop or restart a box",
  kind: "write",
  scope: "box:write",
  async: false,
  input: z.object({ id: boxId(), action: z.enum(["start", "stop", "restart"]) }),
  output: z.object({ box: BoxSchema }),
  rest: [
    { method: "POST", path: "/api/boxes/:id/start", fixed: { action: "start" } },
    { method: "POST", path: "/api/boxes/:id/stop", fixed: { action: "stop" } },
    { method: "POST", path: "/api/boxes/:id/restart", fixed: { action: "restart" } },
  ],
  cli: "box action",
  mcp: {
    toolset: "core",
    name: "box_action",
    description: "Start, stop or restart a box. Stopping keeps the workspace volume.",
  },
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: (input) => `box.${input.action}`, target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host }, input) => ({ box: await ACTIONS[input.action](host, input.id) }),
});

export const boxResources = defineOperation({
  name: "box.resources",
  tag: "boxes",
  summary: "Change the CPU, memory or process limit of a box",
  kind: "write",
  scope: "box:write",
  async: false,
  input: z
    .object({
      id: boxId(),
      cpus: optionalCpus(),
      memoryMb: optionalMemoryMb(),
      pids: optionalPids(),
      expectedRevision: expectedRevision(),
    })
    .superRefine((input, ctx) => requireResources(ctx, input)),
  output: z.object({ box: BoxSchema }),
  rest: [{ method: "PATCH", path: "/api/boxes/:id/resources", body: true, ifMatch: true }],
  cli: "box resize",
  precondition: ({ host }, input) => assertCapacity(host, input),
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: () => "box.resources", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async (ctx, input, box) =>
    underQuota(ctx, { kind: "resize", boxId: box.boxId, cpus: input.cpus, memoryMb: input.memoryMb }, async () => {
      await assertResizeRoom(ctx.host, box, input);
      return {
        box: await updateBox(ctx.host, input.id, requireRevision(input.expectedRevision), {
          cpus: input.cpus,
          memoryMb: input.memoryMb,
          pids: input.pids,
        }),
      };
    }),
});

function inPlacePatch(input: {
  name?: string;
  cpus?: number;
  memoryMb?: number;
  pids?: number;
  labels?: Record<string, string>;
  idleTimeoutSec?: number | null;
  ttlSec?: number | null;
}): BoxUpdate | undefined {
  const patch: BoxUpdate = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.cpus !== undefined) patch.cpus = input.cpus;
  if (input.memoryMb !== undefined) patch.memoryMb = input.memoryMb;
  if (input.pids !== undefined) patch.pids = input.pids;
  if (input.labels !== undefined) patch.labels = input.labels;
  if (input.idleTimeoutSec !== undefined) patch.idleTimeoutSec = input.idleTimeoutSec;
  if (input.ttlSec !== undefined) patch.ttlSec = input.ttlSec;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

export const boxUpdate = defineOperation({
  name: "box.update",
  tag: "boxes",
  summary: "Update a box in place",
  kind: "write",
  scope: "box:write",
  async: false,
  conflicts: true,
  input: z
    .object({
      id: boxId(),
      name: optionalBoxName(),
      cpus: optionalCpus(),
      memoryMb: optionalMemoryMb(),
      pids: optionalPids(),
      labels: userLabels(),
      idleTimeoutSec: idleTimeout(),
      ttlSec: ttl(),
      template: templateImage(),
      mounts: rebuildMounts(),
      env: rebuildEnv(),
      network: rebuildNetwork(),
      egress: egressInput(),
      profile: boxProfile(),
      expectedRevision: expectedRevision(),
    })
    .superRefine((input, ctx) => requireUpdate(ctx, input)),
  output: z.object({ box: BoxSchema }),
  rest: [{ method: "PATCH", path: "/api/boxes/:id", body: true, ifMatch: true }],
  cli: "box update",
  mcp: {
    toolset: "core",
    name: "update_box",
    description:
      "Change a box in place: name, CPU, memory, process limit, labels, idle timeout or TTL. Pass expectedRevision, the box's current revision. Container labels are not changed. Template, mounts, env, network, egress and profile are not applied in place: a difference returns 409 confirmation_required with a preview. Apply those with rebuild_box and confirm true. Attaching or detaching a volume rebuilds the box the same way, through attach_volume and detach_volume.",
  },
  precondition: ({ host }, input) => assertCapacity(host, input),
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: () => "box.update", target: (_input, box) => box.name },
  audit: {
    target: (_input, box) => box && boxTarget(box),
    detail: (input) => ({ ...input, env: envNames(input.env) }),
  },
  run: async (ctx, input, box) => {
    const { host, principal } = ctx;
    if (input.mounts) await assertCanChangeMounts(ctx, input.mounts, box.mounts);
    const request = {
      template: input.template,
      mounts: input.mounts,
      env: input.env,
      network: input.network,
      egress: input.egress,
      profile: input.profile,
    };
    const patch = inPlacePatch({
      ...input,
      ttlSec: input.ttlSec === undefined ? undefined : ttlFor(principal, input.ttlSec),
    });
    return underQuota(
      ctx,
      { kind: "resize", boxId: box.boxId, cpus: input.cpus, memoryMb: input.memoryMb },
      async () => {
        await assertResizeRoom(host, box, input);
        if (hasRebuildFields(request)) {
          try {
            await rebuildBox(host, input.id, requireRevision(input.expectedRevision), request, false);
          } catch (e) {
            if (!(e instanceof AppError && e.key === "rebuild_empty" && patch)) throw e;
          }
        }
        if (!patch) throw badRequest(msg("rebuild_empty"));
        return { box: await updateBox(host, input.id, requireRevision(input.expectedRevision), patch) };
      },
    );
  },
});

export const boxRebuild = defineOperation({
  name: "box.rebuild",
  tag: "boxes",
  summary: "Rebuild a box from its spec",
  kind: "destructive",
  scope: "box:write",
  async: false,
  conflicts: true,
  longSync: true,
  input: z.object({
    id: boxId(),
    template: templateImage(),
    mounts: rebuildMounts(),
    env: rebuildEnv(),
    network: rebuildNetwork(),
    egress: egressInput(),
    profile: boxProfile(),
    confirm: confirmFlag(),
    safetyCheckpoint: safetyCheckpointFlag(),
    expectedRevision: expectedRevision(),
  }),
  output: z.object({
    box: BoxSchema,
    safety: SafetyCheckpointSchema.nullable().meta({
      description: "The checkpoint taken before the rebuild, which a rollback can use, or null when none was taken.",
    }),
  }),
  rest: [{ method: "POST", path: "/api/boxes/:id/rebuild", body: true, ifMatch: true }],
  cli: "box rebuild",
  mcp: {
    toolset: "rebuild",
    name: "rebuild_box",
    description:
      "Rebuild a box when the template, mounts, env, network, egress or security profile must change. egress moves the box between open, none and proxy-only; the box keeps its private subnet when it stays private. Without confirm true, the call is refused and the result includes a preview of the docker diff and the planned changes. The writable layer, running processes and the container IP are lost. Volumes, the stable id, the name and revision history are kept. A confirmed rebuild renames the container to <prefix>-<id> (decision D6: claim does not rename). A box whose template is a tag follows the tag: when the tag names another image, the preview lists it as a template change, and a confirmed rebuild runs the box on that image. A secret's value is read at rebuild, so a secret changed since the box was built takes effect here. Before a confirmed rebuild, a checkpoint of the box's data is taken unless safetyCheckpoint is false; a failed rebuild is rolled back to the box as it was, and output.safety names the checkpoint. Pass expectedRevision, the box's current revision.",
  },
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: () => "box.rebuild", target: (_input, box) => box.name },
  audit: {
    target: (_input, box) => box && boxTarget(box),
    detail: (input) => ({
      confirm: input.confirm,
      safetyCheckpoint: input.safetyCheckpoint,
      template: input.template,
      profile: input.profile,
      network: input.network,
      egress: input.egress,
      mounts: input.mounts,
      env: envNames(input.env),
    }),
  },
  run: async (ctx, input, box) => {
    if (input.mounts) await assertCanChangeMounts(ctx, input.mounts, box.mounts);
    return rebuildWithSafety(
      ctx.host,
      input.id,
      requireRevision(input.expectedRevision),
      {
        template: input.template,
        mounts: input.mounts,
        env: input.env,
        network: input.network,
        egress: input.egress,
        profile: input.profile,
      },
      input.confirm,
      ctx.record,
      input.safetyCheckpoint ? preRebuildSafety(ctx.host, ctx.principal.id) : null,
    );
  },
});

const LeftoverSchema = z.object({
  kind: z.enum(["container", "volume"]),
  name: z.string(),
});

export const boxMove = defineOperation({
  name: "box.move",
  tag: "boxes",
  summary: "Move a box to another host",
  kind: "write",
  scope: "box:write",
  async: true,
  conflicts: true,
  input: z.object({
    id: boxId(),
    host: hostId().meta({ description: "The host to move the box to. It must differ from the box's current host." }),
    confirm: storageConfirmFlag(),
    expectedRevision: expectedRevision(),
  }),
  output: z.object({
    box: BoxSchema,
    from: hostId(),
    to: hostId(),
    checkpoints: z.number().int().meta({
      description: "Checkpoints the box has on its old host. They stay there and are not restored on the new one.",
    }),
    leftovers: z.array(LeftoverSchema).meta({
      description: "What stayed on the old host after the move, when its removal failed. Empty when it was cleaned up.",
    }),
  }),
  rest: [{ method: "POST", path: "/api/boxes/:id/move", body: true, ifMatch: true, status: 202 }],
  cli: "box move",
  mcp: {
    toolset: "move",
    name: "move_box",
    description:
      "Move a box to another host. Owner or admin only: the token needs box write and every host and box granted, as the admin preset has. Without confirm true the call is refused with a preview: the volumes that would be copied or attached, whether the box starts on the new host, the template image that would be sent, and the state that is lost. With confirm, the image is sent, local volumes are copied, the box is recreated on the new host and started there if it runs now, and the old container is removed once the new one runs. NFS volumes stay where they are and are attached on the new host. Bind mounts and volumes MiniBox did not create refuse the move. The box keeps its id, name, volumes, env and history, and loses its writable layer, processes and IP. Its checkpoints stay on the old host. Pass expectedRevision, the box's current revision.",
  },
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  beforeTask: async (ctx, input) => {
    const preview = await previewMove(
      ctx.host,
      hostById(ctx, input.host),
      input.id,
      requireRevision(input.expectedRevision),
    );
    if (!input.confirm) throw moveConfirmation(preview);
    await assertHostDiskRoom(hostById(ctx, input.host));
  },
  exclusive: ({ host }, _input, box) => `box.move:${host.host.id}:${box.boxId}`,
  activity: { action: () => "box.move", target: (_input, box) => box.name },
  audit: {
    target: (_input, box) => box && boxTarget(box),
    detail: (input) => ({ host: input.host, confirm: input.confirm }),
  },
  run: async (ctx, input) => {
    const result = await moveBox(
      ctx.host,
      hostById(ctx, input.host),
      input.id,
      requireRevision(input.expectedRevision),
      ctx.task,
    );
    return {
      box: result.box,
      from: result.from,
      to: result.to,
      checkpoints: result.checkpoints,
      leftovers: [...result.leftovers],
    };
  },
});

export const boxLogs = defineOperation({
  name: "box.logs",
  tag: "boxes",
  summary: "Read the recent log output of a box",
  kind: "read",
  scope: "box:read",
  async: false,
  input: z.object({ id: boxId(), tail: tail() }),
  output: z.object({ logs: z.string() }),
  rest: [{ method: "GET", path: "/api/boxes/:id/logs", query: ["tail"] }],
  cli: "box logs",
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => readBox(host, input.id),
  audit: { target: ({ id }) => ({ kind: "box", name: id }) },
  run: async ({ host }, input) => ({ logs: await getLogs(host, input.id, input.tail) }),
});

export const boxStats = defineOperation({
  name: "box.stats",
  tag: "boxes",
  summary: "Read the current resource usage of a box",
  kind: "read",
  scope: "box:read",
  async: false,
  input: z.object({ id: boxId(), history: historyFlag() }),
  output: z.object({ stats: StatsSchema.nullable(), history: z.array(StatSampleSchema).optional() }),
  rest: [{ method: "GET", path: "/api/boxes/:id/stats", query: ["history"] }],
  cli: "box stats",
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => readBox(host, input.id),
  audit: { target: ({ id }) => ({ kind: "box", name: id }) },
  run: async ({ host }, input) => {
    if (!input.history) return { stats: await getStats(host, input.id) };
    return getStatsWithHistory(host, input.id);
  },
});

export const boxOperations = [
  boxList,
  boxGet,
  boxCreate,
  boxDelete,
  boxAction,
  boxResources,
  boxUpdate,
  boxRebuild,
  boxMove,
  boxLogs,
  boxStats,
];
