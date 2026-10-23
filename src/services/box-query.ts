import type { StatSample } from "../host/live";
import type { HostCtx, HostRegistry } from "../host/registry";
import { containerName, parseBoxLabels } from "../labels";
import { untilAborted } from "../lib/abort";
import { notFound, conflict, AppError } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { NAME_RE } from "../lib/validation";
import { RuntimeError, type ContainerInfo, type ContainerStats, type Runtime } from "../runtime";
import { ensureSpec, ClaimError } from "../specs/claim";
import type { BoxSpec } from "../specs/types";
import type { Box } from "./box-model";
import { projectBox, unreachableBox } from "./box-view";

function specForRef(host: HostCtx, ref: string): BoxSpec | null {
  const direct = host.specs.read(ref);
  if (direct?.hostId === host.host.id) return direct;
  const named = host.specs.findByName(ref);
  if (named?.hostId === host.host.id) return named;
  return host.specs.list().find((spec) => spec.hostId === host.host.id && spec.containerName === ref) ?? null;
}

/**
 * One engine read, given up once the host's read timeout passes. The engine call is cancelled through its signal, and
 * a read that times out fails as unavailable, so one hung engine call cannot hold a request open.
 */
function readWithin<T>(host: HostCtx, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = AbortSignal.timeout(host.readTimeoutMs);
  return untilAborted(read(deadline), deadline).catch((e: unknown) => {
    if (deadline.aborted) {
      throw new RuntimeError("unavailable", `no answer within ${host.readTimeoutMs} ms`);
    }
    throw e;
  });
}

async function inspectKnown(host: HostCtx, spec: BoxSpec): Promise<ContainerInfo> {
  try {
    return await readWithin(host, (signal) => host.runtime.inspectContainer(spec.containerId, { signal }));
  } catch (e) {
    if (!(e instanceof RuntimeError && e.kind === "not_found")) throw e;
    return readWithin(host, (signal) => host.runtime.inspectContainer(spec.containerName, { signal }));
  }
}

/** Container id, container name, stable id, box name, or `prefix-<name>` for a box that has no spec yet. */
async function inspectRef(host: HostCtx, ref: string): Promise<ContainerInfo> {
  try {
    return await readWithin(host, (signal) => host.runtime.inspectContainer(ref, { signal }));
  } catch (e) {
    if (!(e instanceof RuntimeError && e.kind === "not_found") || !NAME_RE.test(ref)) throw e;
    return readWithin(host, (signal) => host.runtime.inspectContainer(containerName(host.prefix, ref), { signal }));
  }
}

function asMissing(e: unknown): never {
  if (e instanceof RuntimeError && e.kind === "not_found") throw notFound(msg("box_not_found"));
  throw e;
}

/** Inspect a container and assert it is a MiniBox box. Claims a spec the first time a container is seen. */
export async function getBox(host: HostCtx, ref: string): Promise<Box> {
  const known = specForRef(host, ref);
  if (known) {
    try {
      const info = await inspectKnown(host, known);
      if (!parseBoxLabels(info.labels, host.keys).isBox) throw notFound(msg("box_not_found"));
      return projectBox(host, known, info);
    } catch (e) {
      if (e instanceof RuntimeError) asMissing(e);
      throw e;
    }
  }

  let info: ContainerInfo;
  try {
    info = await inspectRef(host, ref);
  } catch (e) {
    asMissing(e);
  }
  if (!parseBoxLabels(info.labels, host.keys).isBox) throw notFound(msg("box_not_found"));
  let claimed: Awaited<ReturnType<typeof ensureSpec>>;
  try {
    claimed = await ensureSpec(host, info);
  } catch (e) {
    if (e instanceof ClaimError) throw conflict(msg("box_claim_failed", { detail: e.message }));
    throw e;
  }
  if (!claimed) throw notFound(msg("box_not_found"));
  return projectBox(host, claimed.spec, info);
}

/**
 * The box a reference names. While the host's cache is current, a box it holds is read from the cache without a Docker
 * call. Anything else is read from the engine, which also claims a container that has no spec yet.
 */
export async function readBox(host: HostCtx, ref: string): Promise<Box> {
  const cached = host.sampler.ready() ? host.sampler.find(ref) : null;
  return cached ?? getBox(host, ref);
}

/**
 * The boxes of every host, for the list endpoint. The request's own host is read as before, so its failure still fails
 * the request. A remote host that is offline, slow or failing contributes its boxes as unreachable instead, so one host
 * cannot hide the others. Every host is read at once.
 */
export async function listAllBoxes(
  hosts: readonly HostCtx[],
  opts: { withStats?: boolean; host?: string } = {},
): Promise<Box[]> {
  const selected = hosts.filter((host) => opts.host === undefined || host.host.id === opts.host);
  const groups = await Promise.all(selected.map((host) => listOnHost(host, opts)));
  return groups
    .flat()
    .toSorted((a, b) => a.name.localeCompare(b.name) || (a.hostId ?? "").localeCompare(b.hostId ?? ""));
}

async function listOnHost(host: HostCtx, opts: { withStats?: boolean }): Promise<Box[]> {
  if (host.host.transport === "local") return listBoxes(host, opts);
  if (host.host.status === "offline") return unreachableBoxesOf(host);
  try {
    return await untilAborted(listBoxes(host, opts), AbortSignal.timeout(host.readTimeoutMs));
  } catch (e) {
    log.warn("box.list_unreachable", { host: host.host.id, error: String(e) });
    return unreachableBoxesOf(host);
  }
}

/** The boxes a host's specs name, shown without a live read. Used while the host cannot be reached. */
function unreachableBoxesOf(host: HostCtx): Box[] {
  return host.specs
    .list()
    .filter((spec) => spec.hostId === host.host.id)
    .map((spec) => unreachableBox(host, spec));
}

