import type { HostCtx } from "../host/registry";
import { AppError, badRequest } from "../lib/errors";
import { msg } from "../lib/messages";
import { within } from "../lib/within";
import { assertVolumesPresent } from "./engine";
import { assertPoolsReachable, helperImage, probePool } from "./health";
import type { VolumeStore } from "./store";
import type { StoragePool, UsageScope, VolumeRecord } from "./types";

/** `du` on a volume's own tree. A tree that takes longer than this is reported as a failed sample. */
export const TREE_DEADLINE_MS = 120_000;
/** A share's `df` answers in well under this. A mount that does not is reported and the rest of the sampling goes on. */
export const SHARE_DEADLINE_MS = 30_000;

export type Sample =
  | { ok: true; at: string; bytes: number; scope: UsageScope }
  | { ok: false; at: string; message: string; error: unknown };

const nowIso = (): string => new Date().toISOString();

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Samples still running, per store. A sample that is late keeps running until its helper ends, so a later sample of the
 * same tree, or of the same NFS share, joins it instead of starting another helper.
 */
const running = new WeakMap<VolumeStore, Map<string, Promise<Sample>>>();

function runningSamples(store: VolumeStore): Map<string, Promise<Sample>> {
  const existing = running.get(store);
  if (existing) return existing;
  const samples = new Map<string, Promise<Sample>>();
  running.set(store, samples);
  return samples;
}

function poolOf(host: HostCtx, volume: VolumeRecord): StoragePool | undefined {
  return host.volumes.readPools().pools.find((pool) => pool.name === volume.pool);
}

/**
 * `du -sb` over an engine volume's own tree. The volume is checked first, so a helper cannot create a volume that was
 * deleted under it, and an image that is missing is reported as such.
 */
export async function measureTree(host: HostCtx, engineName: string): Promise<number> {
  await assertVolumesPresent(host, [engineName]);
  const image = await helperImage(host);
  if (!image) throw badRequest(msg("helper_image_missing", { image: host.baseTemplateTag }));
  const result = await host.runtime.runHelper({
    image,
    user: "0:0",
    capAdd: ["DAC_READ_SEARCH"],
    cmd: ["du", "-sb", "/mnt"],
    mounts: [{ source: engineName, target: "/mnt" }],
    timeoutSec: TREE_DEADLINE_MS / 1000,
    labels: { [host.keys.internal]: "true" },
  });
  if (result.exitCode !== 0) {
    throw badRequest(
      msg("volume_prepare_failed", { detail: result.logs.trim().slice(0, 400) || String(result.exitCode) }),
    );
  }
  const bytes = Number(result.logs.trim().split(/\s+/)[0]);
  if (!Number.isFinite(bytes)) throw badRequest(msg("volume_prepare_failed", { detail: "du printed no size" }));
  return bytes;
}

/**
 * The usage of an NFS share, from `df` on its pool root. The share is one filesystem, so this is the usage of every
 * volume in it: it never walks the directories, which on a NAS can be very large.
 */
async function measureShare(host: HostCtx, pool: StoragePool): Promise<number> {
  const health = await probePool(host, pool, { force: true, deadlineMs: SHARE_DEADLINE_MS });
  if (health.status !== "reachable" || health.usedBytes === null) {
    throw new AppError(
      503,
      "docker_unavailable",
      msg("storage_unreachable", { pool: pool.name, detail: health.message ?? "no usage reported" }),
    );
  }
  return health.usedBytes;
}

async function measure(host: HostCtx, volume: VolumeRecord, pool: StoragePool | undefined): Promise<Sample> {
  try {
    if (pool?.backend === "nfs")
      return { ok: true, at: nowIso(), bytes: await measureShare(host, pool), scope: "share" };
    if (pool?.backend === "path") await assertPoolsReachable(host, [pool.name]);
    return { ok: true, at: nowIso(), bytes: await measureTree(host, volume.engineName), scope: "volume" };
  } catch (error) {
    return { ok: false, at: nowIso(), message: messageOf(error), error };
  }
}

function startSample(host: HostCtx, volume: VolumeRecord, pool: StoragePool | undefined): Promise<Sample> {
  const samples = runningSamples(host.volumes);
  const key = pool?.backend === "nfs" ? `share\0${host.host.id}\0${pool.name}` : `volume\0${volume.id}`;
  const existing = samples.get(key);
  if (existing) return existing;
  const sample = measure(host, volume, pool).finally(() => samples.delete(key));
  samples.set(key, sample);
  return sample;
}

function lateSample(volume: VolumeRecord, pool: StoragePool | undefined, deadlineMs: number): Sample {
  const seconds = deadlineMs / 1000;
  const error =
    pool?.backend === "nfs"
      ? new AppError(
          503,
          "docker_unavailable",
          msg("storage_unreachable", { pool: pool.name, detail: `no answer within ${seconds} s` }),
        )
      : new AppError(503, "docker_unavailable", msg("volume_usage_timeout", { volume: volume.name, seconds }));
  return { ok: false, at: nowIso(), message: error.message, error };
}

/**
 * One sample of a volume, or a failed one once its deadline has passed. A late sample does not stop the helper, so a
 * frozen mount holds only its own sample: the other volumes are sampled on their own clocks.
 */
export function sampleWithin(host: HostCtx, volume: VolumeRecord): Promise<Sample> {
  const pool = poolOf(host, volume);
  const deadlineMs = pool?.backend === "nfs" ? SHARE_DEADLINE_MS : TREE_DEADLINE_MS;
  return within(startSample(host, volume, pool), deadlineMs, () => lateSample(volume, pool, deadlineMs));
}

/**
 * Keeps a sample on its volume. A good sample sets the figure and when it was taken. A failed one only records why, so
 * the figure from before it is kept. Null when the volume was deleted while its sample ran.
 */
export function recordSample(host: HostCtx, volumeId: string, sample: Sample): VolumeRecord | null {
  const current = host.volumes.read(volumeId);
  if (!current) return null;
  if (!sample.ok) {
    host.volumes.rememberUsage(volumeId, { error: sample.message });
    return current;
  }
  const next: VolumeRecord = { ...current, bytes: sample.bytes, bytesAt: sample.at, updatedAt: sample.at };
  host.volumes.write(next);
  host.volumes.rememberUsage(volumeId, { point: { at: sample.at, bytes: sample.bytes } });
  return next;
}
