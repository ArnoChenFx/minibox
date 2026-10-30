import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { BOX_PROFILES, type BoxProfile, DEFAULT_BOX_PROFILE, DEFAULT_PIDS_LIMIT, isBoxProfile } from "./box-profile";
import {
  accessKeyPath,
  backupDirRefusal,
  createSecretFile,
  ensureDataDir,
  readSecretFile,
  resolveBackupDir,
  resolveDataDir,
} from "./data-dir";
import { hostLabelsProblem } from "./host/store";
import { log } from "./lib/logger";
import { parsePreviewBaseDomain } from "./preview/domain";

export const ROOT = join(import.meta.dir, "..");
const ENV_PATH = join(ROOT, ".env");

type AccessKeySource = "env" | "env-file" | "data-dir" | "generated";

export interface Config {
  host: string;
  port: number;
  accessKey: string;
  accessKeySource: AccessKeySource;
  dataDir: string;
  /** Where local backup archives are kept. `DATA_DIR/backups` unless `BACKUP_DIR` sets another folder. */
  backupDir: string;
  /** How many backups `BACKUP_KEEP` retains, newest first. 0 keeps every backup, which is the default. */
  backupKeep: number;
  /**
   * The passphrase a scheduled backup is sealed with, from `BACKUP_PASSPHRASE`. Null when it is unset, which leaves a due
   * run failed with a message saying so, since a schedule has nobody to ask.
   */
  backupPassphrase: string | null;
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
  /** Whether the owner access key may call `/mcp`. An agent token always may, within its scopes. */
  mcpAllowOwnerKey: boolean;
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
  /** Automatic checkpoints kept per box, newest first. Manual and pinned checkpoints are never removed by this. */
  checkpointKeepLast: number;
  /** Automatic checkpoints older than this many days are removed. 0 keeps them whatever their age. */
  checkpointKeepDays: number;
  /** Checkpoint repository size in MB at which new automatic checkpoints are refused. 0 sets no limit. */
  checkpointCapacityMb: number;
  /** Days a deleted box or volume stays in the recycle bin before retention purges it. */
  trashRetentionDays: number;
  /** Largest checkpoint package in MB that an export writes or an upload accepts. It also caps the HTTP request body. */
  checkpointPackageMaxMb: number;
  /** Largest single file in MB that the file browser or the file API uploads. It caps the request body of that upload. */
  fileUploadMaxMb: number;
  /**
   * How far the CPU and memory that running boxes book on a host may exceed the host's capacity, as a ratio. 1 books no
   * more than the host has. Checked only on a control plane with more than one host.
   */
  hostOvercommit: number;
  /**
   * Labels of the local host, from `HOST_LABELS`, such as `{ gpu: "", arch: "amd64" }`. They are read once at startup and
   * written into `hosts.json` under the id `local`, which is where a change through the API is kept too.
   */
  localHostLabels: Record<string, string>;
  /**
   * Base domain of subdomain previews, such as `minibox-preview.net`. Each preview then runs on `<port>-<box>.<base>`, with
   * its own origin. Null keeps the path-mode previews under `/box/`.
   */
  previewBaseDomain: string | null;
  /** Lets a notification channel send to an address that is not public, such as a self-hosted ntfy or a LAN webhook. */
  notifyAllowPrivate: boolean;
  /** How often every volume's usage is sampled, in seconds. */
  volumeUsageIntervalSec: number;
  /**
   * How often MiniBox checks that a `proxy-only` box's traffic is still forwarded by the host, in seconds. A pass runs a
   * short-lived privileged helper, so it is not free: the default is ten minutes, and the first pass runs soon after
   * start. A host with no `proxy-only` box is not read at all.
   */
  egressForwardCheckIntervalSec: number;
  /**
   * Keeps boxes on the default network from reaching services on the host through the bridge gateway. Boxes with egress
   * `none` or `proxy-only` are always kept off the host, whatever this is set to.
   */
  blockHostGateway: boolean;
  /**
   * Free space, as a percentage of the disk, below which a host alerts and refuses new volumes and checkpoints. 0 turns
   * the check off.
   */
  hostDiskMinFreePercent: number;
  /** TCP port of the direct SSH listener, or null when it is off. Standard SSH clients connect to it without the CLI. */
  sshPort: number | null;
  /** Address the direct SSH listener binds to. Defaults to HOST. */
  sshBind: string;
  /** Host name the console shows for direct SSH, when clients reach the port under another name. Null uses the page's host. */
  sshPublicHost: string | null;
  /** Port the console shows for direct SSH, when a port mapping or forward changes it. Null shows SSH_PORT. */
  sshPublicPort: number | null;
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

const MAX_HOST_OVERCOMMIT = 10;

/** The most backups `BACKUP_KEEP` may keep. A larger number still means a positive whole number, so it keeps them all. */
const MAX_BACKUP_KEEP = 10_000;

/**
 * How many local backups to keep, newest first. Blank or `0` keeps every backup, and so does an invalid value: unlike a
 * box setting, a typo here would delete archives, so it falls back to keeping them rather than to a guessed limit.
 */
function parseBackupKeep(value: string | undefined): number {
  return intInRange(value, 0, 0, MAX_BACKUP_KEEP);
}

/**
 * The passphrase a scheduled backup is sealed with. The same rules as a passphrase on the command line: 12 to 1024
 * characters, with no leading or trailing spaces and no line breaks. Blank means no schedule can run, and an invalid
 * value stops startup: unlike `BACKUP_KEEP`, a typo here cannot delete anything, but it would leave every run failed.
 */
function parseBackupPassphrase(value: string | undefined): string | null {
  // Blank is off. Anything else is used exactly as given: trimming it would seal a scheduled backup with a passphrase
  // that is not the one the operator types, so an untrimmed value is refused instead.
  if ((value ?? "").trim() === "") return null;
  const passphrase = value ?? "";
  const length = [...passphrase].length;
  if (length < 12 || length > 1024 || passphrase !== passphrase.trim() || /[\r\n\0]/.test(passphrase)) {
    throw new Error(
      "BACKUP_PASSPHRASE: the passphrase must be 12 to 1024 characters, with no leading or trailing spaces and no line breaks",
    );
  }
  return passphrase;
}

function parseHostOvercommit(value: string | undefined): number {
  const v = nonBlank(value);
  if (v === undefined) return 1;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > MAX_HOST_OVERCOMMIT) {
    throw new Error(`HOST_OVERCOMMIT: "${v}" must be a number from 1 to ${MAX_HOST_OVERCOMMIT}`);
  }
  return n;
}

