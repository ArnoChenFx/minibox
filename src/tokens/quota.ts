import type { HostCtx } from "../host/registry";
import type { Principal, TokenPrincipal } from "../operations/types";
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
 * created on this host, plus the box being changed at its new size. Renaming a box is never refused for being over a
 * limit it already exceeds: only a dimension the change sets is checked.
 */
export function assertQuota(principal: TokenPrincipal, host: HostCtx, change: QuotaChange): void {
  const quotas = principal.grants.quotas;
  const specs = host.specs.list();
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
 * Checks the token's quota and then runs `work`, both inside the token's queue. Two creates by one token therefore
 * cannot both pass a count that only one of them fits. The owner has no quota and runs `work` directly.
 */
export function underQuota<T>(
  principal: Principal,
  host: HostCtx,
  change: QuotaChange,
  work: () => Promise<T>,
): Promise<T> {
  if (principal.type !== "token") return work();
  return serialized(`quota:${principal.id}`, async () => {
    assertQuota(principal, host, change);
    return work();
  });
}
