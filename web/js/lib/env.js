/**
 * Environment-variable helpers for the create, rebuild and box detail dialogs. No DOM and no imports, so the tests load
 * them directly.
 */

/** Most entries one box takes. Mirrors `ENV_MAX` in src/operations/validation.ts. */
export const ENV_MAX = 64;

/** Longest plain value, and longest secret value. Mirrors `ENV_VALUE_MAX` in src/operations/validation.ts. */
export const ENV_VALUE_MAX = 8192;

/** A variable name. Mirrors `ENV_NAME_RE` in src/operations/validation.ts. */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** A secret name, which is also its file name. Mirrors `IDENT_RE` in src/lib/validation.ts. */
export const SECRET_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

const CONTROL = /\p{Cc}/u;

/** Whether a secret value is one the server stores. Mirrors `checkSecretValue` in src/operations/validation.ts. */
export function validSecretValue(value) {
  return value.length > 0 && value.length <= ENV_VALUE_MAX && !CONTROL.test(value);
}

/** The rows an editor starts from, for an env list as the REST API returns it. A secret's value is never in it. */
export function envRowsOf(env) {
  return (env ?? []).map((entry) =>
    entry.secretRef === undefined
      ? { name: entry.name, kind: "value", value: entry.value ?? "", secretRef: "" }
      : { name: entry.name, kind: "secret", value: "", secretRef: entry.secretRef },
  );
}

/**
 * Checks the rows of an env editor before anything is sent. Returns `{ env }` in the shape the server takes, or
 * `{ problem }` for the first row the server would refuse. `name` is the variable the problem concerns.
 */
export function checkEnvRows(rows) {
  if (rows.length > ENV_MAX) return { problem: { code: "count", max: ENV_MAX } };
  const names = new Set();
  const env = [];
  for (const row of rows) {
    const name = row.name.trim();
    if (!ENV_NAME_RE.test(name)) return { problem: { code: "name" } };
    if (names.has(name)) return { problem: { code: "duplicate", name } };
    names.add(name);
    if (row.kind === "secret") {
      if (!SECRET_NAME_RE.test(row.secretRef)) return { problem: { code: "secret", name } };
      env.push({ name, secretRef: row.secretRef });
    } else {
      if (row.value.length > ENV_VALUE_MAX || CONTROL.test(row.value)) return { problem: { code: "value", name } };
      env.push({ name, value: row.value });
    }
  }
  return { env };
}

/** Order-independent JSON of an env list. A save sends the list only when it differs from the box's. */
export function canonicalEnv(env) {
  return JSON.stringify(
    [...(env ?? [])]
      .map((entry) => ({ name: entry.name, value: entry.value ?? null, secretRef: entry.secretRef ?? null }))
      .toSorted((a, b) => (a.name < b.name ? -1 : 1)),
  );
}

/** Whether a server error key concerns the env list. The create dialog shows those in its Environment section. */
export function isEnvErrorKey(key) {
  return typeof key === "string" && (key.startsWith("env_") || key === "secret_reference_forbidden");
}
