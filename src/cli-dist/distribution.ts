import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { log } from "../lib/logger";
import { type CliBuilder, compileWithBun } from "./build";
import { FixedWindowLimiter, Gate } from "./limits";
import { CLI_TARGETS, type CliTarget } from "./targets";

const RUNTIMES_DIR = "runtimes";
const SHA256_HEX = /^[0-9a-f]{64}$/;
const WINDOW_MS = 60_000;

export interface CliArtifact {
  readonly target: CliTarget;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly version: string;
}

/** A target that cannot be built here. The route answers 503 with the reason and a fallback. */
export class CliUnavailableError extends Error {
  constructor(
    readonly target: CliTarget,
    reason: string,
  ) {
    super(reason);
    this.name = "CliUnavailableError";
  }
}

export interface CliDistributionOptions {
  /** DATA_DIR. The binaries go under `<dataDir>/cli`. */
  dataDir: string;
  version: string;
  /** The repository root, which holds `src/cli.ts`. */
  root: string;
  build?: CliBuilder;
  /** Bun processes that may run at once. A cross-target build may also download a runtime. */
  maxConcurrentBuilds?: number;
  /** Requests per minute from one client address, across all the /cli routes. */
  requestsPerMinute?: number;
}

/**
 * Serves the CLI binaries. Each one is compiled on first request, for the version of the running server, then kept in
 * `DATA_DIR/cli/<version>-<source hash>/` next to a `.sha256` sidecar. A new version removes the old directories, and
 * the Bun runtimes it downloaded stay in `DATA_DIR/cli/runtimes` so a later build can run without network access.
 * Runtimes of another Bun version, and partial builds left by a crash, are removed when the cache is first used.
 */
export class CliDistribution {
  private readonly cacheRoot: string;
  private readonly entry: string;
  private readonly build: CliBuilder;
  private readonly gate: Gate;
  private readonly limiter: FixedWindowLimiter;
  private readonly inFlight = new Map<string, Promise<CliArtifact>>();
  private directory: Promise<string> | null = null;

  constructor(private readonly options: CliDistributionOptions) {
    this.cacheRoot = join(options.dataDir, "cli");
    this.entry = join(options.root, "src", "cli.ts");
    this.build = options.build ?? compileWithBun;
    this.gate = new Gate(options.maxConcurrentBuilds ?? 2);
    this.limiter = new FixedWindowLimiter(options.requestsPerMinute ?? 120, WINDOW_MS);
  }

  /** Seconds until this client's next request is served, or 0 when it is served now. */
  admit(address: string): number {
    return this.limiter.take(address);
  }

  /**
   * The built binary for a target. Concurrent calls for one target share a single build, and a failed build is not
   * kept, so the next request tries again.
   */
  artifact(target: CliTarget): Promise<CliArtifact> {
    const pending = this.inFlight.get(target.fileName);
    if (pending) return pending;
    const started = this.produce(target).finally(() => this.inFlight.delete(target.fileName));
    this.inFlight.set(target.fileName, started);
    return started;
  }

  /** The sha256sum lines of the binaries built so far, in target order. Builds nothing. */
  async checksums(): Promise<string> {
    const dir = await this.cacheDir();
    const lines: string[] = [];
    for (const target of CLI_TARGETS) {
      const artifact = await existingArtifact(target, dir, this.options.version);
      if (artifact) lines.push(`${artifact.sha256}  ${target.fileName}\n`);
    }
    return lines.join("");
  }

  private async produce(target: CliTarget): Promise<CliArtifact> {
    try {
      const dir = await this.cacheDir();
      const cached = await existingArtifact(target, dir, this.options.version);
      if (cached) return cached;
      return await this.gate.run(async () => {
        const built = await existingArtifact(target, dir, this.options.version);
        return built ?? (await this.compile(target, dir));
      });
    } catch (e) {
      if (e instanceof CliUnavailableError) throw e;
      throw new CliUnavailableError(target, errorMessage(e));
    }
  }

