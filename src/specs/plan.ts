import type { BoxProfile } from "../box-profile";
import { containerName } from "../labels";
import type { ContainerChange } from "../runtime";
import type { BoxEnv, BoxMount, BoxSpec } from "./types";

/** What a rebuild keeps. The writable layer is not in this list. */
export const REBUILD_KEEPS = ["volumes", "id", "name", "history"] as const;

/** What a rebuild drops. Checkpointing the writable layer is issue #11 and is not part of this step. */
export const REBUILD_LOSES = ["writableLayer", "processes", "ip"] as const;

export interface RebuildRequest {
  template?: string;
  mounts?: BoxMount[];
  env?: BoxEnv[];
  network?: string;
  profile?: BoxProfile | null;
}

export interface RebuildChange {
  field: "template" | "mounts" | "env" | "network" | "profile" | "containerName";
  from: string;
  to: string;
}

export interface PlannedRebuild {
  /** Fields that differ. Empty when the request leaves the rebuild inputs as they are. */
  changes: RebuildChange[];
  /** Set only when the template ref changes. The image is checked before a container is created. */
  templateRef: string | null;
  mounts: BoxMount[];
  env: BoxEnv[];
  network: string;
  profile: BoxProfile | null;
  /** `<prefix>-<id>`. Applied only when `changes` is not empty. */
  containerName: string;
}

export interface RebuildPreview {
  changes: RebuildChange[];
  diff: ContainerChange[];
  keeps: typeof REBUILD_KEEPS;
  loses: typeof REBUILD_LOSES;
  containerName: { from: string; to: string };
  revision: { current: number; next: number };
}

export function hasRebuildFields(request: RebuildRequest): boolean {
  return (
    request.template !== undefined ||
    request.mounts !== undefined ||
    request.env !== undefined ||
    request.network !== undefined ||
    request.profile !== undefined
  );
}

function canonMounts(mounts: BoxMount[]): string {
  const rows = mounts.map((mount) => ({ volume: mount.volume, path: mount.path, mode: mount.mode }));
  rows.sort((a, b) => `${a.path}\0${a.volume}`.localeCompare(`${b.path}\0${b.volume}`));
  return JSON.stringify(rows);
}

function canonEnv(env: BoxEnv[]): string {
  const rows = env.map((item) => ({
    name: item.name,
    value: item.value ?? null,
    secretRef: item.secretRef ?? null,
  }));
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify(rows);
}

/**
 * The rebuild a request would perform. Mounts, env, network and profile stay as they are when omitted.
 * The container is renamed to `<prefix>-<id>` only when something else changes (decision D6).
 */
export function planRebuild(prefix: string, spec: BoxSpec, request: RebuildRequest): PlannedRebuild {
  const changes: RebuildChange[] = [];
  const templateRef =
    request.template !== undefined && request.template !== spec.template.ref ? request.template : null;
  if (templateRef !== null) changes.push({ field: "template", from: spec.template.ref, to: templateRef });

  const mounts = request.mounts ?? spec.mounts;
  if (request.mounts !== undefined && canonMounts(request.mounts) !== canonMounts(spec.mounts)) {
    changes.push({ field: "mounts", from: canonMounts(spec.mounts), to: canonMounts(mounts) });
  }

  const env = request.env ?? spec.env;
  if (request.env !== undefined && canonEnv(request.env) !== canonEnv(spec.env)) {
    changes.push({ field: "env", from: canonEnv(spec.env), to: canonEnv(env) });
  }

  const network = request.network ?? spec.network;
  if (request.network !== undefined && request.network !== spec.network) {
    changes.push({ field: "network", from: spec.network, to: network });
  }

  const profile = request.profile !== undefined ? request.profile : spec.profile;
  if (request.profile !== undefined && request.profile !== spec.profile) {
    changes.push({ field: "profile", from: spec.profile ?? "", to: profile ?? "" });
  }

  const nextName = containerName(prefix, spec.id);
  if (changes.length > 0 && nextName !== spec.containerName) {
    changes.push({ field: "containerName", from: spec.containerName, to: nextName });
  }

  return { changes, templateRef, mounts, env, network, profile, containerName: nextName };
}

export function previewOf(spec: BoxSpec, planned: PlannedRebuild, diff: ContainerChange[]): RebuildPreview {
  return {
    changes: planned.changes,
    diff,
    keeps: REBUILD_KEEPS,
    loses: REBUILD_LOSES,
    containerName: { from: spec.containerName, to: planned.containerName },
    revision: { current: spec.revision, next: spec.revision + 1 },
  };
}
