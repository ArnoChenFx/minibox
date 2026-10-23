import { randomBytes } from "node:crypto";

import { type OpenedPackage, type SnapshotRef, SnapshotHeld } from "../checkpoints/engine";
import {
  MANIFEST_TAG,
  MANIFEST_VERSION,
  PACKAGE_VERSION,
  type PackageDigest,
  type PackageManifest,
  PackageRejected,
  parseManifest,
  scanPackageFile,
  writePackageFile,
} from "../checkpoints/package";
import { expiresAtFor, isExpired, type PackageMeta } from "../checkpoints/packages";
import { CHECKPOINT_VERSION, type CheckpointRecord, type DataLayer } from "../checkpoints/types";
import type { HostCtx } from "../host/registry";
import { abortError } from "../lib/abort";
import { badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { byteLog } from "../lib/transfer";
import { type CheckpointView, type Progress, viewOf } from "./checkpoints";
import { copyTemplate, findTemplateSource, heldImage } from "./template-sync";

export interface PackageView {
  id: string;
  checkpointId: string | null;
  origin: "export" | "upload" | "target";
  bytes: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
  url: string;
}

export const checkpointTag = (id: string): string => `checkpoint:${id}`;
const volumeTag = (volumeId: string): string => `volume:${volumeId}`;

/** A layer's fields without its snapshot, which is the part a package and a copy each supply for themselves. */
type LayerFields = Omit<DataLayer, "snapshotId">;

/**
 * What a package records about its checkpoint: the record fields a new instance needs, and nothing about the source
 * host. Snapshot ids are left out, since each instance assigns its own when the package is imported.
 */
export function manifestOf(record: CheckpointRecord): string {
  if (record.boxId === null || record.boxName === null || record.specRevision === null || record.spec === null) {
    throw conflict(msg("checkpoint_export_no_box", { id: record.id }));
  }
  const manifest: PackageManifest = {
    version: MANIFEST_VERSION,
    id: record.id,
    boxId: record.boxId,
    boxName: record.boxName,
    label: record.label,
    reason: record.reason,
    pinned: record.pinned,
    consistency: record.consistency,
    specRevision: record.specRevision,
    spec: record.spec,
    data: record.data.map(({ snapshotId: _snapshotId, ...layer }) => layer),
    createdAt: record.createdAt,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function packageView(meta: PackageMeta): PackageView {
  return {
    id: meta.id,
    checkpointId: meta.checkpointId,
    origin: meta.origin,
    bytes: meta.bytes,
    sha256: meta.sha256,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
    url: `/api/packages/${meta.id}/download`,
  };
}

/**
 * Translates what the package reader refused into the response the caller gets. A wrong passphrase is its own answer,
 * so the caller can retype it. Anything else passes through unchanged.
 */
export function rejected(e: unknown): never {
  if (!(e instanceof PackageRejected)) throw e;
  if (e.reason === "passphrase") throw badRequest(msg("package_passphrase_wrong"), { field: "passphrase" });
  throw badRequest(msg("package_invalid", { reason: e.message }));
}

/**
 * Refuses a checkpoint that cannot be exported. Legacy snapshots carry no data, and a checkpoint with no layers has none
 * either. A system layer is an image on this host, which a package does not carry, so an import would fork the template.
 */
export function assertExportable(checkpoint: CheckpointView): void {
  if (checkpoint.legacy) throw conflict(msg("checkpoint_export_legacy", { id: checkpoint.id }));
  if (checkpoint.data.length === 0) throw conflict(msg("checkpoint_export_empty", { id: checkpoint.id }));
  if (checkpoint.system) throw conflict(msg("checkpoint_export_system", { id: checkpoint.id }));
  if (checkpoint.boxId === null || checkpoint.spec === null) {
    throw conflict(msg("checkpoint_export_no_box", { id: checkpoint.id }));
  }
}

/**
 * Refuses a checkpoint a copy cannot carry. The limits are an export's: a legacy snapshot has no data, a checkpoint with no
 * layers has none, a system layer is an image this copy does not move, and a checkpoint with no box has no settings to
 * fork from.
 */
export function assertCopyable(checkpoint: CheckpointView): void {
  if (checkpoint.legacy) throw conflict(msg("checkpoint_copy_legacy", { id: checkpoint.id }));
  if (checkpoint.data.length === 0) throw conflict(msg("checkpoint_copy_empty", { id: checkpoint.id }));
  if (checkpoint.system) throw conflict(msg("checkpoint_copy_system", { id: checkpoint.id }));
  if (checkpoint.boxId === null || checkpoint.spec === null) {
    throw conflict(msg("checkpoint_copy_no_box", { id: checkpoint.id }));
  }
}

function metaOf(
  id: string,
  origin: PackageMeta["origin"],
  checkpointId: string | null,
  hostId: string | null,
  createdBy: string | null,
  digest: PackageDigest,
): PackageMeta {
  const now = Date.now();
  return {
    version: PACKAGE_VERSION,
    id,
    origin,
    checkpointId,
    hostId,
    createdBy,
    bytes: digest.bytes,
    sha256: digest.sha256,
    createdAt: new Date(now).toISOString(),
    expiresAt: expiresAtFor(now),
  };
}

/**
 * Writes a sealed package of one checkpoint. The checkpoint is marked as exporting before the engine reads it, so
 * retention keeps its snapshots until the package is complete. A failure removes the partial package.
 */
export async function exportCheckpoint(
  host: HostCtx,
  id: string,
  passphrase: string,
  createdBy: string | null,
  progress?: Progress,
): Promise<PackageMeta> {
  const packages = host.checkpoints.packages;
  const record = await host.checkpoints.exclusive(async () => {
    const found = host.checkpoints.read(id);
    if (!found || found.hostId !== host.host.id || found.trash !== null) {
      throw notFound(msg("checkpoint_not_found", { id }));
    }
    assertExportable(viewOf(found));
    host.checkpoints.exporting.add(id);
    return found;
  });
  const packageId = packages.allocateId();
  packages.begin(packageId);
  try {
    progress?.log?.(`Packing ${record.label}…\n`);
    const digest = await host.checkpointEngine.pack(
      host,
      {
        snapshotIds: record.data.map((layer) => layer.snapshotId),
        manifest: manifestOf(record),
        passphrase,
      },
      packages.pathFor(packageId),
      packages.maxBytes,
      byteLog(progress, "Packed"),
    );
    const meta = metaOf(packageId, "export", id, host.host.id, createdBy, digest);
    packages.write(meta);
    log.info("checkpoint.exported", { id, package: packageId, bytes: digest.bytes });
    return meta;
  } catch (e) {
    packages.remove(packageId);
    throw e;
  } finally {
    host.checkpoints.exporting.delete(id);
    packages.end(packageId);
  }
}

/** Stores a package uploaded as a raw stream. The stream is checked as it arrives, and a refused one leaves no file. */
export async function receivePackage(
  host: HostCtx,
  source: AsyncIterable<Uint8Array>,
  createdBy: string | null,
): Promise<PackageMeta> {
  const packages = host.checkpoints.packages;
  const id = packages.allocateId();
  packages.begin(id);
  try {
    const digest = await writePackageFile(source, packages.pathFor(id), packages.maxBytes);
    const meta = metaOf(id, "upload", null, null, createdBy, digest);
    packages.write(meta);
    log.info("checkpoint.package_uploaded", { package: id, bytes: digest.bytes });
    return meta;
  } catch (e) {
    packages.remove(id);
    throw e;
  } finally {
    packages.end(id);
  }
}

/** A package that can be downloaded or imported: stored, not yet expired, and whole. Anything else is not found. */
export function storedPackage(host: HostCtx, id: string): PackageMeta {
  const packages = host.checkpoints.packages;
  const meta = packages.read(id);
  if (!meta || isExpired(meta, Date.now()) || packages.fileBytes(id) !== meta.bytes) {
    throw notFound(msg("package_not_found", { id }));
  }
  return meta;
}

/**
 * The package's snapshot of one layer. A package holds one snapshot per volume, and a copy keeps the volume tag of the
 * snapshot it was copied from, so the tag finds the layer whatever id the checkpoint has now.
 */
function snapshotFor(snapshots: SnapshotRef[], volumeId: string, path: string): string {
  const matches = snapshots.filter(
    (snapshot) => !snapshot.tags.includes(MANIFEST_TAG) && snapshot.tags.includes(volumeTag(volumeId)),
  );
  const [match] = matches;
  if (matches.length !== 1 || !match) {
    throw rejected(new PackageRejected("invalid", `the package holds no single snapshot for ${path}`));
  }
  return match.id;
}

/**
 * Imports a stored package into this instance. The package is checked again from its bytes, then opened with the
 * passphrase. Its snapshots are copied in, and a checkpoint record is written, so the checkpoint is listed and can be
 * forked like any other. The package is removed once it is imported, and kept when the import is refused.
 */
export async function importPackage(
  host: HostCtx,
  id: string,
  passphrase: string,
  createdBy: string | null,
  progress?: Progress,
): Promise<CheckpointView> {
  const packages = host.checkpoints.packages;
  const meta = storedPackage(host, id);
  packages.begin(id);
  try {
    const path = packages.pathFor(id);
    progress?.log?.("Checking the package…\n");
    const digest = await scanPackageFile(path).catch(rejected);
    if (digest.bytes !== meta.bytes || digest.sha256 !== meta.sha256) {
      throw badRequest(msg("package_invalid", { reason: "the file changed after it was received" }));
    }
    const view = await restorePackage(host, path, passphrase, createdBy, progress);
    packages.remove(id);
    return view;
  } finally {
    packages.end(id);
  }
}

async function restorePackage(
  host: HostCtx,
  path: string,
  passphrase: string,
  createdBy: string | null,
  progress?: Progress,
): Promise<CheckpointView> {
  progress?.log?.("Opening the package…\n");
  const opened = await host.checkpointEngine.open(host, path, passphrase, byteLog(progress, "Read")).catch(rejected);
  try {
    const manifests = opened.snapshots.filter((snapshot) => snapshot.tags.includes(MANIFEST_TAG));
    const [manifestSnapshot] = manifests;
    if (manifests.length !== 1 || !manifestSnapshot) {
      throw badRequest(msg("package_invalid", { reason: "the package holds no single manifest" }));
    }
    const manifest = parseManifest(await opened.readManifest(manifestSnapshot.id).catch(rejected));
    await assertImportable(host, manifest.id);
    progress?.log?.(`Restoring ${manifest.label}…\n`);
    const data = await unpackLayers(host, opened, manifest.id, manifest.data).catch((e: unknown) => {
      if (e instanceof SnapshotHeld) throw conflict(msg("checkpoint_import_exists", { id: manifest.id }));
      return rejected(e);
    });
    const now = new Date().toISOString();
    const record: CheckpointRecord = {
      version: CHECKPOINT_VERSION,
      id: manifest.id,
      hostId: host.host.id,
      boxId: manifest.boxId,
      boxName: manifest.boxName,
      label: manifest.label,
      reason: manifest.reason,
      createdBy,
      pinned: manifest.pinned,
      auto: false,
      consistency: manifest.consistency,
      specRevision: manifest.specRevision,
      spec: manifest.spec,
      data,
      system: null,
      trash: null,
      createdAt: manifest.createdAt,
      updatedAt: now,
    };
    try {
      host.checkpoints.write(record);
    } catch (e) {
      await forgetCopied(
        host,
        manifest.id,
        data.map((layer) => layer.snapshotId),
      );
      throw e;
    }
    log.info("checkpoint.imported", { id: manifest.id, box: manifest.boxName, layers: data.length });
    return viewOf(record);
  } finally {
    await opened.close().catch((e: unknown) => {
      log.warn("checkpoint.package_close_failed", { error: String(e) });
    });
  }
}

/**
 * Refuses an import whose checkpoint id is already here, as a record or as snapshots. The snapshots are left alone: a
 * refused import must never take away data that belongs to the checkpoint already on this instance.
 */
async function assertImportable(host: HostCtx, id: string): Promise<void> {
  if (host.checkpoints.read(id) !== null) throw conflict(msg("checkpoint_import_exists", { id }));
  const held = await host.checkpointEngine.tagged(host, checkpointTag(id));
  if (held.length > 0) throw conflict(msg("checkpoint_import_exists", { id }));
}

/**
 * Copies the package's snapshots of the given layers into this host's repository, and returns each layer with the id of
 * its new snapshot. When one layer cannot be matched, the copies already made are forgotten, so nothing is kept.
 */
async function unpackLayers(
  host: HostCtx,
  opened: OpenedPackage,
  checkpointId: string,
  layers: LayerFields[],
): Promise<DataLayer[]> {
  const from = layers.map((layer) => snapshotFor(opened.snapshots, layer.volumeId, layer.path));
  const copied = await opened.unpack(from);
  const ids = from.map((packaged) => copied.get(packaged));
  if (ids.some((id) => id === undefined)) {
    await forgetCopied(host, checkpointId, [...copied.values()]);
    throw new Error(`the copy of a layer of ${checkpointId} is missing from the repository`);
  }
  return layers.map((layer, index) => ({ ...layer, snapshotId: ids[index] ?? "" }));
}

/** Forgets snapshots that a transfer copied in and then could not keep. A step that fails is logged, and the original error wins. */
async function forgetCopied(host: HostCtx, checkpointId: string, snapshots: string[]): Promise<void> {
  for (const snapshot of snapshots) {
    await host.checkpointEngine.forget(host, snapshot).catch((e: unknown) => {
      log.warn("checkpoint.discard_failed", { id: checkpointId, snapshot, error: String(e) });
    });
  }
}

/** The template a copy needs on the target, copied from a holder when the target does not have it. */
async function ensureTemplate(
  target: HostCtx,
  holders: readonly HostCtx[],
  image: string,
  progress?: Progress,
): Promise<void> {
  if (await heldImage(target, image)) return;
  const source = await findTemplateSource(holders, image);
  if (!source) return;
  progress?.log?.(`Copying template ${image} to ${target.host.id}…\n`);
  await copyTemplate(source, target, image, progress);
}

/**
 * Refuses a copy the target already holds. A copy keeps the tags of the checkpoint it came from, so the tag finds the
 * copies made from that checkpoint. A copy of a copy is refused when its snapshots are copied in, since they share an origin.
 */
export async function assertNotCopied(target: HostCtx, id: string): Promise<void> {
  if ((await target.checkpointEngine.tagged(target, checkpointTag(id))).length > 0) {
    throw conflict(msg("checkpoint_copy_exists", { id, host: target.host.id }));
  }
}

/**
 * Marks the checkpoint as being copied, under the record lock, so retention leaves its snapshots alone until the copy
 * ends. A checkpoint that cannot be copied is refused here, and so is one the target already holds a copy of.
 */
async function reserveCopy(source: HostCtx, target: HostCtx, id: string): Promise<CheckpointRecord> {
  return source.checkpoints.exclusive(async () => {
    const found = source.checkpoints.read(id);
    if (!found || found.hostId !== source.host.id || found.trash !== null) {
      throw notFound(msg("checkpoint_not_found", { id }));
    }
    assertCopyable(viewOf(found));
    await assertNotCopied(target, id);
    source.checkpoints.exporting.add(id);
    return found;
  });
}

/**
 * Copies a checkpoint from `source` to `target`, so a box can be forked there. The source packs the checkpoint's snapshots
 * under a passphrase made for this copy alone, the target opens the package, and the package is removed. The copy gets its
 * own id, since a record is stored once per id, and keeps the box, settings and creation time of the original. Before the
 * snapshots are copied in, the target takes each template it lacks from one of `templateHolders`: the base template, which
 * a fork uses to set the owner of every volume it restores, and then the template the checkpoint names. A failure forgets
 * the snapshots already copied in.
 */
export async function copyCheckpoint(
  source: HostCtx,
  target: HostCtx,
  id: string,
  createdBy: string | null,
  templateHolders: readonly HostCtx[],
  progress?: Progress,
): Promise<CheckpointView> {
  const record = await reserveCopy(source, target, id);
  const packages = source.checkpoints.packages;
  const packageId = packages.allocateId();
  const path = packages.pathFor(packageId);
  const passphrase = randomBytes(32).toString("hex");
  packages.begin(packageId);
  let opened: OpenedPackage | undefined;
  let copies: string[] = [];
  try {
    await ensureTemplate(target, templateHolders, target.baseTemplateTag, progress);
    const image = record.spec?.template.image;
    if (image) await ensureTemplate(target, templateHolders, image, progress);
    if (progress?.signal?.aborted) throw abortError();
    progress?.log?.(`Packing ${record.label}…\n`);
    await source.checkpointEngine.pack(
      source,
      {
        snapshotIds: record.data.map((layer) => layer.snapshotId),
        manifest: manifestOf(record),
        passphrase,
      },
      path,
      packages.maxBytes,
      byteLog(progress, "Packed"),
    );
    if (progress?.signal?.aborted) throw abortError();
    progress?.log?.(`Restoring ${record.label} on ${target.host.id}…\n`);
    opened = await target.checkpointEngine.open(target, path, passphrase, byteLog(progress, "Sent")).catch(rejected);
    const layers = record.data.map(({ snapshotId: _snapshotId, ...layer }) => layer);
    const data = await unpackLayers(target, opened, id, layers).catch((e: unknown) => {
      if (e instanceof SnapshotHeld) throw conflict(msg("checkpoint_copy_exists", { id, host: target.host.id }));
      return rejected(e);
    });
    copies = data.map((layer) => layer.snapshotId);
    const copy: CheckpointRecord = {
      version: CHECKPOINT_VERSION,
      id: target.checkpoints.allocateId(),
      hostId: target.host.id,
      boxId: record.boxId,
      boxName: record.boxName,
      label: record.label,
      reason: record.reason,
      createdBy,
      pinned: record.pinned,
      auto: false,
      consistency: record.consistency,
      specRevision: record.specRevision,
      spec: record.spec,
      data,
      system: null,
      trash: null,
      createdAt: record.createdAt,
      updatedAt: new Date().toISOString(),
    };
    target.checkpoints.write(copy);
    copies = [];
    const bytes = data.reduce((sum, layer) => sum + layer.bytes, 0);
    log.info("checkpoint.copied", { id, copy: copy.id, host: target.host.id, bytes });
    return viewOf(copy);
  } catch (e) {
    await forgetCopied(target, id, copies);
    throw e;
  } finally {
    if (opened) {
      await opened.close().catch((e: unknown) => {
        log.warn("checkpoint.package_close_failed", { error: String(e) });
      });
    }
    packages.remove(packageId);
    packages.end(packageId);
    source.checkpoints.exporting.delete(id);
  }
}
