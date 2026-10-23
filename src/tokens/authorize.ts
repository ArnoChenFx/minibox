import type { HostCtx } from "../host/registry";
import { notFound } from "../lib/errors";
import { msg } from "../lib/messages";
import type { AuthorizeRequest } from "../operations/executor";
import type { TokenPrincipal } from "../operations/types";
import { isRuntimeError } from "../runtime";
import type { Box } from "../services/boxes";
import { getBox } from "../services/boxes";
import { type CheckpointView, getCheckpoint } from "../services/checkpoints";
import type { ExecTarget } from "../services/exec";
import type { BoxEnv } from "../specs/types";
import { INIT_SESSION } from "../startup/command";
import { inspectVolumeOrNull } from "../volumes/engine";
import type { VolumeRecord } from "../volumes/types";
import {
  type BoxView,
  boxVisible,
  hostAllowed,
  type ImageView,
  mayGiveStartupCommand,
  mayUseSecrets,
  profileForToken,
  profileRank,
  refusal,
  scopeAllowed,
  snapshotVisible,
  specViews,
  templateVisible,
  viewOfSpec,
  volumeVisible,
  volumeWritable,
} from "./model";
import { selfAllowed } from "./self";
import { SELF_SCOPE } from "./self-policy";

/**
 * The authorize hook. The owner passes every check. A token passes the scope check for the operation, then the
 * access rule for its target (host, box, image, volume, profile, TTL), and a service that asks about one volume passes
 * the resource check. An operation with no access rule is refused for tokens, so a new operation is owner-only until
 * it gets one.
 */
export async function authorizeOperation(request: AuthorizeRequest): Promise<boolean> {
  const { principal } = request;
  if (principal.type === "owner") return request.operation.scope !== SELF_SCOPE;
  if (principal.type === "box-self") return selfAllowed(request, principal);
  if (principal.type !== "token") return false;
  const phase = request.phase ?? "scope";
  if (phase === "scope") return scopeAllowed(principal.grants, request.operation.scope);
  if (phase === "resource") return resourceAllowed(request, principal);
  return accessAllowed(request, principal);
}

function recordOf(host: HostCtx, ref: { id?: string; name: string }): VolumeRecord | null {
  return host.volumes.resolve(ref.id ?? ref.name, host.host.id);
}

/**
 * One volume check from a service, asked while the operation runs. `scope` is `volume:attach` or `volume:write`, or
 * absent for a create. A volume with a record is judged by its grants and owner. A name with no record is a new volume,
 * so only the scope is judged, unless an unclaimed engine volume already has that name: then it belongs to someone and
 * a token may not take it over. The shared tools volume is attachable by every token, because every new box mounts it.
 */
async function resourceAllowed(request: AuthorizeRequest, principal: TokenPrincipal): Promise<boolean> {
  const host = request.host;
  if (!host) return false;
  const scope = request.scope ?? "";
  const resource = request.resource;
  if (!resource) return scopeAllowed(principal.grants, scope);
  const record = recordOf(host, resource);
  if (!record) {
    if (resource.id !== undefined) return false;
    if (await inspectVolumeOrNull(host, resource.name)) return false;
    return scopeAllowed(principal.grants, scope);
  }
  if (scope === "volume:attach" && record.role === "tools") return true;
  if (!scopeAllowed(principal.grants, scope)) return false;
  const views = specViews(host.specs.list());
  if (scope === "volume:write") return volumeWritable(principal, record, views);
  if (scope === "volume:attach") return volumeVisible(principal, record, views);
  return false;
}

interface Check {
  readonly principal: TokenPrincipal;
  readonly host: HostCtx;
  readonly input: Record<string, unknown>;
  readonly resolved: unknown;
}

type Rule = (check: Check) => Promise<void>;

async function accessAllowed(request: AuthorizeRequest, principal: TokenPrincipal): Promise<boolean> {
  const { host } = request;
  if (!host) throw new Error("the access check needs the host the operation runs on");
  if (!hostAllowed(principal.grants.hosts, host.host.id)) throw refusal("host_not_granted", { host: host.host.id });
  const rule = RULES.get(request.operation.name);
  if (!rule) throw refusal("operation_forbidden", { op: request.operation.name });
  await rule({ principal, host, input: request.input ?? {}, resolved: request.resolved });
  return true;
}

