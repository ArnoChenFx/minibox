export type SourceKind = "dockerfile" | "git" | "context" | "devcontainer";

/** Every kind a template records: a source the dialog offers, or an official template MiniBox builds. */
export type BuildKind = SourceKind | "official";

/** The fields the template dialog reads. Each kind uses the ones its panel shows. */
export interface SourceFields {
  text?: unknown;
  url?: unknown;
  branch?: unknown;
  subdir?: unknown;
  dockerfile?: unknown;
  path?: unknown;
  secretRef?: unknown;
}

export interface CloneFields {
  url?: unknown;
  branch?: unknown;
  secretRef?: unknown;
}

export interface RepoBody {
  url: string;
  branch?: string;
  secretRef?: string;
}

export type SourceResult = { source: Record<string, string> } | { problem: string; key: string };
export type CloneResult = { repo: RepoBody | null } | { problem: "url"; key: string };

export declare const SOURCE_KINDS: readonly SourceKind[];
export declare const KIND_LABEL_KEYS: Readonly<Record<BuildKind, string>>;

export declare function imageRefOk(value: unknown): boolean;
export declare function templateSource(kind: string, fields: SourceFields): SourceResult;
export declare function cloneRepo(fields: CloneFields): CloneResult;
