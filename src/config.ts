import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { accessKeyPath, createSecretFile, ensureDataDir, readSecretFile, resolveDataDir } from "./data-dir";
import { log } from "./lib/logger";

export const ROOT = join(import.meta.dir, "..");
export const ENV_PATH = join(ROOT, ".env");

export type AccessKeySource = "env" | "env-file" | "data-dir" | "generated";

export interface Config {
  host: string;
  port: number;
  accessKey: string;
  accessKeySource: AccessKeySource;
  dataDir: string;
  dockerSocket: string;
  labelPrefix: string;
  baseTemplateTag: string;
  webDir: string;
  templatesDir: string;
  metricsIntervalMs: number;
  metricsHistory: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

/** Parse a dotenv-style file (KEY=VALUE, `#` comments, optional quotes). */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readEnvFile(path: string): Record<string, string> {
  return existsSync(path) ? parseDotenv(readFileSync(path, "utf8")) : {};
}

function intOr(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const nonBlank = (value: string | undefined): string | undefined => value?.trim() || undefined;

export interface LoadOptions {
  /** Dotenv file to read. It is only ever read, never written. Defaults to `<project>/.env`. */
  envFile?: string;
}

/**
 * Load configuration. Precedence: process env > .env file > defaults.
 * ACCESS_KEY falls back to `DATA_DIR/access_key`; if nothing sets it, a random key is generated there.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env, options: LoadOptions = {}): Config {
  const file = readEnvFile(options.envFile ?? ENV_PATH);
  const get = (k: string) => env[k] ?? file[k];

  const dataDir = resolveDataDir(nonBlank(env.DATA_DIR) ?? nonBlank(file.DATA_DIR), ROOT);
  tryEnsureDataDir(dataDir);
  const { accessKey, accessKeySource } = resolveAccessKey(env, file, dataDir);

  const labelPrefix = get("LABEL_PREFIX")?.trim() || "minibox";
  const level = get("LOG_LEVEL");
  return {
    host: get("HOST")?.trim() || "127.0.0.1",
    port: intOr(get("PORT"), 3920),
    accessKey,
    accessKeySource,
    dataDir,
    dockerSocket: get("DOCKER_SOCKET")?.trim() || "/var/run/docker.sock",
    labelPrefix,
    baseTemplateTag: get("BASE_TEMPLATE")?.trim() || `${labelPrefix}-template:base`,
    webDir: join(ROOT, "web"),
    templatesDir: join(ROOT, "templates"),
    metricsIntervalMs: intOr(get("METRICS_INTERVAL_MS"), 3000),
    metricsHistory: intOr(get("METRICS_HISTORY"), 120),
    logLevel: level === "debug" || level === "warn" || level === "error" ? level : "info",
  };
}

/** Lay out DATA_DIR at startup. A failure is logged rather than fatal: only generating a key needs it writable. */
function tryEnsureDataDir(dataDir: string): void {
  try {
    ensureDataDir(dataDir);
  } catch (e) {
    log.warn("data_dir.unavailable", { dataDir, error: String(e) });
  }
}

/** Precedence: process env > .env > DATA_DIR/access_key > a newly generated key stored there. Blank counts as unset. */
function resolveAccessKey(
  env: Record<string, string | undefined>,
  file: Record<string, string>,
  dataDir: string,
): { accessKey: string; accessKeySource: AccessKeySource } {
  const fromEnv = nonBlank(env.ACCESS_KEY);
  const fromFile = nonBlank(file.ACCESS_KEY);
  if (fromEnv) {
    // Bun copies .env into process.env when started from the project root, so an identical value came from .env.
    return { accessKey: fromEnv, accessKeySource: fromEnv === fromFile ? "env-file" : "env" };
  }
  if (fromFile) return { accessKey: fromFile, accessKeySource: "env-file" };

  const path = accessKeyPath(dataDir);
  try {
    const stored = readSecretFile(path);
    if (stored) return { accessKey: stored, accessKeySource: "data-dir" };

    ensureDataDir(dataDir);
    const generated = randomBytes(32).toString("hex");
    if (createSecretFile(path, generated)) return { accessKey: generated, accessKeySource: "generated" };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `No ACCESS_KEY is configured and ${path} cannot be used (${reason}). Set ACCESS_KEY, or point DATA_DIR at a writable directory.`,
      { cause: e },
    );
  }

  // Another process created the file between our read and our create; use the key it stored.
  const raced = readSecretFile(path);
  if (raced) return { accessKey: raced, accessKeySource: "data-dir" };
  throw new Error(`${path} is empty; delete it to generate a new access key`);
}