function isBox(value: unknown): value is Box {
  return typeof value === "object" && value !== null && "boxId" in value && typeof value.boxId === "string";
}

function boxViewOf(host: HostCtx, box: Box): BoxView {
  return {
    boxId: box.boxId,
    containerId: box.id,
    name: box.name,
    createdBy: box.createdBy,
    labels: box.labels,
    hostId: host.host.id,
  };
}

function assertBoxVisible(principal: TokenPrincipal, view: BoxView): void {
  if (!boxVisible(principal, view)) throw refusal("box_out_of_scope");
}

/** The box an operation resolved. A missing resolution is refused, so an operation without one cannot pass. */
function resolvedBox(resolved: unknown): Box {
  if (!isBox(resolved)) throw refusal("box_out_of_scope");
  return resolved;
}

const boxRule: Rule = async ({ principal, host, resolved }) => {
  assertBoxVisible(principal, boxViewOf(host, resolvedBox(resolved)));
};

/** The env a box's spec names. A rebuild or attach that keeps it injects the same secrets again. */
function storedEnv(host: HostCtx, boxId: string): readonly BoxEnv[] {
  return host.specs.read(boxId)?.env ?? [];
}

/** The env an operation's input carries, or none when the input leaves env out. */
function envOf(value: unknown): readonly BoxEnv[] {
  return Array.isArray(value) ? (value as BoxEnv[]) : [];
}

/**
 * A box that holds a secret reference gets that secret's value when it is created or rebuilt. A token needs `secret:use`
 * to put one there, so an agent cannot mount a host secret into a box it controls.
 */
function assertSecretUse(principal: TokenPrincipal, env: readonly BoxEnv[]): void {
  if (!env.some((entry) => entry.secretRef !== undefined)) return;
  requireSecretUse(principal);
}

function requireSecretUse(principal: TokenPrincipal): void {
  if (!principal.grants.scopes.includes("secret:use")) throw refusal("secret_reference_forbidden");
}

/**
 * A startup command runs in the box and may hold a secret the user typed, so a token needs exec and `secret:use` to give
 * a box one at create or at a snapshot fork. The startup operations need `secret:use` from the scope check.
 */
function assertStartupUse(principal: TokenPrincipal, command: unknown): void {
  if (typeof command !== "string") return;
  if (!mayGiveStartupCommand(principal)) throw refusal("startup_command_forbidden");
}

const startupWriteRule: Rule = async (check) => {
  await boxRule(check);
  if (!mayGiveStartupCommand(check.principal)) throw refusal("startup_command_forbidden");
};

/** The session that runs a box's startup command holds its output, so only the owner and `secret:use` may use it. */
const sessionRule: Rule = async (check) => {
  await boxRule(check);
  if (check.input.name === INIT_SESSION && !mayUseSecrets(check.principal)) {
    throw refusal("startup_session_forbidden");
  }
};

/** A clone that reads a secret writes that secret into the box's workspace, so it needs the scope an env secret needs. */
function assertRepoSecretUse(principal: TokenPrincipal, repo: unknown): void {
  if (typeof repo === "object" && repo !== null && "secretRef" in repo && repo.secretRef) requireSecretUse(principal);
}

/** A checkpoint is visible as a snapshot is: to its creator, and to a token that sees the box it was taken from. */
function assertCheckpointVisible(principal: TokenPrincipal, host: HostCtx, checkpoint: CheckpointView): void {
  const visible = snapshotVisible(
    principal,
    { createdBy: checkpoint.createdBy, sourceId: checkpoint.boxId },
    specViews(host.specs.list()),
  );
  if (!visible) throw refusal("checkpoint_out_of_scope");
}

function resolvedCheckpoint(resolved: unknown): CheckpointView {
  if (typeof resolved !== "object" || resolved === null || !("createdBy" in resolved)) {
    throw refusal("checkpoint_out_of_scope");
  }
  return resolved as CheckpointView;
}

const checkpointRule: Rule = async ({ principal, host, resolved }) => {
  assertCheckpointVisible(principal, host, resolvedCheckpoint(resolved));
};

/** Changing or deleting a checkpoint is its creator's alone, as it is for a snapshot. */
const ownedCheckpointRule: Rule = async ({ principal, host, resolved }) => {
  const checkpoint = resolvedCheckpoint(resolved);
  assertCheckpointVisible(principal, host, checkpoint);
  if (checkpoint.createdBy !== principal.id) throw refusal("checkpoint_out_of_scope");
};

