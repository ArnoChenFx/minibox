import type { BoxProfile } from "../box-profile";
import type { BoxEgress, EgressPolicy } from "../egress/policy";
import { containerName, egressNetworkName } from "../labels";
import { badRequest } from "../lib/errors";
import { msg } from "../lib/messages";
import type { ContainerChange } from "../runtime";
import type { BoxEnv, BoxMount, BoxSpec } from "./types";

/** What a rebuild keeps. The writable layer is not in this list. */
const REBUILD_KEEPS = ["volumes", "id", "name", "history"] as const;

/** What a rebuild drops. Checkpointing the writable layer is issue #11 and is not part of this step. */
export const REBUILD_LOSES = ["writableLayer", "processes", "ip"] as const;

export interface RebuildRequest {
  template?: string;
  mounts?: BoxMount[];
  env?: BoxEnv[];
  network?: string;
  profile?: BoxProfile | null;
  /** A checked policy (see `normalizeEgress`). Egress sets the box network, so it cannot come with `network`. */
  egress?: EgressPolicy;
}

export interface RebuildChange {
  field: "template" | "mounts" | "env" | "network" | "egress" | "profile" | "containerName";
  from: string;
  to: string;
}

/**
 * A tag-tracking box whose tag now names another image. `from` is the image its container runs and `to` is the image
 * the tag names. The service finds it by reading the engine, so the planner itself does no I/O.
 */
export interface MovedTag {
  tag: string;
  from: string;
  to: string;
}

export interface PlannedRebuild {
  /** Fields that differ. Empty when the request leaves the rebuild inputs as they are. */
  changes: RebuildChange[];
  /**
   * Set when the template ref changes or a tag-tracking box follows its tag to a new image. The image is checked
   * before a container is created.
   */
  templateRef: string | null;
  mounts: BoxMount[];
  env: BoxEnv[];
  network: string;
  /** The egress the box holds once rebuilt, on its private subnet. Null when it is open. */
  egress: BoxEgress | null;
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
    request.egress !== undefined ||
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

/** The first twelve hex digits of an image ID, as `docker images` shows it. */
const shortImageId = (id: string): string => id.replace(/^sha256:/, "").slice(0, 12);

/**
 * The rebuild a request would perform. Mounts, env, network, egress and profile stay as they are when omitted.
 * An empty request still follows a moved tag. The container is renamed to `<prefix>-<id>` only when something
 * else changes (decision D6). A moved tag is a template change, unless the request names another template:
 * that template is the one rebuilt onto.
 *
 * `egress` is the policy the box holds once rebuilt, which the service resolves because it allocates a subnet. A box
 * that holds egress joins its own private network; a box that leaves egress joins `defaultNetwork`, the host's box
 * network, unless it already runs on another network.
 */
export function planRebuild(
  prefix: string,
  spec: BoxSpec,
  request: RebuildRequest,
  moved: MovedTag | null,
  rotated: readonly string[],
  egress: BoxEgress | null,
  defaultNetwork: string,
): PlannedRebuild {
  const changes: RebuildChange[] = [];
  const requestedRef =
    request.template !== undefined && request.template !== spec.template.ref ? request.template : null;
  if (requestedRef !== null) {
    changes.push({ field: "template", from: spec.template.ref, to: requestedRef });
  } else if (moved) {
    changes.push({
      field: "template",
      from: `${moved.tag} (${shortImageId(moved.from)})`,
      to: `${moved.tag} (${shortImageId(moved.to)})`,
    });
  }
  const templateRef = requestedRef ?? moved?.tag ?? null;

  const mounts = request.mounts ?? spec.mounts;
  if (request.mounts !== undefined && canonMounts(request.mounts) !== canonMounts(spec.mounts)) {
    changes.push({ field: "mounts", from: canonMounts(spec.mounts), to: canonMounts(mounts) });
  }

  const env = request.env ?? spec.env;
  if (request.env !== undefined && canonEnv(request.env) !== canonEnv(spec.env)) {
    changes.push({ field: "env", from: canonEnv(spec.env), to: canonEnv(env) });
  }
  for (const name of rotated) {
    changes.push({ field: "env", from: `secret ${name}: value in use`, to: `secret ${name}: new value` });
  }

  const ownNetwork = egressNetworkName(prefix, spec.id);
  if (
    request.network !== undefined &&
    (request.egress !== undefined || (egress !== null && request.network !== ownNetwork))
  ) {
    throw badRequest(
      msg("egress_needs_network", { mode: request.egress?.mode ?? egress?.mode ?? "open", network: request.network }),
    );
  }
  const network = egress ? ownNetwork : (request.network ?? (spec.egress ? defaultNetwork : spec.network));
  if (request.network !== undefined && request.network !== spec.network) {
    changes.push({ field: "network", from: spec.network, to: network });
  }

  if (egressKey(spec.egress ?? null) !== egressKey(egress)) {
    changes.push({ field: "egress", from: egressText(spec.egress ?? null), to: egressText(egress) });
  }

  const profile = request.profile !== undefined ? request.profile : spec.profile;
  if (request.profile !== undefined && request.profile !== spec.profile) {
    changes.push({ field: "profile", from: spec.profile ?? "", to: profile ?? "" });
  }

  const nextName = containerName(prefix, spec.id);
  if (changes.length > 0 && nextName !== spec.containerName) {
    changes.push({ field: "containerName", from: spec.containerName, to: nextName });
  }

  return { changes, templateRef, mounts, env, network, egress, profile, containerName: nextName };
}

/** The tier and the lists a policy enforces. The subnet is not part of the policy, so it is not part of the key. */
const egressKey = (egress: BoxEgress | null): string =>
  egress === null ? "open" : JSON.stringify([egress.mode, egress.presets, egress.domains, egress.allow]);

/** The egress as a change shows it: its tier, and for proxy-only the hosts the proxy forwards to. */
function egressText(egress: BoxEgress | null): string {
  if (egress === null) return "open";
  return egress.mode === "proxy-only" ? `proxy-only: ${egress.allow.join(", ") || "no hosts"}` : egress.mode;
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