  /** Builds into a file no request can name, and renames it into place only when Bun has finished. */
  private async compile(target: CliTarget, dir: string): Promise<CliArtifact> {
    const started = performance.now();
    const path = join(dir, target.fileName);
    const part = join(dir, `.${randomUUID()}.${target.fileName}`);
    try {
      await this.build({
        target,
        version: this.options.version,
        entry: this.entry,
        outFile: part,
        runtimeCache: join(this.cacheRoot, RUNTIMES_DIR),
        cwd: this.options.root,
      });
      await rm(`${path}.sha256`, { force: true });
      await rename(part, path);
    } catch (e) {
      await rm(part, { force: true });
      const reason = errorMessage(e);
      log.warn("cli.build_failed", { target: target.id, error: reason });
      throw new CliUnavailableError(target, reason);
    }
    const artifact = await recordArtifact(target, path, this.options.version);
    log.info("cli.built", {
      target: target.id,
      version: this.options.version,
      bytes: artifact.size,
      ms: Math.round(performance.now() - started),
    });
    return artifact;
  }

  private cacheDir(): Promise<string> {
    if (!this.directory) {
      this.directory = this.prepare().catch((e: unknown) => {
        this.directory = null;
        throw e;
      });
    }
    return this.directory;
  }

  private async prepare(): Promise<string> {
    const key = await cacheKey(this.options.version, this.options.root);
    const dir = join(this.cacheRoot, key);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await removeOtherVersions(this.cacheRoot, [key, RUNTIMES_DIR]);
    await removePartialBuilds(dir);
    await removeOtherRuntimes(join(this.cacheRoot, RUNTIMES_DIR), Bun.version);
    return dir;
  }
}

/** The binary already on disk, or null. A binary without its sidecar gets one, so checksums.txt can list it. */
async function existingArtifact(target: CliTarget, dir: string, version: string): Promise<CliArtifact | null> {
  const path = join(dir, target.fileName);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const recorded = await readFile(`${path}.sha256`, "utf8").then(
    (text) => text.trim().split(/\s+/)[0] ?? "",
    () => "",
  );
  if (SHA256_HEX.test(recorded)) return { target, path, size: file.size, sha256: recorded, version };
  return recordArtifact(target, path, version);
}

async function recordArtifact(target: CliTarget, path: string, version: string): Promise<CliArtifact> {
  const sha256 = await hashFile(path);
  await writeFile(`${path}.sha256`, `${sha256}  ${target.fileName}\n`);
  return { target, path, size: Bun.file(path).size, sha256, version };
}

async function hashFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

/** Names the cache directory after the version and the CLI sources, so an edit that keeps the version still rebuilds. */
async function cacheKey(version: string, root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await cliSources(root)) {
    hash.update(relative(root, file));
    hash.update(await readFile(file));
  }
  const source = hash.digest("hex").slice(0, 16);
  return `${version.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64)}-${source}`;
}

/** The entry and every module under `src/cli/`, in a fixed order. The binary is built from all of them. */
async function cliSources(root: string): Promise<string[]> {
  const dir = join(root, "src", "cli");
  const modules = await readdir(dir, { recursive: true }).catch((e: unknown) => {
    if (isEnoent(e)) return [];
    throw e;
  });
  const files = modules.filter((name) => name.endsWith(".ts")).map((name) => join(dir, name));
  return [join(root, "src", "cli.ts"), ...files.toSorted()];
}

function isEnoent(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";
}

async function removeOtherVersions(root: string, keep: string[]): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !keep.includes(entry.name))
      .map((entry) => rm(join(root, entry.name), { recursive: true, force: true })),
  );
}

/** A build cut short by a crash or restart leaves its `.<uuid>.<file>` behind. No build runs before this. */
async function removePartialBuilds(dir: string): Promise<void> {
  const entries = await readdir(dir);
  await Promise.all(entries.filter((name) => name.startsWith(".")).map((name) => rm(join(dir, name), { force: true })));
}

/**
 * Bun names each downloaded runtime after its version, such as `bun-linux-aarch64-v1.4.2`. Only the running Bun's
 * runtimes can be used, so the ones an older Bun downloaded are removed and the folder does not grow with upgrades.
 */
async function removeOtherRuntimes(dir: string, bunVersion: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const stale = entries.filter((name) => /^bun-.+-v\d/.test(name) && !name.endsWith(`-v${bunVersion}`));
  await Promise.all(stale.map((name) => rm(join(dir, name), { recursive: true, force: true })));
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
