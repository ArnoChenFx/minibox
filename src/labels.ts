/** Label keys derived from a configurable prefix. All MiniBox state lives in Docker labels. */
export interface LabelKeys {
  box: string;
  name: string;
  template: string;
  created: string;
  templateName: string;
  templateDesc: string;
  snapshot: string;
  snapshotOf: string;
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
  };
}

export interface BoxLabels {
  isBox: boolean;
  name: string | null;
  template: string;
  created: string | null;
}

export function parseBoxLabels(labels: Record<string, string> | undefined | null, keys: LabelKeys): BoxLabels {
  const l = labels ?? {};
  return {
    isBox: l[keys.box] === "true",
    name: l[keys.name]?.trim() || null,
    template: l[keys.template] ?? "",
    created: l[keys.created] ?? null,
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

/** Container names from the Docker API have a leading slash. */
export const stripSlash = (name: string | undefined) => (name ?? "").replace(/^\//, "");
