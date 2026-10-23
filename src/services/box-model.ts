import type { BoxProfile } from "../box-profile";
import type { TrashRef } from "../checkpoints/types";
import type { EgressPolicy } from "../egress/policy";
import type { AuditNote } from "../events/types";
import type { ContainerStats } from "../runtime";
import type { BoxMount, BoxEnv, DesiredState, StopReason, BoxRecovery } from "../specs/types";
import type { VolumeRole } from "../volumes/types";

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
  /** Env entries stored on the spec. A secret's value is read into the container when it is created. */
  env?: BoxEnv[];
  /** `null` inherits the global default. `0` disables idle sleep for this box. */
  idleTimeoutSec?: number | null;
  /** Absolute lifetime from create time. `null` means no TTL. */
  ttlSec?: number | null;
  /** Catalog tool ids to record on the spec (`version: latest`). Install via tool.reconcile. */
  tools?: string[];
  /** Runs in the box's init session at every start. Absent means none. Templates and snapshots never pass one. */
  startupCommand?: string;
  /** The checked egress policy. Absent, like `open`, keeps the box on the default network. */
  egress?: EgressPolicy;
  /** Give the box's agent a `self` token, delivered as a file in the box. Absent or false means none. */
  selfToken?: boolean;
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
  /**
   * The egress policy, present only when the box is not `open`. An open box, the default, reports none, so its record is
   * the same as before egress existed. A box with another mode runs on its own private network.
   */
  egress?: EgressPolicy;
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
  /** Desired tools from the spec (`id` + `version`). */
  tools: { id: string; version: string }[];
  /** `unreachable` when a pool backing a mount could not be probed. The engine state stays in `state`. */
  storage: {
    status: "ok" | "unreachable" | "unknown";
    pools: { name: string; status: "reachable" | "unreachable" | "unknown" }[];
  };
  stats?: ContainerStats | null;
  /** The host the box runs on. Present only when the control plane holds more than one host. */
  hostId?: string;
  /** True when the box was created with a `self` token. Absent otherwise, so older payloads do not change. */
  selfToken?: boolean;
}

export interface BoxMountView extends BoxMount {
  volumeId: string | null;
  volumeName: string | null;
  role: VolumeRole | null;
  pool: string | null;
}

export const MB = 1024 * 1024;

/** Options for a start a request caused. `record` writes the `box.wake` note, and only when the box was asleep. */
export interface StartOptions {
  readonly record?: (note: AuditNote) => void;
}

export interface EnsureResult {
  readonly box: Box;
  /** True when this call started the box. */
  readonly woke: boolean;
}

export interface DeleteBoxResult {
  name: string;
  volumeDeleted: boolean;
  /** Why the requested volume removal failed. The box itself is always removed first. */
  volumeError?: string;
  /** The recycle bin entry that kept the box's data, or null when none was kept. */
  trash: TrashRef | null;
}

export interface DeleteBoxOptions {
  /**
   * Runs under the box's power lock, before the container is removed, and returns what it kept. A throw stops the delete
   * with the box as it was, so nothing it keeps can be missing from a box that is gone.
   */
  keep?: (box: Box) => Promise<TrashRef | null>;
}