/** A volume a checkpoint reads or restores is one the token may see, as it is one it may mount. */
function assertVolumeVisible(principal: TokenPrincipal, host: HostCtx, record: VolumeRecord | null): void {
  if (!record || !volumeVisible(principal, record, specViews(host.specs.list()))) {
    throw refusal("checkpoint_out_of_scope");
  }
}

/**
 * A take reads the box's owned volumes and any shared volume the request names, so each named one must be visible. A
 * name that matches no volume is a 404, as it is for a volume operation; one that exists but is not visible is a 403.
 */
const checkpointCreateRule: Rule = async (check) => {
  await boxRule(check);
  const include = check.input.include as { volumes?: string[] } | undefined;
  for (const ref of include?.volumes ?? []) {
    const record = check.host.volumes.resolve(ref, check.host.host.id);
    if (!record) throw notFound(msg("volume_not_found", { volume: ref }));
    assertVolumeVisible(check.principal, check.host, record);
  }
};

/**
 * A fork creates a box, so the profile it gets and its TTL are checked as for a box create. Without a system layer it
 * starts from the source box's template, which the token must be allowed to use. Each shared volume the checkpoint
 * holds is copied, so the token must see that volume too.
 */
const checkpointForkRule: Rule = async ({ principal, host, input, resolved }) => {
  const checkpoint = resolvedCheckpoint(resolved);
  assertCheckpointVisible(principal, host, checkpoint);
  const spec = checkpoint.spec;
  const profile = typeof input.profile === "string" ? input.profile : (spec?.profile ?? host.security.defaultProfile);
  assertProfile(profile, undefined);
  if (!checkpoint.system && spec) await assertImageUsable(principal, host, spec.template.image, "template");
  assertTtl(principal, input.ttlSec as number | null | undefined);
  for (const layer of checkpoint.data) {
    if (layer.ownership === "independent") assertVolumeVisible(principal, host, host.volumes.read(layer.volumeId));
  }
};

/** A rollback rebuilds the box, so the box and the checkpoint it names must both be visible to the token. */
const rollbackRule: Rule = async (check) => {
  await boxRule(check);
  const checkpoint = await getCheckpoint(check.host, String(check.input.checkpoint ?? ""));
  assertCheckpointVisible(check.principal, check.host, checkpoint);
  assertSecretUse(check.principal, storedEnv(check.host, resolvedBox(check.resolved).boxId));
};

/**
 * A rollback's confirm and undo belong to the token that started it, as the rollback's checkpoint is its creator's to
 * change. Another token may see the box but may not finish the rollback.
 */
const rollbackOwnerRule: Rule = async (check) => {
  await boxRule(check);
  const pending = check.host.checkpoints.pendingRollback(resolvedBox(check.resolved).boxId);
  if (pending && pending.createdBy !== check.principal.id) throw refusal("rollback_out_of_scope");
};

/** An exec names its box by container id. Anything that cannot be matched to a visible spec is refused. */
const execRule: Rule = async ({ principal, host, resolved }) => {
  const target = resolved as ExecTarget | undefined;
  if (!target) throw refusal("box_out_of_scope");
  const spec = host.specs.list().find((item) => item.containerId === target.id);
  if (!spec) throw refusal("box_out_of_scope");
  assertBoxVisible(principal, viewOfSpec(spec));
};

const noAccess: Rule = async () => {};

function assertProfile(profile: string, current: string | null | undefined): void {
  if (!profileForToken(profile)) throw refusal("profile_not_allowed", { profile });
  if (current !== undefined && profileRank(profile) < profileRank(current)) {
    throw refusal("profile_not_allowed", { profile });
  }
}

/** A requested TTL above the token's cap is refused. Null and omission take the cap, which `ttlFor` stores. */
function assertTtl(principal: TokenPrincipal, requested: number | null | undefined): void {
  const max = principal.grants.quotas.maxTtlSec;
  if (max === null || typeof requested !== "number") return;
  if (requested > max) throw refusal("quota_ttl", { max });
}

