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
import { badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { type CheckpointView, type Progress, viewOf } from "./checkpoints";

export interface PackageView {
  id: string;
  checkpointId: string | null;
  origin: "export" | "upload";
  bytes: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
  url: string;
}

export const checkpointTag = (id: string): string => `checkpoint:${id}`;
const volumeTag = (volumeId: string): string => `volume:${volumeId}`;

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

function snapshotFor(
  snapshots: { id: string; tags: string[] }[],
  checkpointId: string,
  volumeId: string,
  path: string,
): string {
  const match = snapshots.find(
    (snapshot) => snapshot.tags.includes(checkpointTag(checkpointId)) && snapshot.tags.includes(volumeTag(volumeId)),
  );
  if (!match) throw rejected(new PackageRejected("invalid", `the package holds no snapshot for ${path}`));
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
  const opened = await host.checkpointEngine.open(host, path, passphrase).catch(rejected);
  try {
    const manifests = opened.snapshots.filter((snapshot) => snapshot.tags.includes(MANIFEST_TAG));
    const [manifestSnapshot] = manifests;
    if (manifests.length !== 1 || !manifestSnapshot) {
      throw badRequest(msg("package_invalid", { reason: "the package holds no single manifest" }));
    }
    const manifest = parseManifest(await opened.readManifest(manifestSnapshot.id).catch(rejected));
    await assertImportable(host, manifest.id);
    const sources = manifest.data.map((layer) => ({
      layer,
      from: snapshotFor(opened.snapshots, manifest.id, layer.volumeId, layer.path),
    }));
    progress?.log?.(`Restoring ${manifest.label}…\n`);
    const data = await copyLayers(host, manifest.id, opened, sources);
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
      await discardCopies(host, manifest.id);
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

/** Copies the package's snapshots into this repository, then maps each layer to its new snapshot id by tag. */
async function copyLayers(
  host: HostCtx,
  checkpointId: string,
  opened: { unpack(snapshotIds: string[]): Promise<void> },
  sources: { layer: PackageManifest["data"][number]; from: string }[],
): Promise<DataLayer[]> {
  try {
    await opened.unpack(sources.map((source) => source.from));
    const copies = await host.checkpointEngine.tagged(host, checkpointTag(checkpointId));
    return sources.map(({ layer }) => {
      const copy = copies.find((snapshot) => snapshot.tags.includes(volumeTag(layer.volumeId)));
      if (!copy) throw new Error(`the copy of ${layer.path} is missing from the repository`);
      return { ...layer, snapshotId: copy.id };
    });
  } catch (e) {
    await discardCopies(host, checkpointId);
    throw e;
  }
}

/** Forgets the snapshots of a checkpoint that was being imported. A step that fails is logged, and the original error wins. */
async function discardCopies(host: HostCtx, checkpointId: string): Promise<void> {
  const copies = await host.checkpointEngine.tagged(host, checkpointTag(checkpointId)).catch((e: unknown) => {
    log.warn("checkpoint.discard_failed", { id: checkpointId, error: String(e) });
    return [];
  });
  for (const copy of copies) {
    await host.checkpointEngine.forget(host, copy.id).catch((e: unknown) => {
      log.warn("checkpoint.discard_failed", { id: checkpointId, snapshot: copy.id, error: String(e) });
    });
  }
}
