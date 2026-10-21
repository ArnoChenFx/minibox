import type { HostCtx } from "../host/registry";
import { volumeName } from "../labels";
import { AppError } from "../lib/errors";
import { type MessageKey, msg, type Params } from "../lib/messages";
import type { AuthorizeRequest } from "../operations/executor";
import type { TokenPrincipal } from "../operations/types";
import { RuntimeError } from "../runtime";
import { getBox } from "../services/boxes";
import { listSnapshots } from "../services/snapshots";
import type { BoxSpec } from "../specs/types";
import {
  boxVisible,
  hostAllowed,
  scopeAllowed,
  snapshotVisible,
  viewFromBox,
  type BoxView,
  volumeGranted,
  volumesNamed,
} from "./model";

const MB = 1024 * 1024;

/** Operations that read or change one existing box, so the box has to be inside the token's scope. */
const BOX_OPS = new Set([
  "box.get",
  "box.delete",
  "box.action",
  "box.resources",
  "box.update",
  "box.logs",
  "box.stats",
  "snapshot.create",
]);

const WORKSPACE_OPS = new Set(["box.create", "snapshot.fork"]);
const TTL_OPS = new Set(["box.create", "box.update", "snapshot.fork"]);
const QUOTA_OPS = new Set(["box.create", "snapshot.fork", "box.update", "box.resources"]);

function deny(key: MessageKey, params?: Params): never {
  throw new AppError(403, "forbidden", msg(key, params));
}

/**
 * Scope, then resource, host and quota checks. The owner skips every check. A token missing the operation's scope,
 * a box outside its selector, a volume it cannot attach, or a quota it would pass is a 403. `box-self` and `system`
 * are refused: those principals are reserved and not issued.
 */
export async function authorizeOperation(request: AuthorizeRequest): Promise<boolean> {
  const { principal, operation } = request;
  if (principal.type === "owner") return true;
  if (principal.type !== "token") deny("operation_forbidden", { op: operation.name });
  if ((request.phase ?? "scope") === "scope") {
    if (!scopeAllowed(principal.grants, operation.scope)) deny("operation_forbidden", { op: operation.name });
    return true;
  }
  await assertAccess(request, principal);
  return true;
}

async function assertAccess(request: AuthorizeRequest, principal: TokenPrincipal): Promise<void> {
  const host = request.host;
  if (!host) throw new Error("the access check needs the host the operation runs on");
  if (!hostAllowed(principal.grants.hosts, host.host.id)) deny("host_not_granted", { host: host.host.id });

  const input = request.input ?? {};
  for (const volume of volumesNamed(input)) {
    if (!volumeGranted(principal, volume)) deny("volume_not_granted", { volume });
  }
  if (WORKSPACE_OPS.has(request.operation.name) && typeof input.name === "string") {
    const volume = volumeName(host.prefix, input.name);
    // Creating a box mounts this volume even when the caller did not name it. Reusing one that already exists is an
    // attach, and needs the same grant as an explicit mount. A volume created for this box does not.
    if ((await volumeExists(host, volume)) && !volumeGranted(principal, volume)) {
      deny("volume_not_granted", { volume });
    }
  }

  assertTtl(principal, request.operation.name, input);
  assertQuota(request, principal, host);

  const box = await targetBox(request, host);
  if (box && !boxVisible(principal, viewFromBox(box))) deny("box_out_of_scope");

  if (
    (request.operation.name === "snapshot.delete" || request.operation.name === "snapshot.fork") &&
    typeof input.ref === "string"
  ) {
    await assertSnapshot(host, principal, input.ref);
  }
}

function assertTtl(principal: TokenPrincipal, name: string, input: Record<string, unknown>): void {
  if (!TTL_OPS.has(name)) return;
  const max = principal.grants.quotas.maxTtlSec;
  if (max === null || !Object.hasOwn(input, "ttlSec") || input.ttlSec === undefined) return;
  if (typeof input.ttlSec !== "number" || input.ttlSec > max) deny("quota_ttl", { max });
}

