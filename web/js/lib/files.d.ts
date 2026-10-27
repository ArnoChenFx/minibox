export declare const PREVIEW_MAX_BYTES: number;
export declare const LISTING_LIMIT: number;
export declare const NAME_MAX_BYTES: number;

export type EntryType = "file" | "dir" | "symlink" | "other";

export interface Entry {
  path: string;
  type: EntryType;
  size: number | null;
  mtime: string | null;
}

export interface Child extends Entry {
  name: string;
}

export interface SortOptions {
  key?: "name" | "size" | "modified";
  descending?: boolean;
}

export interface VisibleOptions {
  query?: string;
  showHidden?: boolean;
}

export interface Plan {
  path: string;
}

export interface Mount {
  path: string;
  volume: string;
  volumeId: string | null;
  volumeName: string | null;
  role: string | null;
  mode: string;
}

export interface Root {
  path: string;
  volumeId: string;
  volumeName: string | null;
  role: string | null;
  mode: string;
}

export declare function rootsOf(mounts: readonly Mount[]): Root[];
export declare function pickRoot(roots: readonly Root[], path: string | null): Root | null;
export declare function joinPath(dir: string, name: string): string;
export declare function parentOf(path: string): string;
export declare function baseOf(path: string): string;
export declare function absolutePath(rootPath: string, path: string): string;
export declare function crumbsOf(dir: string): { name: string; path: string }[];
export declare function childrenOf(entries: readonly Entry[], dir: string): Child[];
export declare function visibleEntries(children: readonly Child[], options?: VisibleOptions): Child[];
export declare function sortEntries(entries: readonly Child[], options?: SortOptions): Child[];
export declare function nameProblem(name: string): string;
export declare function clashesOf<T extends Plan>(
  plans: readonly T[],
  namesIn: ReadonlyMap<string, ReadonlySet<string>>,
): T[];
export declare function previewable(entry: Entry): boolean;
export declare function listUrl(volumeId: string, dir: string): string;
export declare const contentUrl: (volumeId: string, path: string) => string;
export declare const downloadUrl: (volumeId: string, path: string) => string;
export declare const uploadUrl: (volumeId: string, path: string, overwrite: boolean) => string;
export declare const deleteUrl: (volumeId: string, path: string, confirm?: boolean) => string;
export declare const mkdirUrl: (volumeId: string) => string;
export declare const moveUrl: (volumeId: string) => string;
