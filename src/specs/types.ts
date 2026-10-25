import type { BoxProfile } from "../box-profile";
import type { BoxEgress } from "../egress/policy";
import type { MessageKey, Params } from "../lib/messages";

/** On-disk schema version of `DATA_DIR/boxes/<id>.json`. */
export const SPEC_VERSION = 1;

export type DesiredState = "running" | "stopped";
export type StopReason = "idle" | "ttl" | "manual" | "volume_limit";
export type MountMode = "rw" | "ro";
export type RecoverySource = "claim" | "degraded";

/** Mutable fields that are not on the container, so a recovered spec puts them back to defaults. */
export const RESET_FIELDS = ["idleTimeout", "ttl", "labels", "tools", "env", "startupCommand"] as const;

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

/**
 * A plain env var (`value`) or a reference to a secret under `DATA_DIR/secrets/env` (`secretRef`). A secret's value is
 * never stored on the spec, so it is not in the spec's revisions or in an API answer.
 */
export interface BoxEnv {
  name: string;
  value?: string;
  secretRef?: string;
}

export interface BoxTool {
  id: string;
  version: string;
}

/** A startup command that did not start, and the message that says why. It reads only for the container it failed in. */
export interface StartupFailure {
  containerId: string;
  key: MessageKey;
  params?: Params;
  at: string;
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
  /**
   * Shell command run in the box's init session at every start, as typed. Absent when none is set. A command may hold
   * secrets, so it is returned only to callers that may use them, and it stays out of events and audit records.
   */
  startupCommand?: string;
  /**
   * Set when the box is created with a repository or a setup (a template's `postCreateCommand`) and a startup command.
   * The command waits for the setup task, so no start launches it until the clone and the `postCreateCommand` have
   * ended. Absent once the setup has ended, or when the box has neither a clone nor a setup.
   */
  startupAwaitsSetup?: boolean;
  /** Why the startup command last failed to start. Cleared by a launch that works, or by a change of the command. */
  startupFailure?: StartupFailure;
  /**
   * The box's agent holds a `self` token, which MiniBox issues at every start and revokes at every stop. Absent or false
   * when the box has none. The container gets the tmpfs the token file lives in only when it is created with this set.
   */
  selfToken?: boolean;
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
   * The egress policy. Absent on an `open` box, which is the default and the only kind older specs describe. A box that
   * is not open runs on the private network named by `network`.
   */
  egress?: BoxEgress;
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
