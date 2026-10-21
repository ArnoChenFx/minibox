import type { HostCtx } from "../host/registry";
import { log } from "../lib/logger";
import { NAME_RE } from "../lib/validation";
import type { ContainerInfo } from "../runtime";
import { isBoxId, newBoxId } from "./revision";
import { RESET_FIELDS, type BoxMount, type BoxResources, type BoxSpec, type RecoverySource } from "./types";

/** A container label that is not a usable number. Empty means the box was created before that label existed. */
function labeledNumber(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mountsFromLabel(value: string | undefined): BoxMount[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    const mounts: BoxMount[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) return null;
      const mount = item as Partial<BoxMount>;
      if (typeof mount.volume !== "string" || typeof mount.path !== "string") return null;
      if (mount.mode !== "rw" && mount.mode !== "ro") return null;
      mounts.push({ volume: mount.volume, path: mount.path, mode: mount.mode });
    }
    return mounts;
  } catch {
    return null;
  }
}

/**
 * Current name. A rename is a `docker rename`, so a legal container suffix wins over a different legal name label.
 * A label that is not a legal box name is historical text and is kept even when the suffix is a short legal token.
 * Snapshot labels are built from this name, so dropping it would hide quotes, dollars, and newlines.
 */
export function nameFromContainer(
  prefix: string,
  containerName: string,
  labelName: string | null,
  labelId?: string | null,
): string {
  const head = `${prefix}-`;
  const suffix = containerName.startsWith(head) ? containerName.slice(head.length) : "";
  const suffixOk = suffix.length > 0 && NAME_RE.test(suffix);
  const labelOk = !!labelName && NAME_RE.test(labelName);
  // A rebuild names the container `<prefix>-<id>`. That suffix is the stable id, not the box name.
  const suffixIsId = suffixOk && !!labelId && suffix === labelId && isBoxId(suffix);
  if (labelName && !labelOk) return labelName;
  if (suffixOk && !suffixIsId) return suffix;
  if (labelOk && labelName) return labelName;
  if (suffixOk) return suffix;
  throw new ClaimError(`cannot derive a box name from container ${containerName}`);
}

export class ClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimError";
  }
}

function resourcesFromInspect(info: ContainerInfo): BoxResources {
  return { cpus: info.cpus, memoryBytes: info.memoryBytes, pids: info.pidsLimit };
}

function createdResources(info: ContainerInfo, labels: Record<string, string>, keys: HostCtx["keys"]): BoxResources {
  const observed = resourcesFromInspect(info);
  return {
    cpus: labeledNumber(labels[keys.cpus]) ?? observed.cpus,
    memoryBytes: labeledNumber(labels[keys.memory]) ?? observed.memoryBytes,
    pids: labeledNumber(labels[keys.pids]) ?? observed.pids,
  };
}

/**
 * Builds a spec from a live container. Identity and mounts prefer the create-time labels;
 * current resources and the restart policy come from inspect; the name follows {@link nameFromContainer}.
 * Mutable fields that were never on the container go back to defaults.
 */
export function specFromContainer(host: HostCtx, info: ContainerInfo, now: string, id: string): BoxSpec {
  const labels = info.labels;
  const keys = host.keys;
  const parsed = host.keys;
  const labelName = labels[parsed.name]?.trim() || null;
  const name = nameFromContainer(host.prefix, info.name, labelName, labels[keys.id] ?? null);
  const createdBy = labels[keys.createdBy]?.trim() || null;
  const digest = labels[keys.digest]?.trim() || info.imageId || null;
  const labeledMounts = mountsFromLabel(labels[keys.mounts]);
  const mounts: BoxMount[] =
    labeledMounts ?? info.mounts.map((mount) => ({ volume: mount.source, path: mount.target, mode: mount.mode }));
  const source: RecoverySource = isBoxId(labels[keys.id] ?? "") ? "degraded" : "claim";
  const needsReset: string[] = [...RESET_FIELDS];
  if (!createdBy) needsReset.push("createdBy");
  const profileLabel = labels[keys.profile];
  const profile =
    profileLabel === "standard" || profileLabel === "strict" || profileLabel === "relaxed" ? profileLabel : null;

  return {
    version: 1,
    id,
    name,
    createdName: labelName && NAME_RE.test(labelName) ? labelName : name,
    hostId: host.host.id,
    createdBy,
    template: {
      ref: labels[keys.template]?.trim() || info.image,
      image: info.image,
      digest,
    },
    resources: resourcesFromInspect(info),
    createdResources: createdResources(info, labels, keys),
    mounts,
    env: [],
    tools: [],
    labels: {},
    lifecycle: {
      desired: info.running ? "running" : "stopped",
      idleTimeoutSec: null,
      ttlSec: null,
      stopReason: info.running ? null : "manual",
    },
    profile,
    network: info.network,
    restart: "no",
    containerName: info.name,
    containerId: info.id,
    revision: 1,
    createdAt: labels[keys.created]?.trim() || info.created,
    updatedAt: now,
    recovery: { source, at: now, needsReset, observedRestart: info.restart },
    history: [],
  };
}

const RECOVERY_HINT = {
  claim:
    "Claimed an existing box. The container was not renamed. Idle timeout, TTL, labels, tools and env are defaults and need to be set again. Back up DATA_DIR; this container has no stable id label, so a later loss assigns a new id.",
  degraded:
    "DATA_DIR had no spec for this box. Identity and mounts were restored from container labels; current resources were taken from inspect. The fields in needsReset came back as defaults and need to be set again.",
} as const;

/**
 * Returns the spec for a container, writing one when DATA_DIR does not have it yet.
 * Does not rename the container and does not change its labels.
 */
export async function ensureSpec(host: HostCtx, info: ContainerInfo): Promise<{ spec: BoxSpec; created: boolean }> {
  return host.specs.exclusive(async () => {
    const labeledId = info.labels[host.keys.id] ?? "";
    const byContainer = host.specs.findByContainer(info.id, info.name);
    if (byContainer && (byContainer.containerId === info.id || byContainer.containerName === info.name)) {
      return { spec: byContainer, created: false };
    }
    const labeled = isBoxId(labeledId) ? host.specs.read(labeledId) : null;
    if (labeled && (labeled.containerId === info.id || labeled.containerName === info.name)) {
      return { spec: labeled, created: false };
    }
    if (labeled) {
      log.warn("box.spec_id_taken", {
        id: labeledId,
        container: info.name,
        holder: labeled.containerId,
        hint: "This container's id label already belongs to another spec. It was claimed under a new id. Labels were not changed.",
      });
    }

    let id = isBoxId(labeledId) && !labeled ? labeledId : "";
    if (!id) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = newBoxId();
        if (!host.specs.read(candidate)) {
          id = candidate;
          break;
        }
      }
    }
    if (!id) throw new ClaimError("could not allocate a box id");

    const spec = specFromContainer(host, info, new Date().toISOString(), id);
    const taken = host.specs.findByName(spec.name);
    if (taken) throw new ClaimError(`box name ${spec.name} is already used by ${taken.id}`);
    host.specs.write(spec);
    const recovery = spec.recovery;
    log.warn("box.spec_recovered", {
      source: recovery?.source,
      id: spec.id,
      name: spec.name,
      container: info.name,
      needsReset: recovery?.needsReset.join(",") ?? "",
      observedRestart: info.restart,
      hint: recovery ? RECOVERY_HINT[recovery.source] : "",
    });
    return { spec, created: true };
  });
}