async function imageOrNull(host: HostCtx, ref: string) {
  try {
    return await host.runtime.inspectImage(ref);
  } catch (e) {
    if (isRuntimeError(e, "not_found")) return null;
    throw e;
  }
}

/**
 * The image a ref names, resolved by the engine so a short id, a digest or a tag all reach the same label check. A
 * template must be visible to the token (the owner's, or one it promoted itself). A snapshot must be visible to it.
 * Anything else, and a ref that names nothing, is refused with the same message, so a refusal does not reveal which
 * images exist.
 */
async function assertImageUsable(
  principal: TokenPrincipal,
  host: HostCtx,
  ref: string,
  kind: "template" | "snapshot",
): Promise<void> {
  const refusedAs = kind === "snapshot" ? "snapshot_out_of_scope" : "template_out_of_scope";
  const info = await imageOrNull(host, ref);
  if (!info) throw refusal(refusedAs);
  const labels = info.labels;
  if (labels[host.keys.template] === "true") {
    if (templateVisible(principal, imageViewOf(host, labels))) return;
    throw refusal(refusedAs);
  }
  if (labels[host.keys.snapshot] === "true") {
    if (snapshotVisible(principal, imageViewOf(host, labels), specViews(host.specs.list()))) return;
  }
  throw refusal(refusedAs);
}

export function imageViewOf(host: HostCtx, labels: Record<string, string>): ImageView {
  return {
    createdBy: labels[host.keys.createdBy] || null,
    sourceId: labels[host.keys.snapshotOfId] || null,
  };
}

/** A snapshot or template the token itself created. Deleting or promoting another principal's image is refused. */
async function assertOwnedImage(
  principal: TokenPrincipal,
  host: HostCtx,
  ref: string,
  kind: "template" | "snapshot",
): Promise<void> {
  const refusedAs = kind === "snapshot" ? "snapshot_out_of_scope" : "template_out_of_scope";
  const info = await imageOrNull(host, ref);
  if (!info) throw refusal(refusedAs);
  const labels = info.labels;
  const flag = kind === "snapshot" ? host.keys.snapshot : host.keys.template;
  if (labels[flag] !== "true") throw refusal(refusedAs);
  if (labels[host.keys.createdBy] !== principal.id) throw refusal(refusedAs);
}

/** Box create and snapshot fork: the profile and the TTL cap. The quota is checked later, under the token's lock. */
const createRule: Rule = async ({ principal, host, input }) => {
  const profile = typeof input.profile === "string" ? input.profile : host.security.defaultProfile;
  assertProfile(profile, undefined);
  const template = typeof input.template === "string" ? input.template : host.baseTemplateTag;
  await assertImageUsable(principal, host, template, "template");
  assertTtl(principal, input.ttlSec as number | null | undefined);
  assertSecretUse(principal, envOf(input.env));
  assertStartupUse(principal, input.startupCommand);
  assertRepoSecretUse(principal, input.repo);
};

const forkRule: Rule = async ({ principal, host, input }) => {
  const profile = typeof input.profile === "string" ? input.profile : host.security.defaultProfile;
  assertProfile(profile, undefined);
  await assertImageUsable(principal, host, String(input.ref ?? "").trim(), "snapshot");
  assertTtl(principal, input.ttlSec as number | null | undefined);
  assertStartupUse(principal, input.startupCommand);
};

/** Update and rebuild: the box must be visible; a template, profile or TTL change must stay within the token's bounds. */
const changeRule: Rule = async ({ principal, host, input, resolved }) => {
  const box = resolvedBox(resolved);
  assertBoxVisible(principal, boxViewOf(host, box));
  if (typeof input.template === "string") await assertImageUsable(principal, host, input.template, "template");
  if (typeof input.profile === "string") assertProfile(input.profile, box.profile);
  if (input.ttlSec !== undefined) assertTtl(principal, input.ttlSec as number | null);
};

/**
 * A box that tracks its template follows the tag when it rebuilds: the tag may now name another image. The token must
 * see the image the tag names when the rebuild runs, not only the one the box was created from. A tag that names
 * nothing is not a move, so there is nothing to check.
 */
async function assertTrackedTemplateVisible(check: Check, box: Box): Promise<void> {
  const spec = check.host.specs.read(box.boxId);
  if (!spec || spec.template.ref !== spec.template.image) return;
  if ((await imageOrNull(check.host, spec.template.image)) === null) return;
  await assertImageUsable(check.principal, check.host, spec.template.image, "template");
}

