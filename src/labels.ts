import { type BoxProfile, isBoxProfile } from "./box-profile";
import { MAX_OWNER_ID, type VolumeOwner } from "./runtime";

/**
 * Label keys derived from a configurable prefix.
 * Container labels are written once, at create, and only for values that cannot change later.
 * Mutable box state lives in DATA_DIR.
 */
export interface LabelKeys {
  box: string;
  name: string;
  template: string;
  created: string;
  templateName: string;
  templateDesc: string;
  snapshot: string;
  snapshotOf: string;
  profile: string;
  /** Stable box id (`bx_…`). Absent on boxes created before specs existed. */
  id: string;
  digest: string;
  mounts: string;
  cpus: string;
  memory: string;
  pids: string;
  createdBy: string;
}

export function labelKeys(prefix: string): LabelKeys {
  return {
    box: prefix,
    name: `${prefix}.name`,
    template: `${prefix}.template`,
    created: `${prefix}.created`,
    templateName: `${prefix}.template.name`,
    templateDesc: `${prefix}.template.description`,
    snapshot: `${prefix}.snapshot`,
    snapshotOf: `${prefix}.snapshot.of`,
    profile: `${prefix}.profile`,
    id: `${prefix}.id`,
    digest: `${prefix}.digest`,
    mounts: `${prefix}.mounts`,
    cpus: `${prefix}.cpus`,
    memory: `${prefix}.memory`,
    pids: `${prefix}.pids`,
    createdBy: `${prefix}.createdBy`,
  };
}

export interface BoxLabels {
  isBox: boolean;
  name: string | null;
  template: string;
  created: string | null;
  /** Null for boxes created before profiles existed. */
  profile: BoxProfile | null;
}

export function parseBoxLabels(labels: Record<string, string> | undefined | null, keys: LabelKeys): BoxLabels {
  const l = labels ?? {};
  const profile = l[keys.profile];
  return {
    isBox: l[keys.box] === "true",
    name: l[keys.name]?.trim() || null,
    template: l[keys.template] ?? "",
    created: l[keys.created] ?? null,
    profile: isBoxProfile(profile) ? profile : null,
  };
}

export interface ImageLabels {
  isTemplate: boolean;
  isSnapshot: boolean;
  templateName: string | null;
  description: string | null;
  snapshotOf: string | null;
  created: string | null;
}

export function parseImageLabels(labels: Record<string, string> | undefined | null, keys: LabelKeys): ImageLabels {
  const l = labels ?? {};
  return {
    isTemplate: l[keys.template] === "true",
    isSnapshot: l[keys.snapshot] === "true",
    templateName: l[keys.templateName] || null,
    description: l[keys.templateDesc] || null,
    snapshotOf: l[keys.snapshotOf] || null,
    created: l[keys.created] || null,
  };
}

export const containerName = (prefix: string, box: string) => `${prefix}-${box}`;
export const volumeName = (prefix: string, box: string) => `${prefix}-ws-${box}`;
export const boxNetworkName = (prefix: string) => `${prefix}-boxes`;

/** Container names from the Docker API have a leading slash. */
export const stripSlash = (name: string | undefined) => (name ?? "").replace(/^\//, "");

/**
 * Quote a value for a Dockerfile `LABEL` line (the `changes` of `docker commit`). Backslash, double quote and dollar
 * sign are escaped so the value is taken literally; an unescaped `$VAR` would expand from the image's environment.
 * Control characters are refused, since a newline would start a new instruction.
 */
export function quoteLabelValue(value: string): string {
  if (/\p{Cc}/u.test(value)) throw new Error("label values must not contain control characters");
  return `"${value.replace(/["\\$]/g, "\\$&")}"`;
}

export const labelChange = (key: string, value: string): string => `LABEL ${key}=${quoteLabelValue(value)}`;

/** Fixed, unprefixed: the base template Dockerfile writes these, whatever the configured prefix. */
export const TEMPLATE_UID_LABEL = "minibox.template.uid";
export const TEMPLATE_GID_LABEL = "minibox.template.gid";

/**
 * The owner a template gives `/workspace`, from its uid and gid labels. Both must be decimal ids in range. Otherwise the
 * template names no owner, and null is returned.
 */
export function templateOwnerOf(labels: Record<string, string> | undefined | null): VolumeOwner | null {
  const uid = labels?.[TEMPLATE_UID_LABEL];
  const gid = labels?.[TEMPLATE_GID_LABEL];
  if (!isOwnerId(uid) || !isOwnerId(gid)) return null;
  return { uid: Number(uid), gid: Number(gid) };
}

const isOwnerId = (value: string | undefined): value is string =>
  value !== undefined && /^\d+$/.test(value) && Number(value) <= MAX_OWNER_ID;
