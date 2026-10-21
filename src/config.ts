import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { BOX_PROFILES, type BoxProfile, DEFAULT_BOX_PROFILE, DEFAULT_PIDS_LIMIT, isBoxProfile } from "./box-profile";
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
  /** Seconds a box gets to stop after SIGTERM before it is killed. Used by stop and restart. */
  stopTimeoutSec: number;
  webDir: string;
  templatesDir: string;
  metricsIntervalMs: number;
  metricsHistory: number;
  eventRetentionAuditDays: number;
  eventRetentionActivityDays: number;
  eventOutputRetentionDays: number;
  eventOutputMaxMb: number;
  logLevel: "debug" | "info" | "warn" | "error";
  trustProxy: boolean;
  cookieSecure: boolean;
  allowedOrigins: string[];
  /** Security profile for new boxes when the request does not choose one. */
  boxProfile: BoxProfile;
  /** Maximum number of processes in each box. */
  boxPidsLimit: number;
  /** OCI runtime for boxes, such as `runsc` for gVisor. Null keeps the engine's default runtime. */
  containerRuntime: string | null;
  /** Absolute lifetime of a browser session, counted from sign-in. */
  sessionTtlMs: number;
  /** Sliding renewal: a session also ends this long after its last use. `null` leaves sessions without it. */
  sessionIdleMs: number | null;
  /** Event and task streams open at once, across all browsers and clients. A stream past this is refused with 429. */
  streamMaxConnections: number;
  /** Seconds without input before a human's takeover of an agent's terminal session returns it to the agent. 0 keeps it until released. */
  takeoverIdleSec: number;
  /**
   * Global default idle timeout for boxes, in seconds. `0` disables idle sleep unless a box sets its own timeout.
   * Per-box `idleTimeoutSec` of `0` also disables sleep; `null` inherits this default.
   */
  boxIdleTimeoutSec: number;
  /** A box is idle only when its recent CPU sample is strictly below this percent. */
  boxIdleCpuPercent: number;
  /** How often the lifecycle watcher checks idle sleep and TTL. */
  lifecycleIntervalMs: number;
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

/** A whole number from `min` to `max`. Blank or out-of-range values fall back, as intOr does. */
function intInRange(value: string | undefined, fallback: number, min: number, max: number): number {
  const text = value?.trim() ?? "";
  if (text === "") return fallback;
  const n = Number(text);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function isTruthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

/** Comma-separated list of extra browser origins allowed to make cross-host requests, e.g. `https://minibox.example.com`. */
function parseOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      let url: URL;
      try {
        url = new URL(s);
      } catch {
        throw new Error(`ALLOWED_ORIGINS: "${s}" is not a valid origin (expected e.g. https://minibox.example.com)`);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`ALLOWED_ORIGINS: "${s}" must use http:// or https://`);
      }
      return url.origin;
    });
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SESSION_DAYS = 3650;
export const DEFAULT_SESSION_TTL_MS = 30 * DAY_MS;

/** Parses a day count such as `30` or `0.5`. Blank means unset. Out-of-range values stop startup rather than being guessed at. */
function parseDays(value: string | undefined, name: string): number | null {
  const raw = value?.trim();
  if (!raw) return null;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0 || days > MAX_SESSION_DAYS) {
    throw new Error(`${name} must be a number of days above 0 and at most ${MAX_SESSION_DAYS}, got "${raw}"`);
  }
  return days * DAY_MS;
}

const nonBlank = (value: string | undefined): string | undefined => value?.trim() || undefined;

/** An unknown name stops startup: a typo must not quietly give every new box a different profile. */
function parseBoxProfile(value: string | undefined): BoxProfile {
  const v = nonBlank(value);
  if (v === undefined) return DEFAULT_BOX_PROFILE;
  if (!isBoxProfile(v)) throw new Error(`BOX_PROFILE: "${v}" must be one of ${BOX_PROFILES.join(", ")}`);
  return v;
}

function parseBoxPidsLimit(value: string | undefined): number {
  const v = nonBlank(value);
  if (v === undefined) return DEFAULT_PIDS_LIMIT;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`BOX_PIDS_LIMIT: "${v}" must be a positive integer`);
  return n;
}

const RUNTIME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function parseContainerRuntime(value: string | undefined): string | null {
  const v = nonBlank(value);
  if (v === undefined) return null;
  if (!RUNTIME_NAME_RE.test(v)) throw new Error(`RUNTIME: "${v}" is not a valid runtime name (for example runsc)`);
  return v;
}

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
    stopTimeoutSec: intInRange(get("STOP_TIMEOUT_SEC"), 3, 0, 300),
    webDir: join(ROOT, "web"),
    templatesDir: join(ROOT, "templates"),
    metricsIntervalMs: intOr(get("METRICS_INTERVAL_MS"), 3000),
    metricsHistory: intOr(get("METRICS_HISTORY"), 120),
    eventRetentionAuditDays: intOr(get("EVENT_RETENTION_AUDIT_DAYS"), 365),
    eventRetentionActivityDays: intOr(get("EVENT_RETENTION_ACTIVITY_DAYS"), 30),
    eventOutputRetentionDays: intOr(get("EVENT_OUTPUT_RETENTION_DAYS"), 7),
    eventOutputMaxMb: intOr(get("EVENT_OUTPUT_MAX_MB"), 512),
    logLevel: level === "debug" || level === "warn" || level === "error" ? level : "info",
    trustProxy: isTruthy(get("TRUST_PROXY")),
    cookieSecure: isTruthy(get("COOKIE_SECURE")),
    allowedOrigins: parseOrigins(get("ALLOWED_ORIGINS")),
    boxProfile: parseBoxProfile(get("BOX_PROFILE")),
    boxPidsLimit: parseBoxPidsLimit(get("BOX_PIDS_LIMIT")),
    containerRuntime: parseContainerRuntime(get("RUNTIME")),
    sessionTtlMs: parseDays(get("SESSION_TTL_DAYS"), "SESSION_TTL_DAYS") ?? DEFAULT_SESSION_TTL_MS,
    sessionIdleMs: parseDays(get("SESSION_IDLE_DAYS"), "SESSION_IDLE_DAYS"),
    streamMaxConnections: intOr(get("STREAM_MAX_CONNECTIONS"), 256),
    takeoverIdleSec: intInRange(get("SESSION_TAKEOVER_IDLE_SEC"), 300, 0, 86400),
    boxIdleTimeoutSec: intInRange(get("BOX_IDLE_TIMEOUT_SEC"), 0, 0, 31_536_000),
    boxIdleCpuPercent: intInRange(get("BOX_IDLE_CPU_PERCENT"), 5, 0, 100),
    lifecycleIntervalMs: intOr(get("LIFECYCLE_INTERVAL_MS"), 30_000),
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
