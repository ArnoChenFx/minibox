import type { OperationContext, TokenPrincipal } from "../operations/types";
import type { BoxSpec } from "../specs/types";
import { ownedBoxes, refusal } from "./model";

const MB = 1024 * 1024;

/**
 * What a create or a resize asks of a token's quota. A create adds a box. A resize replaces one box's size: the box is
 * counted at its new size whoever owns it, so a token cannot grow an owner's box past its own limit through a grant.
 */
export type QuotaChange =
  | { readonly kind: "create"; readonly cpus: number; readonly memoryMb: number }
  | { readonly kind: "resize"; readonly boxId: string; readonly cpus?: number; readonly memoryMb?: number };

const queues = new Map<string, Promise<unknown>>();

/**
 * Runs one unit of work after the earlier ones for the same key have finished. The queue for a key ends when its last
 * unit settles, so an idle key holds nothing.
 */
export function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(work);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return next;
}

function sumCpus(specs: readonly BoxSpec[]): number {
  return specs.reduce((sum, spec) => sum + (spec.resources.cpus ?? 0), 0);
}

function sumMemoryMb(specs: readonly BoxSpec[]): number {
  return specs.reduce((sum, spec) => sum + Math.round((spec.resources.memoryBytes ?? 0) / MB), 0);
}

const roundCpus = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Refuses a change that would take a token past its box, CPU or memory limit. The totals are the boxes the token
 * created on every host, plus the box being changed at its new size. Renaming a box is never refused for being over a
 * limit it already exceeds: only a dimension the change sets is checked.
 */
export function assertQuota(principal: TokenPrincipal, specs: readonly BoxSpec[], change: QuotaChange): void {
  const quotas = principal.grants.quotas;
  const changed = change.kind === "resize" ? change.boxId : undefined;
  const others = ownedBoxes(principal, specs).filter((spec) => spec.id !== changed);
  if (change.kind === "create" && quotas.maxBoxes !== null && others.length + 1 > quotas.maxBoxes) {
    throw refusal("quota_boxes", { max: quotas.maxBoxes });
  }
  const current = changed === undefined ? null : (specs.find((spec) => spec.id === changed) ?? null);
  const setsCpus = change.kind === "create" || change.cpus !== undefined;
  if (setsCpus && quotas.maxCpus !== null) {
    const requested = change.kind === "create" ? change.cpus : (change.cpus ?? current?.resources.cpus ?? 0);
    const used = roundCpus(sumCpus(others) + requested);
    if (used > quotas.maxCpus + 1e-6) throw refusal("quota_cpus", { used, max: quotas.maxCpus });
  }
  const setsMemory = change.kind === "create" || change.memoryMb !== undefined;
  if (setsMemory && quotas.maxMemoryMb !== null) {
    const currentMb = Math.round((current?.resources.memoryBytes ?? 0) / MB);
    const requested = change.kind === "create" ? change.memoryMb : (change.memoryMb ?? currentMb);
    const used = sumMemoryMb(others) + requested;
    if (used > quotas.maxMemoryMb) throw refusal("quota_memory", { used, max: quotas.maxMemoryMb });
  }
}

/**
 * Refuses a change the token's quota does not allow, without taking a place in the token's queue. An answer before a
 * task starts uses it; the check that counts for a create is `underQuota`'s, which runs inside the queue.
 */
export function assertWithinQuota(
  ctx: Pick<OperationContext, "principal" | "host" | "allHosts">,
  change: QuotaChange,
): void {
  const { principal } = ctx;
  if (principal.type !== "token") return;
  const hosts = ctx.allHosts?.() ?? [ctx.host];
  assertQuota(
    principal,
    hosts.flatMap((host) => host.specs.list()),
    change,
  );
}

/**
 * Checks the token's quota and then runs `work`, both inside the token's queue. Two creates by one token therefore
 * cannot both pass a count that only one of them fits, on any host. The owner has no quota and runs `work` directly.
 */
export function underQuota<T>(
  ctx: Pick<OperationContext, "principal" | "host" | "allHosts">,
  change: QuotaChange,
  work: () => Promise<T>,
): Promise<T> {
  const { principal } = ctx;
  if (principal.type !== "token") return work();
  return serialized(`quota:${principal.id}`, async () => {
    assertWithinQuota(ctx, change);
    return work();
  });
}

/**
 * Refuses a manual checkpoint once the token holds its limit of them. Automatic checkpoints do not count: the retention
 * policy bounds those per box, and a rollback takes them, not the token. The store is shared by every host, so one
 * listing counts them all.
 */
export function assertCheckpointQuota(ctx: Pick<OperationContext, "principal" | "host">): void {
  const { principal } = ctx;
  if (principal.type !== "token") return;
  const max = principal.grants.quotas.maxCheckpoints;
  if (max === null) return;
  const taken = ctx.host.checkpoints
    .list()
    .filter((record) => record.trash === null && !record.auto && record.createdBy === principal.id).length;
  if (taken + 1 > max) throw refusal("quota_checkpoints", { max });
}

/**
 * Checks the token's checkpoint quota and then runs `work`, both inside the token's queue for checkpoints, so two takes
 * by one token cannot both pass the last place. The owner, and a token with no checkpoint limit, run `work` directly.
 */
export function underCheckpointQuota<T>(
  ctx: Pick<OperationContext, "principal" | "host">,
  work: () => Promise<T>,
): Promise<T> {
  const { principal } = ctx;
  if (principal.type !== "token" || principal.grants.quotas.maxCheckpoints === null) return work();
  return serialized(`checkpoint-quota:${principal.id}`, async () => {
    assertCheckpointQuota(ctx);
    return work();
  });
}
