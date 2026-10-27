/** The values the pool form holds, all as text except the two flags and the backend. */
export interface PoolForm {
  name: string;
  backend: "local" | "nfs" | "path";
  server: string;
  export: string;
  /** The options as one comma-separated field. */
  options: string;
  root: string;
  marker: string;
  default: boolean;
}

/** The pool a form describes, in the shape `PUT /api/pools` takes. */
export interface PoolDraft {
  name: string;
  backend: "local" | "nfs" | "path";
  default: boolean;
  server: string | null;
  export: string | null;
  options: string[];
  root: string | null;
  marker: string | null;
  capabilities: { shareable: boolean; snapshots: boolean; quota: boolean; clone: boolean; crossHost: boolean };
}

/** A pool as the page holds it, which is a saved pool. */
export interface PoolLike {
  name: string;
  backend: "local" | "nfs" | "path";
  default?: boolean;
  server?: string | null;
  export?: string | null;
  options?: string[];
  root?: string | null;
  marker?: string | null;
}

export type PoolCheck = { pool: PoolDraft } | { error: string; field: string };

export declare const DEFAULT_MARKER: string;
export declare const OPTION_RE: RegExp;
export declare const OPTION_MAX: number;

/** The form values of a pool, or of a blank pool of the given backend. */
export declare function poolForm(pool?: Partial<PoolLike>): PoolForm;

/** The options a comma-separated field names, trimmed and without the empty entries. */
export declare function splitOptions(text: string): string[];

/**
 * The pool a filled form describes, or the first thing wrong with it. `pool` is the pool being edited, whose backend is
 * kept, and `pools` the list the name must not clash with.
 */
export declare function poolDraft(
  form: PoolForm,
  options?: { pool?: PoolLike | null; pools?: readonly PoolLike[] },
): PoolCheck;

/** The pool list with `draft` in the place of the pool called `original`. */
export declare function applyPoolDraft(pools: readonly PoolLike[], original: string, draft: PoolDraft): PoolLike[];

/** The role defaults with every role that pointed at `from` pointing at `to`. */
export declare function renameRole(
  roles: Record<string, string | null>,
  from: string,
  to: string,
): Record<string, string | null>;

/** One line describing what a pool mounts, for the save preview. */
export declare function poolSummary(pool: PoolLike): string;

/** The pools whose parameters a save changes, as `{ name, from, to }` summaries. */
export declare function poolChanges(
  before: readonly PoolLike[],
  after: readonly PoolLike[],
): { name: string; from: string; to: string }[];