function assertQuota(request: AuthorizeRequest, principal: TokenPrincipal, host: HostCtx): void {
  if (!QUOTA_OPS.has(request.operation.name)) return;
  const creating = WORKSPACE_OPS.has(request.operation.name);
  const input = request.input ?? {};
  const quotas = principal.grants.quotas;
  const own = host.specs.list().filter((spec) => spec.createdBy === principal.id);
  if (creating && quotas.maxBoxes !== null && own.length + 1 > quotas.maxBoxes) {
    deny("quota_boxes", { max: quotas.maxBoxes });
  }
  const current = creating ? null : specOf(host, request.resolved, input);
  const others = own.filter((spec) => spec.id !== current?.id);
  if ((creating || typeof input.cpus === "number") && quotas.maxCpus !== null) {
    const used = roundCpus(sumCpus(others) + requestedCpus(input, current));
    if (used > quotas.maxCpus + 1e-6) deny("quota_cpus", { used, max: quotas.maxCpus });
  }
  if ((creating || typeof input.memoryMb === "number") && quotas.maxMemoryMb !== null) {
    const used = sumMemory(others) + requestedMemory(input, current);
    if (used > quotas.maxMemoryMb) deny("quota_memory", { used, max: quotas.maxMemoryMb });
  }
}

async function targetBox(request: AuthorizeRequest, host: HostCtx): Promise<BoxLike | null> {
  if (isBox(request.resolved)) return request.resolved;
  if (!BOX_OPS.has(request.operation.name)) return null;
  const id = request.input?.id;
  if (typeof id !== "string" || id === "") return null;
  return getBox(host, id);
}

async function assertSnapshot(host: HostCtx, principal: TokenPrincipal, ref: string): Promise<void> {
  const images = await listSnapshots(host);
  const image = images.find((item) => item.ref === ref || item.id === ref || item.tags.includes(ref));
  if (!image) return;
  const boxes = host.specs.list().map(viewOfSpec);
  if (!snapshotVisible(principal, image.source, boxes)) deny("snapshot_out_of_scope");
}

async function volumeExists(host: HostCtx, name: string): Promise<boolean> {
  try {
    await host.runtime.inspectVolume(name);
    return true;
  } catch (e) {
    if (e instanceof RuntimeError && e.kind === "not_found") return false;
    throw e;
  }
}

function specOf(host: HostCtx, resolved: unknown, input: Record<string, unknown>): BoxSpec | null {
  if (isBox(resolved)) return host.specs.read(resolved.boxId);
  const id = typeof input.id === "string" ? input.id : "";
  if (id === "") return null;
  return host.specs.read(id) ?? host.specs.findByName(id) ?? host.specs.findByContainer(id, id);
}

function sumCpus(specs: readonly BoxSpec[]): number {
  return specs.reduce((sum, spec) => sum + (spec.resources.cpus ?? 0), 0);
}

function sumMemory(specs: readonly BoxSpec[]): number {
  return specs.reduce((sum, spec) => sum + Math.round((spec.resources.memoryBytes ?? 0) / MB), 0);
}

function requestedCpus(input: Record<string, unknown>, current: BoxSpec | null): number {
  return typeof input.cpus === "number" ? input.cpus : (current?.resources.cpus ?? 0);
}

function requestedMemory(input: Record<string, unknown>, current: BoxSpec | null): number {
  if (typeof input.memoryMb === "number") return input.memoryMb;
  return Math.round((current?.resources.memoryBytes ?? 0) / MB);
}

function roundCpus(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function viewOfSpec(spec: BoxSpec): BoxView {
  return viewFromBox({
    boxId: spec.id,
    containerId: spec.containerId,
    name: spec.name,
    createdBy: spec.createdBy,
    labels: spec.labels,
    hostId: spec.hostId,
    mounts: spec.mounts,
  });
}

interface BoxLike {
  boxId: string;
  id: string;
  name: string;
  createdBy: string | null;
  labels: Record<string, string>;
  mounts: { volume: string }[];
}

function isBox(value: unknown): value is BoxLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "boxId" in value &&
    "createdBy" in value &&
    "name" in value &&
    "mounts" in value &&
    "id" in value
  );
}
