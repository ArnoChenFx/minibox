import type { BoxProfile } from "../box-profile";

/** On-disk schema version of `DATA_DIR/boxes/<id>.json`. */
export const SPEC_VERSION = 1;

export type DesiredState = "running" | "stopped";
export type StopReason = "idle" | "ttl" | "manual";
export type MountMode = "rw" | "ro";
export type RecoverySource = "claim" | "degraded";

/** Mutable fields that are not on the container, so a recovered spec puts them back to defaults. */
export const RESET_FIELDS = ["idleTimeout", "ttl", "labels", "tools", "env"] as const;

export interface BoxMount {
  volume: string;
  path: string;
  mode: MountMode;
}

export interface BoxResources {
  cpus: number | null;
  memoryBytes: number | null;
  pids: number | null;
}

/** Plain env vars and references to values stored under `DATA_DIR/secrets`. The value itself is never a container label. */
export interface BoxEnv {
  name: string;
  value?: string;
  secretRef?: string;
}

export interface BoxTool {
  id: string;
  version: string;
}

/**
 * How a spec was rebuilt from a live container. `claim` is a box that never had a spec.
 * `degraded` is a box whose spec file was lost and whose identity labels are still on the container.
 */
export interface BoxRecovery {
  source: RecoverySource;
  at: string;
  /** Field names the operator needs to set again. Identity and mounts are not in this list. */
  needsReset: string[];
  /** Restart policy observed on the container. The spec's own policy stays `no`. */
  observedRestart: string;
}

/**
 * Desired state of one box. The file under `DATA_DIR/boxes` is the authority.
 * Container labels are a create-time copy of the immutable parts, used only when this file is missing.
 */
export interface BoxSpec {
  version: typeof SPEC_VERSION;
  id: string;
  /** Current name. Unique across every host this control plane manages. */
  name: string;
  /** Name at create time. Stays on the container label across renames. */
  createdName: string;
  hostId: string;
  /** Principal that created the box. Null when a claimed container has no record of one. */
  createdBy: string | null;
  template: { ref: string; image: string; digest: string | null };
  resources: BoxResources;
  /** Resources written onto the container at create time. In-place updates do not change this. */
  createdResources: BoxResources;
  mounts: BoxMount[];
  env: BoxEnv[];
  tools: BoxTool[];
  /** User labels. Mutable, and never copied onto the container. */
  labels: Record<string, string>;
  lifecycle: {
    desired: DesiredState;
    idleTimeoutSec: number | null;
    ttlSec: number | null;
    /**
     * Why desired is `stopped`. `idle` / `ttl` come from the lifecycle watcher (#12); `manual` from stop/restart.
     * Cleared when desired becomes `running`. Absent on specs written before #12 (readers treat that as null).
     */
    stopReason?: StopReason | null;
  };
  profile: BoxProfile | null;
  network: string;
  /**
   * Always `no`. Docker must not restart a box on its own: the reconciler applies `lifecycle.desired`
   * (decision D8).
   */
  restart: "no";
  /**
   * Docker name. Claim does not change it (decision D6). A rebuild renames it to `<prefix>-<id>`.
   * An in-place rename still follows the box name.
   */
  containerName: string;
  containerId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  recovery: BoxRecovery | null;
  /**
   * Previous revisions, newest first. Files written before history existed omit this;
   * readers treat that as an empty list.
   */
  history: SpecSnapshot[];
}

/** One stored revision, without its own history, so the file does not nest. */
export interface SpecSnapshot {
  revision: number;
  at: string;
  spec: Omit<BoxSpec, "history">;
}

export interface BoxDrift {
  field: string;
  expected: string;
  actual: string;
}