const RUNTIME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Labels of the local host, as `key` or `key=value` entries separated by commas. A key with no `=` carries an empty value.
 * A label key or value that does not follow the rules stops startup, so a typo cannot silently select no host.
 */
function parseHostLabels(value: string | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const raw of (value ?? "").split(",")) {
    const entry = raw.trim();
    if (entry === "") continue;
    const eq = entry.indexOf("=");
    const key = (eq === -1 ? entry : entry.slice(0, eq)).trim();
    const label = eq === -1 ? "" : entry.slice(eq + 1).trim();
    const problem = hostLabelsProblem({ [key]: label });
    if (problem !== null) throw new Error(`HOST_LABELS: “${entry}” is not a label: ${problem}`);
    labels[key] = label;
  }
  return labels;
}

function parseContainerRuntime(value: string | undefined): string | null {
  const v = nonBlank(value);
  if (v === undefined) return null;
  if (!RUNTIME_NAME_RE.test(v)) throw new Error(`RUNTIME: "${v}" is not a valid runtime name (for example runsc)`);
  return v;
}

/**
 * Whether the owner access key may call `/mcp`. It may not by default, so an agent that holds the key cannot act as the
 * owner over MCP. `MCP_ALLOW_OWNER_KEY=true` restores the earlier behavior. Changing this constant changes the default.
 */
export const DEFAULT_MCP_ALLOW_OWNER_KEY: boolean = false;