/**
 * The boxes of a host. While the cache is current this makes no Docker call, whatever the number of boxes. Otherwise it
 * lists the engine. Usage then comes from the sampler's latest sample when the sampler runs, and from the engine only
 * when it does not.
 */
export async function listBoxes(host: HostCtx, opts: { withStats?: boolean } = {}): Promise<Box[]> {
  if (host.sampler.ready()) {
    if (opts.withStats) await host.sampler.sampleSoon();
    return host.sampler.boxes({ withStats: opts.withStats === true });
  }
  const infos = await host.runtime.listContainers({ labels: { [host.keys.box]: "true" } });
  const boxes: Box[] = [];
  for (const info of infos) {
    let claimed: Awaited<ReturnType<typeof ensureSpec>>;
    try {
      claimed = await ensureSpec(host, info);
    } catch (e) {
      if (e instanceof ClaimError) {
        log.warn("box.claim_skipped", { container: info.name, host: host.host.id, error: e.message });
        continue;
      }
      throw e;
    }
    if (!claimed) continue;
    const box = projectBox(host, claimed.spec, info);
    if (opts.withStats) {
      box.stats = box.running ? await listedStats(host, claimed.spec.id, info.id) : null;
    }
    boxes.push(box);
  }
  return boxes.toSorted((a, b) => a.name.localeCompare(b.name));
}

async function listedStats(host: HostCtx, boxId: string, containerId: string): Promise<ContainerStats | null> {
  const sampled = host.sampler.statsOf(boxId);
  if (sampled) return sampled;
  return host.runtime.containerStats(containerId).catch(() => null);
}

/**
 * The host and box a reference names. A spec names its host, so a box with a spec is read on that host. A container no
 * spec covers yet is tried on each host in turn. A host without it is skipped; any other failure is raised.
 */
export async function locateBox(hosts: HostRegistry, ref: string): Promise<{ host: HostCtx; box: Box }> {
  const all = hosts.list();
  for (const host of all) {
    if (specForRef(host, ref)) return { host, box: await getBox(host, ref) };
  }
  for (const host of all) {
    try {
      return { host, box: await getBox(host, ref) };
    } catch (e) {
      if (!(e instanceof AppError && e.status === 404)) throw e;
    }
  }
  throw notFound(msg("box_not_found"));
}

/**
 * The host a box reference names by its spec, read from the spec store without touching any engine. Null when no spec
 * covers the reference, so the caller decides where to look. The spec store is shared, so any host's view will do.
 */
export function hostOfSpecRef(hosts: HostRegistry, ref: string): HostCtx | null {
  const { specs } = hosts.get();
  const spec = specs.read(ref) ?? specs.findByName(ref) ?? specs.findByContainer(ref, ref);
  if (!spec) return null;
  return hosts.has(spec.hostId) ? hosts.get(spec.hostId) : null;
}

/** The spec behind a box reference. Missing containers are a 404, same as `getBox`. */
export async function readSpec(host: HostCtx, ref: string): Promise<BoxSpec> {
  const box = await getBox(host, ref);
  const spec = host.specs.read(box.boxId);
  if (!spec) throw notFound(msg("box_not_found"));
  return spec;
}

/** How long one engine read of a box's logs is shared. Open tabs poll a few seconds apart, so they share it. */
const LOGS_WINDOW_MS = 2000;

const logReads = new WeakMap<Runtime, Map<string, { at: number; read: Promise<string> }>>();

/**
 * One engine read of a container's logs, shared by every caller that asks within the window. A read that fails is not
 * kept, so the next caller reads the engine again.
 */
function sharedLogs(runtime: Runtime, containerId: string, tail: number): Promise<string> {
  let reads = logReads.get(runtime);
  if (!reads) {
    reads = new Map();
    logReads.set(runtime, reads);
  }
  const now = Date.now();
  for (const [key, entry] of reads) {
    if (now - entry.at >= LOGS_WINDOW_MS) reads.delete(key);
  }
  const key = `${containerId}\n${tail}`;
  const hit = reads.get(key);
  if (hit) return hit.read;
  const read = runtime.containerLogs(containerId, { tail, timestamps: true });
  reads.set(key, { at: now, read });
  read.catch(() => {
    if (reads.get(key)?.read === read) reads.delete(key);
  });
  return read;
}

export async function getLogs(host: HostCtx, ref: string, tail: number): Promise<string> {
  const box = await readBox(host, ref);
  return sharedLogs(host.runtime, box.id, tail);
}

/**
 * Current usage of a box. While the cache is current this is the latest sample. A sample older than a cadence is first
 * refreshed by one shared round, so any number of tabs asking costs the engine one round, not one call each. Otherwise
 * it is one read of the engine, and only for a running box.
 */
export async function statsOf(host: HostCtx, box: Box): Promise<ContainerStats | null> {
  if (!box.running) return null;
  if (host.sampler.ready()) {
    await host.sampler.sampleSoon();
    return host.sampler.statsOf(box.boxId);
  }
  return host.runtime.containerStats(box.id);
}

export async function getStats(host: HostCtx, ref: string): Promise<ContainerStats | null> {
  return statsOf(host, await readBox(host, ref));
}

/** The latest usage and the samples behind it, oldest first. The history is empty while the cache is not current. */
export async function getStatsWithHistory(
  host: HostCtx,
  ref: string,
): Promise<{ stats: ContainerStats | null; history: StatSample[] }> {
  const box = await readBox(host, ref);
  const history = host.sampler.ready() ? host.sampler.historyOf(box.boxId) : [];
  return { stats: await statsOf(host, box), history };
}