/** The env a rebuild leaves the box with: the request's env when it names one, else the stored env. */
function envAfterRebuild(check: Check): readonly BoxEnv[] {
  if (check.input.env !== undefined) return envOf(check.input.env);
  return storedEnv(check.host, resolvedBox(check.resolved).boxId);
}

const rebuildRule: Rule = async (check) => {
  await changeRule(check);
  if (check.input.template === undefined) await assertTrackedTemplateVisible(check, resolvedBox(check.resolved));
  assertSecretUse(check.principal, envAfterRebuild(check));
};

/** Only an update that changes the box's template, mounts, env, network or profile rebuilds it. */
const REBUILD_FIELDS = ["template", "mounts", "env", "network", "profile"] as const;

const updateRule: Rule = async (check) => {
  await changeRule(check);
  const rebuilds = REBUILD_FIELDS.some((field) => check.input[field] !== undefined);
  if (!rebuilds) return;
  if (check.input.template === undefined) await assertTrackedTemplateVisible(check, resolvedBox(check.resolved));
  assertSecretUse(check.principal, envAfterRebuild(check));
};

/**
 * A move reaches every host, so only a credential granted every host and every box may make one: the owner, or the
 * admin preset. The box's own host is checked by the access check that runs before this rule. The move recreates the
 * box with its env on the target, so the token also needs the box's secrets.
 */
const moveRule: Rule = async (check) => {
  const { grants } = check.principal;
  if (grants.hosts.type !== "all" || grants.boxes.type !== "all") throw refusal("move_owner_only");
  await boxRule(check);
  const to = String(check.input.host ?? "");
  if (!hostAllowed(grants.hosts, to)) throw refusal("host_not_granted", { host: to });
  assertSecretUse(check.principal, storedEnv(check.host, resolvedBox(check.resolved).boxId));
};

/** File API: volume must be visible; writes also need a writable volume (tools stays owner-only). */
const volumeFileWriteRule: Rule = async ({ principal, host, resolved }) => {
  const view = resolved as { id: string; name: string } | undefined;
  const record = view ? host.volumes.resolve(view.id, host.host.id) : null;
  if (!view || !record || !volumeVisible(principal, record, specViews(host.specs.list()))) {
    throw refusal("volume_not_granted", { volume: view?.name ?? "" });
  }
  if (!volumeWritable(principal, record, specViews(host.specs.list()))) {
    throw refusal("volume_write_forbidden", { volume: view.name });
  }
};

const volumeRule: Rule = async ({ principal, host, resolved }) => {
  const view = resolved as { id: string; name: string } | undefined;
  const record = view ? host.volumes.resolve(view.id, host.host.id) : null;
  if (!view || !record || !volumeVisible(principal, record, specViews(host.specs.list()))) {
    throw refusal("volume_not_granted", { volume: view?.name ?? "" });
  }
};

/** Deleting a volume is its creator's alone. A grant lets a token mount a volume, not remove it. */
const volumeDeleteRule: Rule = async ({ principal, host, resolved }) => {
  const view = resolved as { id: string; name: string } | undefined;
  const record = view ? host.volumes.resolve(view.id, host.host.id) : null;
  if (!view || !record || record.createdBy !== principal.id) {
    throw refusal("volume_not_granted", { volume: view?.name ?? "" });
  }
};

/** Attaching or detaching needs the box visible. The volume itself is judged by the resource checks while it runs. */
const volumeAttachRule: Rule = async ({ principal, host, input }) => {
  const box = await getBox(host, String(input.box ?? ""));
  assertBoxVisible(principal, boxViewOf(host, box));
  assertSecretUse(principal, storedEnv(host, box.boxId));
};

/** A question belongs to the box that asked it, so a token answers one only when it may see that box. */
const questionRule: Rule = async ({ principal, host, resolved }) => {
  const question = resolved as { boxId?: unknown } | undefined;
  const spec = typeof question?.boxId === "string" ? host.specs.read(question.boxId) : undefined;
  if (!spec) throw refusal("box_out_of_scope");
  assertBoxVisible(principal, viewOfSpec(spec));
};

