import { dirname } from "node:path";

import { type BoxProfile, hardeningFor } from "../box-profile";
import type { AuditNote } from "../events/types";
import type { StatSample } from "../host/live";
import type { HostCtx, HostRegistry } from "../host/registry";
import { containerName, parseBoxLabels } from "../labels";
import { untilAborted } from "../lib/abort";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { NAME_RE } from "../lib/validation";
import {
  type ContainerInfo,
  type ContainerStats,
  type ContainerUpdate,
  type ImageDetails,
  isRuntimeError,
  type Runtime,
  RuntimeError,
} from "../runtime";
import { ClaimError, ensureSpec } from "../specs/claim";
import { pushHistory } from "../specs/history";
import { ttlExpired } from "../specs/lifetime";
import { isBoxId, newBoxId, revisionMismatch } from "../specs/revision";
import type { BoxEnv, BoxMount, BoxRecovery, BoxSpec, DesiredState, MountMode, StopReason } from "../specs/types";
import { loadCatalog } from "../tools/catalog";
import { VolumeChanges } from "../volumes/changes";
import { assertVolumesPresent, poolsUsed, trackPoolRoots } from "../volumes/engine";
import { assertPoolsReachable } from "../volumes/health";
import { validMountPath } from "../volumes/mounts";
import { provisionDefaultMounts, removeEngine } from "../volumes/provision";
import type { VolumeRecord, VolumeRole } from "../volumes/types";
import { assertMountAllowed, mountTarget } from "./attachments";
import { projectBox } from "./box-view";
import { desiredToolsOf } from "./tools";
import { alignVolumeRoot, type RecordNote, writableWorkspaceVolume } from "./volume-owner";

export interface CreateBoxInput {
  name: string;
  /** Reserved before the box exists, so restored volumes can name it as owner. Generated when absent. */
  id?: string;
  image?: string;
  cpus: number;
  memoryMb: number;
  /** Absent means the host's default profile. */
  profile?: BoxProfile;
  /** Id of the principal that created the box: `owner`, or a token id. Defaults to `owner`. */
  createdBy?: string;
  /**
   * Engine mounts to use instead of the four role volumes. `volume` is a volume id or name.
   * An empty list creates a box with no mounts.
   */
  mounts?: BoxMount[];
  /** `null` inherits the global default. `0` disables idle sleep for this box. */
  idleTimeoutSec?: number | null;
  /** Absolute lifetime from create time. `null` means no TTL. */
  ttlSec?: number | null;
  /** Catalog tool ids to record on the spec (`version: latest`). Install via tool.reconcile. */
  tools?: string[];
}

export interface BoxUpdate {
  name?: string;
  cpus?: number;
  memoryMb?: number;
  pids?: number;
  labels?: Record<string, string>;
  /** `null` clears the timeout. */
  idleTimeoutSec?: number | null;
  /** `null` clears the TTL. */
  ttlSec?: number | null;
}

export interface Box {
  /** Docker container id. Terminals, snapshots and older clients keep using this. */
  id: string;
  /** Stable id (`bx_…`). Survives a rebuild; a claim of an unlabeled container mints a new one. */
  boxId: string;
  name: string;
  state: string;
  status: string;
  running: boolean;
  image: string;
  template: string;
  /** Null for boxes created before profiles existed. */
  profile: BoxProfile | null;
  /** Boxes created before profiles stay on the engine's default `bridge` network. */
  network: string;
  /** Observed on the container. A difference from the spec is reported in `drift`. */
  cpus: number | null;
  memory: number | null;
  pids: number | null;
  createdAt: string;
  startedAt: string | null;
  volume: string;
  revision: number;
  desired: DesiredState;
  idleTimeoutSec: number | null;
  ttlSec: number | null;
  /** Why the box is stopped. Null when running or when the reason is unknown. */
  stopReason: StopReason | null;
  /** True when the box is stopped because of idle sleep or TTL expiry. */
  sleeping: boolean;
  /** Last in-memory activity heartbeat, or null when none has been recorded this process. */
  lastActivityAt: string | null;
  /** User labels. These live in the spec and are never written onto the container. */
  labels: Record<string, string>;
  createdBy: string | null;
  /** Live container name. Claim does not change it. */
  containerName: string;
  drift: { field: string; expected: string; actual: string }[];
  recovery: BoxRecovery | null;
  mounts: BoxMountView[];
  /** Plain values and secret references. A secret reference is stored and not injected. */
  env: BoxEnv[];
  /** Desired Agent CLIs from the spec (`id` + `version`). */
  tools: { id: string; version: string }[];
  /** `unreachable` when a pool backing a mount could not be probed. The engine state stays in `state`. */
  storage: {
    status: "ok" | "unreachable" | "unknown";
    pools: { name: string; status: "reachable" | "unreachable" | "unknown" }[];
  };
  stats?: ContainerStats | null;
}

