import { AppError, badRequest, conflict } from "../lib/errors";
import { msg } from "../lib/messages";
import type { BoxEnv, BoxSpec } from "../specs/types";
import type { SecretStore } from "./store";

/** The first entry that names a secret which is not set, or `undefined` when every reference resolves. */
function unsetSecret(store: SecretStore, env: readonly BoxEnv[]): BoxEnv | undefined {
  return env.find((entry) => entry.secretRef !== undefined && store.meta(entry.secretRef) === null);
}

/**
 * The refusal for an env entry whose secret is not set. A create, rebuild or update is a bad request (400). A start
 * is a conflict with the box as it is stored (409): the box cannot be started until the secret is set again.
 */
function missingSecret(entry: BoxEnv, status: "bad_request" | "conflict"): AppError {
  const text = msg("env_secret_missing", { name: entry.secretRef ?? "", env: entry.name });
  const hint = msg("env_secret_missing_hint");
  return status === "bad_request" ? badRequest(text, { field: "env" }, { hint }) : conflict(text, { hint });
}

/** Refuses a create, rebuild or update before anything is changed, when an entry names a secret that is not set. */
export function assertSecretsSet(store: SecretStore, env: readonly BoxEnv[]): void {
  const missing = unsetSecret(store, env);
  if (missing) throw missingSecret(missing, "bad_request");
}

/** Refuses a start or restart of a box whose stored env names a secret that is not set. */
export function assertSecretsStartable(store: SecretStore, env: readonly BoxEnv[]): void {
  const missing = unsetSecret(store, env);
  if (missing) throw missingSecret(missing, "conflict");
}

/**
 * Refuses a snapshot or a system image of a box whose env names a secret. An image keeps its container's environment,
 * so the value would be stored in it, and every box made from that image would start with it.
 */
export function assertNoSecretInImage(env: readonly BoxEnv[]): void {
  const entry = env.find((item) => item.secretRef !== undefined);
  if (!entry) return;
  throw conflict(msg("secret_in_image", { name: entry.secretRef ?? "", env: entry.name }), {
    hint: msg("secret_in_image_hint"),
  });
}

/**
 * The `NAME=value` entries a container is created with. A secret's value is read here and goes into the container
 * only. Nothing built from this list is stored, logged or returned. A missing secret is refused, never an empty value.
 */
export function containerEnv(store: SecretStore, env: readonly BoxEnv[]): string[] {
  return env.map((entry) => {
    if (entry.secretRef === undefined) return `${entry.name}=${entry.value ?? ""}`;
    const value = store.value(entry.secretRef);
    if (value === null) throw missingSecret(entry, "bad_request");
    return `${entry.name}=${value}`;
  });
}

/** Names of the boxes whose env refers to the secret, sorted. Only names leave this function. */
export function boxesUsing(specs: readonly BoxSpec[], secret: string): string[] {
  return specs
    .filter((spec) => spec.env.some((entry) => entry.secretRef === secret))
    .map((spec) => spec.name)
    .toSorted();
}
