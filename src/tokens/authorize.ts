import type { HostCtx } from "../host/registry";
import type { AuthorizeRequest } from "../operations/executor";
import type { TokenPrincipal } from "../operations/types";
import { isRuntimeError } from "../runtime";
import type { Box } from "../services/boxes";
import { getBox } from "../services/boxes";
import type { ExecTarget } from "../services/exec";
import { inspectVolumeOrNull } from "../volumes/engine";
import type { VolumeRecord } from "../volumes/types";
import {
  type BoxView,
  boxVisible,
  hostAllowed,
  type ImageView,
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

/**
 * The authorize hook. The owner passes every check. A token passes the scope check for the operation, then the
 * access rule for its target (host, box, image, volume, profile, TTL), and a service that asks about one volume passes
 * the resource check. An operation with no access rule is refused for tokens, so a new operation is owner-only until
 * it gets one.
 */
export async function authorizeOperation(request: AuthorizeRequest): Promise<boolean> {
  const { principal } = request;
  if (principal.type === "owner") return true;
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
};

const forkRule: Rule = async ({ principal, host, input }) => {
  const profile = typeof input.profile === "string" ? input.profile : host.security.defaultProfile;
  assertProfile(profile, undefined);
  await assertImageUsable(principal, host, String(input.ref ?? "").trim(), "snapshot");
  assertTtl(principal, input.ttlSec as number | null | undefined);
};

/** Update and rebuild: the box must be visible; a template, profile or TTL change must stay within the token's bounds. */
const changeRule: Rule = async ({ principal, host, input, resolved }) => {
  const box = resolvedBox(resolved);
  assertBoxVisible(principal, boxViewOf(host, box));
  if (typeof input.template === "string") await assertImageUsable(principal, host, input.template, "template");
  if (typeof input.profile === "string") assertProfile(input.profile, box.profile);
  if (input.ttlSec !== undefined) assertTtl(principal, input.ttlSec as number | null);
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
  ["box.update", changeRule],
  ["box.rebuild", changeRule],
  ["box.logs", boxRule],
  ["box.stats", boxRule],
  ["snapshot.create", boxRule],
  ["snapshot.fork", forkRule],
  ["snapshot.list", noAccess],
  [
    "snapshot.delete",
    async ({ principal, host, input }) => assertOwnedImage(principal, host, String(input.ref), "snapshot"),
  ],
  ["template.list", noAccess],
  [
    "template.promote",
    async ({ principal, host, input }) => {
      await assertOwnedImage(principal, host, String(input.ref), "snapshot");
      await assertTemplateNameFree(host, String(input.name));
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
  ["session.start", boxRule],
  ["session.read", boxRule],
  ["session.send", boxRule],
  ["session.close", boxRule],
  ["exec.run", boxRule],
  ["exec.get", execRule],
  ["exec.kill", execRule],
  ["exec.output", execRule],
  ["events.list", noAccess],
]);
