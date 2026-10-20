import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");
export const ENV_PATH = join(ROOT, ".env");

export interface Config {
  host: string;
  port: number;
  accessKey: string;
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

function readEnvFile(): Record<string, string> {
  return existsSync(ENV_PATH) ? parseDotenv(readFileSync(ENV_PATH, "utf8")) : {};
}

function intOr(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Load configuration. Precedence: process env > .env file > defaults.
 * When no ACCESS_KEY exists anywhere, a random one is generated and persisted to .env (mode 600).
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const file = readEnvFile();
  const get = (k: string) => env[k] ?? file[k];

  let accessKey = get("ACCESS_KEY")?.trim() ?? "";
  if (!accessKey) {
    accessKey = randomBytes(32).toString("hex");
    const lines = [`ACCESS_KEY=${accessKey}`, `PORT=${get("PORT") ?? 3920}`, `HOST=${get("HOST") ?? "127.0.0.1"}`];
    writeFileSync(ENV_PATH, `${lines.join("\n")}\n`, { mode: 0o600 });
  }

  const labelPrefix = get("LABEL_PREFIX")?.trim() || "minibox";
  const level = get("LOG_LEVEL");
  return {
    host: get("HOST")?.trim() || "127.0.0.1",
    port: intOr(get("PORT"), 3920),
    accessKey,
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
