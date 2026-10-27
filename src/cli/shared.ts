export const DEFAULT_URL = "http://127.0.0.1:3920";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Raw bytes to stdout. `ssh-proxy` writes SSH, which is binary. */
  stdoutBytes(bytes: Uint8Array): void;
  /** Raw bytes from stdin. `ssh-proxy` reads the SSH client's stream from it. */
  stdinBytes(): AsyncIterable<Uint8Array>;
}

export function flagValue(argv: string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

export function serverOf(env: Record<string, string | undefined>): { base: string; headers: Record<string, string> } {
  const base = (env.MINIBOX_URL ?? DEFAULT_URL).replace(/\/$/, "");
  const key = env.MINIBOX_ACCESS_KEY ?? env.ACCESS_KEY;
  if (!key) throw new Error("Set MINIBOX_ACCESS_KEY or ACCESS_KEY.");
  return { base, headers: { authorization: `Bearer ${key}`, accept: "application/json" } };
}

export async function request(
  env: Record<string, string | undefined>,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: unknown; text: string; headers: Headers }> {
  const { base, headers: serverHeaders } = serverOf(env);
  const headers: Record<string, string> = { ...serverHeaders, ...extraHeaders };
  let payload: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, text, headers: res.headers };
}

export function fail(io: CliIo, status: number, json: unknown, text: string): number {
  const error = (json as { error?: { message?: string; hint?: string } } | null)?.error;
  const message = error?.message ?? (text || `HTTP ${status}`);
  io.stderr(`${message}\n`);
  if (error?.hint) io.stderr(`${error.hint}\n`);
  return 1;
}

export function printJson(io: CliIo, json: unknown): number {
  io.stdout(`${JSON.stringify(json)}\n`);
  return 0;
}

export async function readStdinText(io: CliIo): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of io.stdinBytes()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export interface Options {
  positional: string[];
  values: Map<string, string>;
  switches: Set<string>;
}

export const OUTPUT_SWITCHES = ["--json", "--no-wait"];

export function parseOptions(argv: string[], valueFlags: readonly string[], switchFlags: readonly string[]): Options {
  const options: Options = { positional: [], values: new Map(), switches: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (switchFlags.includes(token)) options.switches.add(token);
    else if (valueFlags.includes(token)) {
      options.values.set(token, flagValue(argv, i, token));
      i += 1;
    } else if (token.startsWith("--")) throw new Error(`Unknown option ${token}`);
    else options.positional.push(token);
  }
  return options;
}

/**
 * `key` or `key=value` entries as a label object. An entry with no `=`, such as `gpu`, carries an empty value, which is how
 * a label with no value is written. A repeated key keeps the last value, as a repeated flag does everywhere else.
 */
export function labelEntries(entries: readonly string[], flag: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry === "") throw new Error(`${flag} needs a key, or key=value`);
    const eq = entry.indexOf("=");
    labels[(eq === -1 ? entry : entry.slice(0, eq)).trim()] = eq === -1 ? "" : entry.slice(eq + 1).trim();
  }
  return labels;
}

/** Every value a repeatable flag names, in the order given. `parseOptions` keeps only the last one. */
export function repeatedValues(argv: string[], flag: string): string[] {
  return argv.flatMap((token, index) => (token === flag ? [argv[index + 1] ?? ""] : []));
}

export function numberOption(options: Options, flag: string): number | undefined {
  const raw = options.values.get(flag);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) throw new Error(`${flag} needs a number`);
  return n;
}