/** A security switch, so anything other than a clear true or false stops startup rather than picking a side. */
function parseMcpAllowOwnerKey(value: string | undefined): boolean {
  const v = nonBlank(value)?.toLowerCase();
  if (v === undefined) return DEFAULT_MCP_ALLOW_OWNER_KEY;
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  throw new Error(`MCP_ALLOW_OWNER_KEY: "${value?.trim()}" must be true or false`);
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

  // Bun expands dotenv values before populating process.env. Never silently seal with a different secret.
  if (
    file.BACKUP_PASSPHRASE !== undefined &&
    env.BACKUP_PASSPHRASE !== undefined &&
    file.BACKUP_PASSPHRASE !== env.BACKUP_PASSPHRASE
  ) {
    throw new Error(
      'BACKUP_PASSPHRASE differs between the environment and .env: Bun expands "$" in .env values, even inside quotes, and cuts an unquoted value at "#", so the environment holds something the file does not say. Set it only in the process environment, or use a passphrase without "$" in .env. Escaping the "$" does not help, because the two readings still differ.',
    );
  }
  const dataDir = resolveDataDir(nonBlank(env.DATA_DIR) ?? nonBlank(file.DATA_DIR), ROOT);
  const backupDir = resolveBackupDir(nonBlank(env.BACKUP_DIR) ?? nonBlank(file.BACKUP_DIR), dataDir, ROOT);
  const refused = backupDirRefusal(backupDir, dataDir);
  if (refused !== null) {
    throw new Error(
      `BACKUP_DIR: ${backupDir} cannot hold the backups because ${refused}: a backup leaves out the folder it is written to, so every entry would be skipped and each archive would come out empty`,
    );
  }
  tryEnsureDataDir(dataDir);
  const { accessKey, accessKeySource } = resolveAccessKey(env, file, dataDir);

  const labelPrefix = get("LABEL_PREFIX")?.trim() || "minibox";
  const level = get("LOG_LEVEL");
  const host = get("HOST")?.trim() || "127.0.0.1";
  const port = intOr(get("PORT"), 3920);
  const sshPort = parsePort(get("SSH_PORT"), "SSH_PORT");
  if (sshPort !== null && sshPort === port) throw new Error(`SSH_PORT: ${sshPort} is already the web PORT`);
  return {
    host,
    port,
    accessKey,
    accessKeySource,
    dataDir,
    backupDir,
    backupKeep: parseBackupKeep(get("BACKUP_KEEP")),
    backupPassphrase: parseBackupPassphrase(get("BACKUP_PASSPHRASE")),
    labelPrefix,
    dockerSocket: get("DOCKER_SOCKET")?.trim() || "/var/run/docker.sock",
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
    mcpAllowOwnerKey: parseMcpAllowOwnerKey(get("MCP_ALLOW_OWNER_KEY")),
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
    checkpointKeepLast: intInRange(get("CHECKPOINT_KEEP_LAST"), 20, 1, 10_000),
    checkpointKeepDays: intInRange(get("CHECKPOINT_KEEP_DAYS"), 30, 0, 3650),
    checkpointCapacityMb: intInRange(get("CHECKPOINT_CAPACITY_MB"), 0, 0, 1_000_000_000),
    trashRetentionDays: intInRange(get("TRASH_RETENTION_DAYS"), 7, 1, 365),
    checkpointPackageMaxMb: intInRange(get("CHECKPOINT_PACKAGE_MAX_MB"), 2048, 1, 65536),
    fileUploadMaxMb: intInRange(get("FILE_UPLOAD_MAX_MB"), 1024, 1, 65536),
    hostOvercommit: parseHostOvercommit(get("HOST_OVERCOMMIT")),
    localHostLabels: parseHostLabels(get("HOST_LABELS")),
    previewBaseDomain: parsePreviewBaseDomain(get("PREVIEW_BASE_DOMAIN")),
    notifyAllowPrivate: isTruthy(get("NOTIFY_ALLOW_PRIVATE")),
    volumeUsageIntervalSec: intInRange(get("VOLUME_USAGE_INTERVAL_SEC"), 600, 60, 86400),
    egressForwardCheckIntervalSec: intInRange(get("EGRESS_FORWARD_CHECK_INTERVAL_SEC"), 600, 60, 86400),
    hostDiskMinFreePercent: intInRange(get("HOST_DISK_MIN_FREE_PERCENT"), 10, 0, 100),
    blockHostGateway: isTruthy(get("BLOCK_HOST_GATEWAY")),
    sshPort,
    sshBind: nonBlank(get("SSH_BIND")) ?? host,
    sshPublicHost: parsePublicHost(get("SSH_PUBLIC_HOST")),
    sshPublicPort: parsePort(get("SSH_PUBLIC_PORT"), "SSH_PUBLIC_PORT"),
  };
}

/** A TCP port from 1 to 65535. Blank means unset; anything else stops startup, so a typo does not open a random port. */
function parsePort(value: string | undefined, name: string): number | null {
  const v = nonBlank(value);
  if (v === undefined) return null;
  const n = Number(v);
  if (!/^\d+$/.test(v) || n < 1 || n > 65535) throw new Error(`${name}: "${v}" must be a port from 1 to 65535`);
  return n;
}

const PUBLIC_HOST_RE = /^[A-Za-z0-9.:[\]-]{1,253}$/;

function parsePublicHost(value: string | undefined): string | null {
  const v = nonBlank(value);
  if (v === undefined) return null;
  if (!PUBLIC_HOST_RE.test(v)) throw new Error(`SSH_PUBLIC_HOST: "${v}" must be a host name or an IP address`);
  return v;
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
