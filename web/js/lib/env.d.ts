/** One env entry as the API takes and returns it: a plain value, or the name of a secret. A secret's value never appears. */
export interface EnvEntry {
  name: string;
  value?: string;
  secretRef?: string;
}

/** One row of an env editor. `kind` says which of `value` and `secretRef` applies. */
export interface EnvRow {
  name: string;
  kind: "value" | "secret";
  value: string;
  secretRef: string;
}

export type EnvProblem =
  | { code: "count"; max: number }
  | { code: "name" }
  | { code: "duplicate" | "value" | "secret"; name: string };

export declare const ENV_MAX: number;
export declare const ENV_VALUE_MAX: number;
export declare const ENV_NAME_RE: RegExp;
export declare const SECRET_NAME_RE: RegExp;

export declare function validSecretValue(value: string): boolean;
export declare function envRowsOf(env: readonly Partial<EnvEntry>[] | null | undefined): EnvRow[];
export declare function checkEnvRows(rows: readonly EnvRow[]): { env: EnvEntry[] } | { problem: EnvProblem };
export declare function canonicalEnv(env: readonly Partial<EnvEntry>[] | null | undefined): string;
export declare function isEnvErrorKey(key: unknown): boolean;
