export interface TokenCatalog {
  groups: { id: string; danger: boolean; scopes: string[] }[];
  presets: {
    name: string;
    scopes: string[];
    boxes: string;
    hosts: string;
    quotas: Record<string, number | null>;
  }[];
}

export interface ScopedToken {
  preset: string | null;
  scopes: string[];
  volumes: { type: string; ids?: string[] };
}

export type ScopeSummary =
  | { kind: "preset"; name: string; count: number }
  | { kind: "custom"; base: string | null; count: number };

export declare function allScopes(catalog: TokenCatalog): string[];
export declare function sameScopes(a: readonly string[], b: readonly string[]): boolean;
export declare function matchesPreset(
  scopes: readonly string[],
  preset: { scopes: readonly string[] },
  grantsVolumes?: boolean,
): boolean;
export declare function summarizeScopes(token: ScopedToken, catalog: TokenCatalog | undefined): ScopeSummary;
export declare function scopeRequest(
  presetName: string,
  chosen: readonly string[],
  catalog: TokenCatalog,
): { preset: string; scopes?: string[] };