export interface BoxMountView extends BoxMount {
  volumeId: string | null;
  volumeName: string | null;
  role: VolumeRole | null;
  pool: string | null;
}

const MB = 1024 * 1024;

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
  try {
    const { spec } = await ensureSpec(host, info);
    return projectBox(host, spec, info);
  } catch (e) {
    if (e instanceof ClaimError) throw conflict(msg("box_claim_failed", { detail: e.message }));
    throw e;
  }
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
    let spec: BoxSpec;
    try {
      spec = (await ensureSpec(host, info)).spec;
    } catch (e) {
      if (e instanceof ClaimError) {
        log.warn("box.claim_skipped", { container: info.name, host: host.host.id, error: e.message });
        continue;
      }
      throw e;
    }
    const box = projectBox(host, spec, info);
    if (opts.withStats) {
      box.stats = box.running ? await listedStats(host, spec.id, info.id) : null;
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

async function ensureImage(host: HostCtx, image: string): Promise<ImageDetails> {
  try {
    return await host.runtime.inspectImage(image);
  } catch (e) {
    if (isRuntimeError(e, "not_found")) {
      throw badRequest(msg("template_image_missing", { image }), { field: "template" });
    }
    throw e;
  }
}

function assertMountList(mounts: BoxMount[]): void {
  const paths = new Set<string>();
  for (const mount of mounts) {
    if (!validMountPath(mount.path)) throw badRequest(msg("mount_path_invalid", { path: mount.path }));
    if (mount.mode !== "rw" && mount.mode !== "ro") throw badRequest(msg("mount_path_invalid", { path: mount.path }));
    if (paths.has(mount.path)) throw badRequest(msg("mount_duplicate", { path: mount.path }));
    paths.add(mount.path);
  }
}

function resolveMounts(host: HostCtx, mounts: BoxMount[]): BoxMount[] {
  assertMountList(mounts);
  return mounts.map((mount) => {
    const volume = host.volumes.resolve(mount.volume, host.host.id);
    if (!volume || volume.hostId !== host.host.id) throw notFound(msg("volume_not_found", { volume: mount.volume }));
    return { volume: volume.engineName, path: mount.path, mode: mount.mode };
  });
}

/** Explicit mounts name recorded volumes, and each one must pass the attachment rules a new box is held to. */
async function resolveCreateMounts(host: HostCtx, mounts: BoxMount[]): Promise<BoxMount[]> {
  const resolved = resolveMounts(host, mounts);
  for (const mount of resolved) {
    assertMountAllowed(host, null, mount.volume, await mountTarget(host, mount.volume));
  }
  return resolved;
}

function engineMounts(mounts: BoxMount[]): { source: string; target: string; mode: MountMode }[] {
  return mounts.map((mount) => ({ source: mount.volume, target: mount.path, mode: mount.mode }));
}

/** Boxes share one bridge network with inter-container communication off. A network that differs is never reused. */
async function ensureBoxNetwork(host: HostCtx): Promise<void> {
  try {
    await host.runtime.ensureBridgeNetwork(host.security.network, { interContainerComm: false });
  } catch (e) {
    if (e instanceof RuntimeError && e.kind === "conflict") {
      throw conflict(msg("box_network_conflict", { network: host.security.network }));
    }
    throw e;
  }
}

/**
 * A stopped box keeps the ID of the network it last ran on. After `docker network prune` removes that network, the box
 * starts only once it is attached to the network that now has the same name. A running box's network is in use, so it
 * cannot have been removed and is left alone.
 */
async function attachToBoxNetwork(host: HostCtx, box: Box): Promise<void> {
  if (box.network !== host.security.network || box.running) return;
  await ensureBoxNetwork(host);
  await host.runtime.reattachNetwork(box.id, host.security.network);
}

/** Bumps the revision only when the desired state actually changes, so a reconcile does not invalidate If-Match. */
async function setDesired(
  host: HostCtx,
  boxId: string,
  desired: DesiredState,
  stopReason: StopReason | null = desired === "stopped" ? "manual" : null,
): Promise<void> {
  await host.specs.exclusive(async () => {
    const spec = host.specs.read(boxId);
    if (!spec) return;
    const prevReason = spec.lifecycle.stopReason ?? null;
    const nextReason = desired === "running" ? null : stopReason;
    if (spec.lifecycle.desired === desired && prevReason === nextReason) return;
    const bumpDesired = spec.lifecycle.desired !== desired;
    host.specs.write({
      ...spec,
      lifecycle: { ...spec.lifecycle, desired, stopReason: nextReason },
      revision: bumpDesired ? spec.revision + 1 : spec.revision,
      updatedAt: new Date().toISOString(),
      history: bumpDesired ? pushHistory(spec) : spec.history,
    });
  });
}

/** What one create attempt has made so far, so a failed attempt can take it back. */
interface CreateAttempt {
  boxId: string | null;
  containerId: string | null;
  changes: VolumeChanges;
}

export async function createBox(
  host: HostCtx,
  input: CreateBoxInput & { templateLabel?: string },
  record?: RecordNote,
): Promise<Box> {
  const attempt: CreateAttempt = { boxId: null, containerId: null, changes: new VolumeChanges() };
  let containerId: string;
  try {
    containerId = await buildBox(host, input, attempt, record);
  } catch (e) {
    await undoCreate(host, attempt);
    throw e;
  }
  return getBox(host, containerId);
}

/**
 * Takes back a failed create in dependency order: the container, then the spec, then the volumes it made. If the engine
 * keeps the container, its spec and volumes stay too, so nothing still in use is left without a record.
 */
async function undoCreate(host: HostCtx, attempt: CreateAttempt): Promise<void> {
  const containerId = attempt.containerId;
  if (containerId) {
    try {
      await host.runtime.removeContainer(containerId, { force: true });
    } catch (e) {
      if (!isRuntimeError(e, "not_found")) {
        log.warn("box.create_rollback_failed", { container: containerId, error: String(e) });
        return;
      }
    }
  }
  if (attempt.boxId) {
    try {
      host.specs.remove(attempt.boxId);
    } catch (e) {
      log.warn("box.create_rollback_failed", { id: attempt.boxId, error: String(e) });
    }
  }
  await attempt.changes.rollback();
}

/** The id a new box takes: the reserved one when it is still free, else a generated id that no spec holds. */
function boxIdFor(host: HostCtx, reserved: string | undefined): string {
  if (reserved === undefined) {
    for (let tries = 0; tries < 5; tries++) {
      const id = newBoxId();
      if (!host.specs.read(id)) return id;
    }
    throw conflict(msg("box_claim_failed", { detail: "could not allocate a box id" }));
  }
  if (!isBoxId(reserved)) throw new Error(`refusing a box id ${reserved}`);
  if (host.specs.read(reserved)) throw conflict(msg("box_id_taken", { id: reserved }));
  return reserved;
}

async function buildBox(
  host: HostCtx,
  input: CreateBoxInput & { templateLabel?: string },
  attempt: CreateAttempt,
  record?: RecordNote,
): Promise<string> {
  const { runtime, keys, prefix, security } = host;
  if (host.specs.findByName(input.name)) throw conflict(msg("box_exists", { name: input.name }));

  const image = input.image ?? host.baseTemplateTag;
  const profile = input.profile ?? security.defaultProfile;
  const details = await ensureImage(host, image);
  await ensureBoxNetwork(host);

  const id = boxIdFor(host, input.id);
  attempt.boxId = id;
  const createdBy = input.createdBy ?? "owner";
  const known = new Set<string>([image]);
  const mounts = input.mounts
    ? await resolveCreateMounts(host, input.mounts)
    : await provisionDefaultMounts(host, { id, name: input.name, createdBy }, known, attempt.changes);
  await trackPoolRoots(host, poolsUsed(host, mounts), attempt.changes);
  await assertPoolsReachable(host, poolsUsed(host, mounts));

  const containerId = await host.specs.exclusive(async () => {
    if (host.specs.findByName(input.name)) throw conflict(msg("box_exists", { name: input.name }));
    const now = new Date().toISOString();
    const memoryBytes = input.memoryMb * MB;
    const pids = security.pidsLimit;
    const ref = input.templateLabel ?? image;
    const name = containerName(prefix, input.name);
    const resources = { cpus: input.cpus, memoryBytes, pids };
    const labels: Record<string, string> = {
      [keys.box]: "true",
      [keys.name]: input.name,
      [keys.id]: id,
      [keys.template]: ref,
      [keys.digest]: details.id,
      [keys.created]: now,
      [keys.profile]: profile,
      [keys.mounts]: JSON.stringify(mounts),
      [keys.cpus]: String(input.cpus),
      [keys.memory]: String(memoryBytes),
      [keys.pids]: String(pids),
      [keys.createdBy]: createdBy,
    };
    await assertVolumesPresent(
      host,
      mounts.map((mount) => mount.volume),
    );
    const created = await runtime
      .createContainer({
        name,
        image,
        cmd: ["sleep", "infinity"],
        workingDir: mounts.some((mount) => mount.path === "/workspace") ? "/workspace" : "/",
        hostname: input.name.slice(0, 63),
        labels,
        mounts: engineMounts(mounts),
        restart: "no",
        cpus: input.cpus,
        memoryBytes,
        swapBytes: memoryBytes,
        init: true,
        network: security.network,
        hardening: hardeningFor(profile, security),
      })
      .catch((e: unknown) => {
        // The engine enforces unique container names, so a name it already holds is refused here, not by a racy list.
        if (isRuntimeError(e, "conflict")) throw conflict(msg("box_exists", { name: input.name }));
        throw e;
      });
    attempt.containerId = created.id;
    const workspace = writableWorkspaceVolume(mounts);
    if (workspace) {
      await alignVolumeRoot(
        host,
        { containerId: created.id, volume: workspace, image: details.id, labels: details.labels },
        record,
      );
    }
    const spec: BoxSpec = {
      version: 1,
      id,
      name: input.name,
      createdName: input.name,
      hostId: host.host.id,
      createdBy,
      template: { ref, image, digest: details.id },
      resources,
      createdResources: resources,
      mounts,
      env: [],
      tools: desiredToolsOf(input.tools, loadCatalog(dirname(host.specs.dir()))),
      labels: {},
      lifecycle: {
        desired: "running",
        idleTimeoutSec: input.idleTimeoutSec === undefined ? null : input.idleTimeoutSec,
        ttlSec: input.ttlSec === undefined ? null : input.ttlSec,
        stopReason: null,
      },
      profile,
      network: security.network,
      restart: "no",
      containerName: name,
      containerId: created.id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      recovery: null,
      history: [],
    };
    host.specs.write(spec);
    return created.id;
  });

  await runtime.startContainer(containerId);
  await host.sampler.observe(containerId);
  host.pulse.touch(id, "create");
  log.info("box.created", { name: input.name, image, profile, cpus: input.cpus, memoryMb: input.memoryMb });
  return containerId;
}

/** Start and restart refuse a box whose pool is unreachable or whose volume is gone, instead of letting Docker recreate it. */
async function ensureRunningStorage(host: HostCtx, box: Box): Promise<void> {
  const spec = host.specs.read(box.boxId);
  const mounts = spec?.mounts ?? box.mounts;
  await assertPoolsReachable(host, poolsUsed(host, mounts));
  await assertVolumesPresent(
    host,
    mounts.map((mount) => mount.volume),
  );
}

/** Options for a start a request caused. `record` writes the `box.wake` note, and only when the box was asleep. */
export interface StartOptions {
  readonly record?: (note: AuditNote) => void;
}

export interface EnsureResult {
  readonly box: Box;
  /** True when this call started the box. */
  readonly woke: boolean;
}

/**
 * Runs `fn` with the box's power lock held. The box is read again inside the lock, so a change made while this call was
 * waiting is seen.
 */
export async function locked<T>(host: HostCtx, ref: string, fn: (box: Box) => Promise<T>): Promise<T> {
  const { boxId } = await getBox(host, ref);
  return host.power.run(boxId, async () => fn(await getBox(host, boxId)));
}

/**
 * An expired TTL refuses every start and restart, so a box cannot outlive its lifetime by being woken again (#12). A
 * rebuild starts the new container too, so it calls this as well.
 */
export function refuseExpired(host: HostCtx, boxId: string): void {
  const spec = host.specs.read(boxId);
  if (spec && ttlExpired(spec, Date.now())) {
    throw conflict(msg("box_ttl_expired"), { hint: msg("box_ttl_expired_hint") });
  }
}

/** Starts the box for a caller that already holds its power lock (see `locked`). */
export async function startLocked(host: HostCtx, box: Box, options: StartOptions): Promise<Box> {
  if (!box.running) refuseExpired(host, box.boxId);
  const previousReason = (host.specs.read(box.boxId)?.lifecycle.stopReason ?? null) as StopReason | null;
  await ensureRunningStorage(host, box);
  await attachToBoxNetwork(host, box);
  await host.runtime.startContainer(box.id);
  await setDesired(host, box.boxId, "running", null);
  await host.sampler.observe(box.id);
  host.pulse.touch(box.boxId, "wake");
  if (options.record && (previousReason === "idle" || previousReason === "ttl")) {
    options.record({
      op: "box.wake",
      kind: "write",
      status: "ok",
      summary: `Box woke: ${box.name}`,
      target: { kind: "box", id: box.id, name: box.name },
      detail: { boxId: box.boxId, from: previousReason },
    });
  }
  return getBox(host, box.boxId);
}

/** Starts the box. Starting a running box leaves its container alone. */
export async function startBox(host: HostCtx, ref: string, options: StartOptions = {}): Promise<Box> {
  return locked(host, ref, (box) => startLocked(host, box, options));
}

/** Starts a stopped box whatever stopped it. Exec and sessions use this, as a stopped box is started for them. */
export async function ensureRunning(host: HostCtx, ref: string, options: StartOptions = {}): Promise<EnsureResult> {
  return locked(host, ref, async (box) => {
    if (box.running) return { box, woke: false };
    return { box: await startLocked(host, box, options), woke: true };
  });
}

/**
 * Wakes a box that is asleep, which is stopped for idle or TTL. A box a person stopped, or one that is running, comes back
 * unchanged. Terminal and preview requests use this, so a manual stop still stops them.
 */
export async function wakeIfSleeping(host: HostCtx, ref: string, options: StartOptions = {}): Promise<Box> {
  return locked(host, ref, async (box) => (box.sleeping ? startLocked(host, box, options) : box));
}

/** Stops the box for a caller that already holds its power lock (see `locked`). */
export async function stopLocked(host: HostCtx, box: Box, reason?: StopReason): Promise<void> {
  await host.runtime.stopContainer(box.id, { timeoutSec: host.stopTimeoutSec });
  const existing = host.specs.read(box.boxId)?.lifecycle.stopReason ?? null;
  // Omitted reason: keep an existing idle/ttl reason (reconcile), otherwise mark manual.
  const next: StopReason = reason ?? existing ?? "manual";
  await setDesired(host, box.boxId, "stopped", next);
  await host.sampler.observe(box.id);
}

export async function stopBox(host: HostCtx, ref: string, reason?: StopReason): Promise<Box> {
  return locked(host, ref, async (box) => {
    await stopLocked(host, box, reason);
    return getBox(host, box.boxId);
  });
}

/**
 * Puts a box to sleep for `idle` or `ttl`. `stillIdle` runs under the box's lock, on the box as it is then, so a request
 * that arrived after the decision keeps the box awake. Returns false when the box was left running.
 */
export async function sleepBox(
  host: HostCtx,
  ref: string,
  reason: "idle" | "ttl",
  stillIdle: (box: Box) => boolean | Promise<boolean> = () => true,
): Promise<boolean> {
  return locked(host, ref, async (box) => {
    if (!(await stillIdle(box))) return false;
    await stopLocked(host, box, reason);
    return true;
  });
}

export async function restartBox(host: HostCtx, ref: string): Promise<Box> {
  return locked(host, ref, async (box) => {
    refuseExpired(host, box.boxId);
    await ensureRunningStorage(host, box);
    await attachToBoxNetwork(host, box);
    await host.runtime.restartContainer(box.id, { timeoutSec: host.stopTimeoutSec });
    await setDesired(host, box.boxId, "running", null);
    await host.sampler.observe(box.id);
    // Same as a start: clear a stale idle heartbeat so LifecycleWatcher does not re-sleep the box at once.
    host.pulse.touch(box.boxId, "wake");
    return getBox(host, box.boxId);
  });
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

export interface DeleteBoxResult {
  name: string;
  volumeDeleted: boolean;
  /** Why the requested volume removal failed. The box itself is always removed first. */
  volumeError?: string;
}

export async function deleteBox(host: HostCtx, ref: string, deleteVolume: boolean): Promise<DeleteBoxResult> {
  return locked(host, ref, async (box) => {
    const spec = host.specs.read(box.boxId);
    const mounted = (spec?.mounts ?? [])
      .map((mount) => host.volumes.findByEngine(host.host.id, mount.volume))
      .filter((volume): volume is VolumeRecord => volume !== null);
    // A rollback still waiting for its confirm or undo keeps the volumes it replaced. They are the box's, so they go with it.
    const replaced = (host.checkpoints.pendingRollback(box.boxId)?.replaced ?? [])
      .map((volume) => host.volumes.read(volume.volumeId))
      .filter((volume): volume is VolumeRecord => volume !== null);
    await host.specs.exclusive(async () => {
      await host.runtime.removeContainer(box.id, { force: true });
      host.specs.remove(box.boxId);
    });
    await host.sampler.observe(box.id);
    host.pulse.clear(box.boxId);
    const result: DeleteBoxResult = { name: box.name, volumeDeleted: false };
    if (deleteVolume) await removeOwnedVolumes(host, box.boxId, [...mounted, ...replaced], result);
    host.checkpoints.removePendingRollback(box.boxId);
    log.info("box.deleted", { name: box.name, volumeDeleted: result.volumeDeleted });
    return result;
  });
}

/**
 * Removes the volumes this box owns that no other box mounts. Only a record that names this box as owner is removed.
 * A volume with no record, or one owned by another box, is never touched. Failures are reported, not thrown.
 */
async function removeOwnedVolumes(
  host: HostCtx,
  boxId: string,
  mounted: VolumeRecord[],
  result: DeleteBoxResult,
): Promise<void> {
  const remaining = host.specs.list();
  let removed = 0;
  for (const volume of mounted) {
    if (volume.ownership !== "owned" || volume.ownerBoxId !== boxId) continue;
    if (remaining.some((other) => other.mounts.some((mount) => mount.volume === volume.engineName))) continue;
    const outcome = await removeEngine(host, volume.engineName);
    if (outcome.status === "failed") {
      result.volumeError ??= outcome.detail;
      continue;
    }
    host.volumes.remove(volume.id);
    removed += 1;
  }
  result.volumeDeleted = removed > 0 && result.volumeError === undefined;
}

/** The spec behind a box reference. Missing containers are a 404, same as `getBox`. */
export async function readSpec(host: HostCtx, ref: string): Promise<BoxSpec> {
  const box = await getBox(host, ref);
  const spec = host.specs.read(box.boxId);
  if (!spec) throw notFound(msg("box_not_found"));
  return spec;
}

function hasUpdate(patch: BoxUpdate): boolean {
  return (
    patch.name !== undefined ||
    patch.cpus !== undefined ||
    patch.memoryMb !== undefined ||
    patch.pids !== undefined ||
    patch.labels !== undefined ||
    patch.idleTimeoutSec !== undefined ||
    patch.ttlSec !== undefined
  );
}

function containerLimits(patch: BoxUpdate): ContainerUpdate {
  const limits: ContainerUpdate = {};
  if (patch.cpus !== undefined) limits.cpus = patch.cpus;
  if (patch.memoryMb !== undefined) {
    const memoryBytes = patch.memoryMb * MB;
    limits.memoryBytes = memoryBytes;
    limits.swapBytes = memoryBytes;
  }
  if (patch.pids !== undefined) limits.pidsLimit = patch.pids;
  return limits;
}

function clearNeedsReset(spec: BoxSpec, patch: BoxUpdate): BoxRecovery | null {
  if (!spec.recovery) return null;
  const drop = new Set<string>();
  if (patch.idleTimeoutSec !== undefined) drop.add("idleTimeout");
  if (patch.ttlSec !== undefined) drop.add("ttl");
  if (patch.labels !== undefined) drop.add("labels");
  const needsReset = spec.recovery.needsReset.filter((field) => !drop.has(field));
  return needsReset.length === 0 ? null : { ...spec.recovery, needsReset };
}

/**
 * Applies an in-place update. Container labels are not touched. `revision` is the caller's If-Match value;
 * a mismatch leaves the spec and the container as they were.
 */
export async function updateBox(host: HostCtx, ref: string, revision: number, patch: BoxUpdate): Promise<Box> {
  if (!hasUpdate(patch)) throw badRequest(msg("box_update_empty"));
  const current = await getBox(host, ref);
  await host.specs.exclusive(async () => {
    const spec = host.specs.read(current.boxId);
    if (!spec) throw notFound(msg("box_not_found"));
    if (spec.revision !== revision) throw revisionMismatch(spec.revision, revision);

    const nextName = patch.name !== undefined ? patch.name : spec.name;
    if (nextName !== spec.name) {
      const taken = host.specs.findByName(nextName);
      if (taken) throw conflict(msg("box_exists", { name: nextName }));
    }
    const nextContainer = nextName === spec.name ? spec.containerName : containerName(host.prefix, nextName);
    const limits = containerLimits(patch);
    let renamed = false;
    try {
      if (nextContainer !== spec.containerName) {
        await host.runtime.renameContainer(spec.containerId, nextContainer);
        renamed = true;
      }
      if (limits.cpus !== undefined || limits.memoryBytes !== undefined || limits.pidsLimit !== undefined) {
        await host.runtime.updateContainer(spec.containerId, limits);
      }
      const memoryBytes = patch.memoryMb !== undefined ? patch.memoryMb * MB : spec.resources.memoryBytes;
      host.specs.write({
        ...spec,
        name: nextName,
        containerName: nextContainer,
        resources: {
          cpus: patch.cpus !== undefined ? patch.cpus : spec.resources.cpus,
          memoryBytes,
          pids: patch.pids !== undefined ? patch.pids : spec.resources.pids,
        },
        labels: patch.labels !== undefined ? patch.labels : spec.labels,
        lifecycle: {
          ...spec.lifecycle,
          idleTimeoutSec: patch.idleTimeoutSec !== undefined ? patch.idleTimeoutSec : spec.lifecycle.idleTimeoutSec,
          ttlSec: patch.ttlSec !== undefined ? patch.ttlSec : spec.lifecycle.ttlSec,
        },
        recovery: clearNeedsReset(spec, patch),
        revision: spec.revision + 1,
        updatedAt: new Date().toISOString(),
        history: pushHistory(spec),
      });
    } catch (e) {
      if (renamed) {
        try {
          await host.runtime.renameContainer(spec.containerId, spec.containerName);
        } catch (undo) {
          log.warn("box.rename_undo_failed", { id: spec.id, error: String(undo) });
        }
      }
      throw e;
    }
  });
  await host.sampler.observe(current.id);
  log.info("box.updated", { id: current.boxId, name: current.name });
  return getBox(host, current.boxId);
}

export async function updateResources(
  host: HostCtx,
  ref: string,
  res: { cpus?: number; memoryMb?: number; pids?: number },
  revision: number,
): Promise<Box> {
  return updateBox(host, ref, revision, res);
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
