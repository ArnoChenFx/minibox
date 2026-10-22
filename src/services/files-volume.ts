import { randomBytes } from "node:crypto";

import type { HostCtx } from "../host/registry";
import { notFound, badRequest, toAppError } from "../lib/errors";
import { msg } from "../lib/messages";
import { RuntimeError, isRuntimeError, type HelperSpec, type HelperResult } from "../runtime";
import type { VolumeRecord } from "../volumes/types";
import { FILE_MOUNT } from "./files-model";

export function requireVolume(host: HostCtx, ref: string): VolumeRecord {
  const volume = host.volumes.resolve(ref, host.host.id);
  if (!volume || volume.hostId !== host.host.id) throw notFound(msg("volume_not_found", { volume: ref }));
  return volume;
}

export async function requireHelperImage(host: HostCtx): Promise<string> {
  try {
    await host.runtime.inspectImage(host.baseTemplateTag);
    return host.baseTemplateTag;
  } catch (e) {
    if (e instanceof RuntimeError && e.kind === "not_found") {
      throw badRequest(msg("helper_image_missing", { image: host.baseTemplateTag }));
    }
    throw e;
  }
}

export interface MountAccess {
  containerId: string;
  /** Absolute path of the volume root inside the container. */
  mountPath: string;
  /** Whether this service created the container and must remove it. */
  ephemeral: boolean;
}

/**
 * A container that already mounts the volume (a box, running or stopped), or a freshly created helper that is not
 * started. Archive APIs work on created containers.
 */
export async function openMount(host: HostCtx, volume: VolumeRecord, mode: "rw" | "ro"): Promise<MountAccess> {
  for (const spec of host.specs.list()) {
    if (spec.hostId !== host.host.id || !spec.containerId) continue;
    const mount = spec.mounts.find((item) => item.volume === volume.engineName);
    if (!mount) continue;
    if (mode === "rw" && mount.mode === "ro") continue;
    try {
      await host.runtime.inspectContainer(spec.containerId);
      return { containerId: spec.containerId, mountPath: mount.path, ephemeral: false };
    } catch (e) {
      if (isRuntimeError(e, "not_found")) continue;
      throw e;
    }
  }

  const image = await requireHelperImage(host);
  const name = `${host.prefix}-file-${randomBytes(4).toString("hex")}`;
  // Mirror runHelper hardening (NoCopy, ReadonlyRootfs, /tmp tmpfs, memory/pids, CapDrop, no network).
  // AutoRemove is omitted on purpose: archive helpers are created but never started, so the engine would never
  // remove them; closeMount deletes the container explicitly instead.
  const created = await host.runtime.createContainer({
    image,
    name,
    cmd: ["true"],
    mounts: [{ source: volume.engineName, target: FILE_MOUNT, mode, noCopy: true }],
    network: "none",
    labels: { [host.keys.internal]: "true" },
    memoryBytes: 256 * 1024 * 1024,
    swapBytes: 256 * 1024 * 1024,
    readonlyRootfs: true,
    tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16m" },
    hardening: { capDrop: ["ALL"], noNewPrivileges: true, pidsLimit: 64 },
  });
  return { containerId: created.id, mountPath: FILE_MOUNT, ephemeral: true };
}

export async function closeMount(host: HostCtx, access: MountAccess): Promise<void> {
  if (!access.ephemeral) return;
  try {
    await host.runtime.removeContainer(access.containerId, { force: true });
  } catch {
    // Best-effort cleanup; a leftover internal helper is harmless and labelled.
  }
}

/**
 * Holds each box on this host that mounts `volume` until the returned release is called, so work on the volume counts
 * as box activity (#12). It never starts a box: the file API works while boxes are stopped.
 */
export function holdVolumeBoxes(host: HostCtx, volume: VolumeRecord, opts: { quiet?: boolean } = {}): () => void {
  const releases = host.specs
    .list()
    .filter((spec) => spec.hostId === host.host.id && spec.mounts.some((mount) => mount.volume === volume.engineName))
    .map((spec) => host.pulse.hold(spec.id, opts));
  return () => {
    for (const release of releases) release();
  };
}

async function whileVolumeInUse<T>(host: HostCtx, volume: VolumeRecord, run: () => Promise<T>): Promise<T> {
  const release = holdVolumeBoxes(host, volume);
  try {
    return await run();
  } finally {
    release();
  }
}

export function runVolumeHelper(host: HostCtx, volume: VolumeRecord, spec: HelperSpec): Promise<HelperResult> {
  return whileVolumeInUse(host, volume, () => host.runtime.runHelper(spec));
}

export async function withArchive<T>(
  host: HostCtx,
  volume: VolumeRecord,
  mode: "rw" | "ro",
  run: (access: MountAccess) => Promise<T>,
): Promise<T> {
  return whileVolumeInUse(host, volume, async () => {
    const access = await openMount(host, volume, mode);
    try {
      return await run(access);
    } finally {
      await closeMount(host, access);
    }
  });
}

/** Resolve a volume for authz before the handler runs. */
export async function resolveVolume(
  host: HostCtx,
  ref: string,
): Promise<{ id: string; name: string; record: VolumeRecord }> {
  const record = requireVolume(host, ref);
  return { id: record.id, name: record.name, record };
}

export function mapFileError(e: unknown): never {
  throw toAppError(e);
}