/** A template name a token promotes into must be free: promotion would otherwise overwrite that tag. */
async function assertTemplateNameFree(host: HostCtx, name: string): Promise<void> {
  const ref = `${host.prefix}-template:${name}`;
  if (await imageOrNull(host, ref)) throw refusal("template_out_of_scope");
}

const RULES: ReadonlyMap<string, Rule> = new Map<string, Rule>([
  ["box.list", noAccess],
  ["box.get", boxRule],
  ["box.create", createRule],
  ["box.delete", boxRule],
  ["box.action", boxRule],
  ["box.resources", boxRule],
  ["box.update", updateRule],
  ["box.rebuild", rebuildRule],
  ["box.move", moveRule],
  ["box.logs", boxRule],
  ["box.stats", boxRule],
  ["box.startup.get", boxRule],
  ["box.startup.set", startupWriteRule],
  ["box.startup.delete", startupWriteRule],
  ["box.startup.run", startupWriteRule],
  ["snapshot.create", boxRule],
  ["snapshot.fork", forkRule],
  ["snapshot.list", noAccess],
  [
    "snapshot.delete",
    async ({ principal, host, input }) => assertOwnedImage(principal, host, String(input.ref), "snapshot"),
  ],
  ["checkpoint.list", noAccess],
  ["checkpoint.get", checkpointRule],
  ["checkpoint.create", checkpointCreateRule],
  ["checkpoint.fork", checkpointForkRule],
  ["checkpoint.update", ownedCheckpointRule],
  ["checkpoint.delete", ownedCheckpointRule],
  ["box.rollback", rollbackRule],
  ["box.rollback.get", boxRule],
  ["box.rollback.confirm", rollbackOwnerRule],
  ["box.rollback.undo", rollbackOwnerRule],
  ["template.list", noAccess],
  [
    "template.promote",
    async ({ principal, host, input }) => {
      await assertOwnedImage(principal, host, String(input.ref), "snapshot");
      await assertTemplateNameFree(host, String(input.name));
    },
  ],
  [
    "template.save",
    async (check) => {
      await boxRule(check);
      await assertTemplateNameFree(check.host, String(check.input.name));
    },
  ],
  [
    "template.delete",
    async ({ principal, host, input }) => assertOwnedImage(principal, host, String(input.ref), "template"),
  ],
  ["volume.list", noAccess],
  ["volume.get", volumeRule],
  ["volume.create", noAccess],
  ["volume.delete", volumeDeleteRule],
  ["volume.attach", volumeAttachRule],
  ["volume.detach", volumeAttachRule],
  ["volume.usage", volumeRule],
  ["task.list", noAccess],
  ["task.get", noAccess],
  ["session.list", boxRule],
  ["session.start", sessionRule],
  ["session.read", sessionRule],
  ["session.send", sessionRule],
  ["session.close", sessionRule],
  ["exec.run", boxRule],
  ["exec.get", execRule],
  ["exec.kill", execRule],
  ["exec.output", execRule],
  ["files.read", volumeRule],
  ["files.write", volumeFileWriteRule],
  ["files.list", volumeRule],
  ["files.copy", volumeFileWriteRule],
  ["files.download", volumeRule],
  ["files.upload", volumeFileWriteRule],
  ["files.stream.upload", volumeFileWriteRule],
  ["files.stream.download", volumeRule],
  ["files.mkdir", volumeFileWriteRule],
  ["files.move", volumeFileWriteRule],
  ["files.delete", volumeFileWriteRule],
  ["events.list", noAccess],
  ["tool.catalog", noAccess],
  [
    "tool.list",
    async ({ principal, host, input }) => {
      const id = typeof input.id === "string" ? input.id.trim() : "";
      if (!id) return;
      const box = await getBox(host, id);
      assertBoxVisible(principal, boxViewOf(host, box));
    },
  ],
  ["tool.install", boxRule],
  ["tool.upgrade", boxRule],
  ["tool.uninstall", boxRule],
  ["tool.reconcile", boxRule],
  ["port.list", boxRule],
  ["port.expose", boxRule],
  ["port.unexpose", boxRule],
  ["box.questions", boxRule],
  ["question.answer", questionRule],
  ["box.self.revoke", boxRule],
]);

/** Whether a token may reach an operation at all. The tests use it to hold every token-reachable operation to a rule. */
export function hasAccessRule(operation: string): boolean {
  return RULES.has(operation);
}
