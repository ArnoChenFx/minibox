import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";

import { createSecretFile, ensureDataDir, readSecretFile } from "../data-dir";
import type { HostCtx } from "../host/registry";
import { log } from "../lib/logger";
import {
  type CreateContainerSpec,
  HELPER_SECRETS_DIR,
  type HelperResult,
  type HelperSecret,
  isRuntimeError,
  type Mount,
  RuntimeError,
} from "../runtime";
import type { BackupResult, EngineUsage, OpenedPackage, PackageInput, SnapshotEngine, SnapshotRef } from "./engine";
import { MANIFEST_FILE, MANIFEST_TAG, PackageRejected, type PackageDigest, writePackageFile } from "./package";

/** Pinned engine image. Its flags below follow restic 0.18. */
export const RESTIC_IMAGE = "restic/restic:0.18.1";

const REPO_MOUNT = "/repo";
const DATA_MOUNT = "/data";
const TARGET_MOUNT = "/dst";
/** A package's repository is staged under this mount, in a volume of its own. */
const PACKAGE_MOUNT = "/pkg";
const PACKAGE_REPO = `${PACKAGE_MOUNT}/repo`;
/** The password file on the host, under `DATA_DIR/secrets`. */
const KEY_FILE = "checkpoint-repo.key";
/** The same password as a file inside the helper, under `HELPER_SECRETS_DIR`. */
const HELPER_KEY_NAME = "repo.key";
/** The passphrase of a package, as a file inside the helper. It is never written anywhere else. */
const PACKAGE_KEY_NAME = "package.key";
const SNAPSHOT_ID_RE = /^[0-9a-f]{64}$/;

const HELPER_MEMORY_BYTES = 1024 * 1024 * 1024;
const HELPER_PIDS_LIMIT = 256;
const HELPER_TMPFS_BYTES = 64 * 1024 * 1024;
const HELPER_TIMEOUT_SEC = 3600;
const STAGE_MEMORY_BYTES = 256 * 1024 * 1024;

/** restic exits 10 when the repository does not exist, and 12 when the password does not open it. */
const EXIT_NO_REPO = 10;
const EXIT_WRONG_PASSWORD = 12;

export interface ResticOptions {
  /** `DATA_DIR`. The repository key lives in `secrets/`. */
  dataDir: string;
  image?: string;
}

/** One restic or helper run: its arguments, and what the helper gets beside the defaults. */
interface HelperCall {
  args: string[];
  mounts?: Mount[];
  capAdd?: string[];
  secrets?: HelperSecret[];
  env?: string[];
}

/**
 * Snapshots with restic, run in a short-lived helper from `RESTIC_IMAGE`. Each host has one repository, in a volume
 * named `<prefix>-checkpoints-<host>`. The repository password is generated once into `DATA_DIR/secrets`. Each helper
 * gets it as a secret file, read through `RESTIC_PASSWORD_FILE`, so it never appears in the helper's environment.
 *
 * Operations on one host run one at a time, so the repository is never initialized twice and backups do not compete
 * for its lock. A repository the password cannot open is an error, never a reason to initialize a new one. A package is
 * a repository of its own, in a staging volume that exists only while the package is open or being written.
 */
export class ResticEngine implements SnapshotEngine {
  private readonly image: string;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly ready = new Set<string>();

  constructor(private readonly opts: ResticOptions) {
    this.image = opts.image ?? RESTIC_IMAGE;
  }

  backup(host: HostCtx, volume: string, tags: string[]): Promise<BackupResult> {
    return this.serial(host, async () => {
      await assertVolume(host, volume);
      await this.ensureRepo(host, { create: true });
      const tagFlags = tags.flatMap((tag) => ["--tag", tag]);
      const result = await this.run(host, {
        args: ["backup", DATA_MOUNT, "--json", "--host", host.host.id, ...tagFlags],
        mounts: [{ source: volume, target: DATA_MOUNT, mode: "ro" }],
        capAdd: ["DAC_READ_SEARCH"],
      });
      this.assertOk(host, result, "restic backup");
      const summary = summaryOf(result.logs);
      if (!summary) throw failure("restic backup printed no summary", result);
      return summary;
    });
  }

  restore(host: HostCtx, snapshotId: string, volume: string): Promise<void> {
    return this.serial(host, async () => {
      assertSnapshotId(snapshotId);
      await assertVolume(host, volume);
      await this.ensureRepo(host, { create: false });
      const result = await this.run(host, {
        args: ["restore", `${snapshotId}:${DATA_MOUNT}`, "--target", TARGET_MOUNT],
        mounts: [{ source: volume, target: TARGET_MOUNT, mode: "rw" }],
        capAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER"],
      });
      this.assertOk(host, result, "restic restore");
    });
  }

  forget(host: HostCtx, snapshotId: string): Promise<void> {
    return this.serial(host, async () => {
      assertSnapshotId(snapshotId);
      await this.ensureRepo(host, { create: false });
      const result = await this.run(host, { args: ["forget", snapshotId, "--prune"] });
      this.assertOk(host, result, "restic forget");
    });
  }

  /** Reads the raw data size from the index. A repository that was never created is empty, and nothing is created here. */
  usage(host: HostCtx): Promise<EngineUsage> {
    return this.serial(host, async () => {
      if (!(await repoVolumeExists(host))) return { bytes: 0 };
      try {
        await this.ensureRepo(host, { create: false });
      } catch (e) {
        if (isRuntimeError(e, "not_found")) return { bytes: 0 };
        throw e;
      }
      const result = await this.run(host, { args: ["stats", "--mode", "raw-data", "--json"] });
      this.assertOk(host, result, "restic stats");
      const bytes = storedBytesOf(result.logs);
      if (bytes === null) throw failure("restic stats printed no size", result);
      return { bytes };
    });
  }

  tagged(host: HostCtx, tag: string): Promise<SnapshotRef[]> {
    return this.serial(host, async () => {
      if (!(await repoVolumeExists(host))) return [];
      try {
        await this.ensureRepo(host, { create: false });
      } catch (e) {
        if (isRuntimeError(e, "not_found")) return [];
        throw e;
      }
      const result = await this.run(host, { args: ["snapshots", "--tag", tag, "--json"] });
      this.assertOk(host, result, "restic snapshots");
      const refs = snapshotsOf(result.logs);
      if (refs === null) throw failure("restic snapshots printed no list", result);
      return refs;
    });
  }

  pack(host: HostCtx, input: PackageInput, file: string, maxBytes: number): Promise<PackageDigest> {
    return this.serial(host, async () => {
      input.snapshotIds.forEach(assertSnapshotId);
      await this.ensureRepo(host, { create: false });
      const volume = await this.stage(host);
      try {
        const sealed: HelperSecret[] = [{ name: PACKAGE_KEY_NAME, value: input.passphrase }];
        const env = repoEnv(PACKAGE_KEY_NAME, PACKAGE_REPO);
        const packageMount = packageMountOf(volume, "rw");
        const init = await this.helper(host, { args: ["init"], mounts: [packageMount], secrets: sealed, env });
        if (init.exitCode !== 0) throw failure("restic init of the package", init);
        const copy = await this.helper(host, {
          args: [
            "copy",
            "--from-repo",
            REPO_MOUNT,
            "--from-password-file",
            `${HELPER_SECRETS_DIR}/${HELPER_KEY_NAME}`,
            ...input.snapshotIds,
          ],
          mounts: [{ source: repoVolume(host), target: REPO_MOUNT, mode: "rw" }, packageMount],
          secrets: [{ name: HELPER_KEY_NAME, value: this.password() }, ...sealed],
          env,
        });
        if (copy.exitCode !== 0) throw failure("restic copy into the package", copy);
        const manifest = await this.helper(host, {
          args: [
            "backup",
            `${HELPER_SECRETS_DIR}/${MANIFEST_FILE}`,
            "--tag",
            MANIFEST_TAG,
            "--host",
            host.host.id,
            "--json",
          ],
          mounts: [packageMount],
          secrets: [{ name: MANIFEST_FILE, value: input.manifest }, ...sealed],
          env,
        });
        if (manifest.exitCode !== 0) throw failure("restic backup of the manifest", manifest);
        return await this.writeArchive(host, volume, file, maxBytes);
      } finally {
        await this.unstage(host, volume);
      }
    });
  }

  async open(host: HostCtx, file: string, passphrase: string): Promise<OpenedPackage> {
    const volume = await this.stage(host);
    try {
      await this.loadArchive(host, volume, file);
      const sealed: HelperSecret[] = [{ name: PACKAGE_KEY_NAME, value: passphrase }];
      const env = repoEnv(PACKAGE_KEY_NAME, PACKAGE_REPO);
      const mounts = [packageMountOf(volume, "rw")];
      const probe = await this.helper(host, { args: ["cat", "config"], mounts, secrets: sealed, env });
      if (probe.exitCode === EXIT_WRONG_PASSWORD) {
        throw new PackageRejected("passphrase", "the passphrase does not open the package");
      }
      if (probe.exitCode !== 0) throw new PackageRejected("not_package", "restic cannot read the package repository");
      const listing = await this.helper(host, { args: ["snapshots", "--json"], mounts, secrets: sealed, env });
      const snapshots = listing.exitCode === 0 ? snapshotsOf(listing.logs) : null;
      if (snapshots === null) throw new PackageRejected("not_package", "the package lists no snapshots");
      return this.opened(host, volume, passphrase, snapshots);
    } catch (e) {
      await this.unstage(host, volume);
      throw e;
    }
  }

  private opened(host: HostCtx, volume: string, passphrase: string, snapshots: SnapshotRef[]): OpenedPackage {
    const sealed: HelperSecret[] = [{ name: PACKAGE_KEY_NAME, value: passphrase }];
    const env = repoEnv(PACKAGE_KEY_NAME, PACKAGE_REPO);
    const mounts = [packageMountOf(volume, "rw")];
    let closed = false;
    return {
      snapshots,
      readManifest: async (snapshotId) => {
        assertSnapshotId(snapshotId);
        const result = await this.helper(host, {
          args: ["dump", snapshotId, `${HELPER_SECRETS_DIR}/${MANIFEST_FILE}`],
          mounts,
          secrets: sealed,
          env,
        });
        if (result.exitCode !== 0) throw new PackageRejected("invalid", "the package's manifest cannot be read");
        const text = manifestTextOf(result.logs);
        if (text === null) throw new PackageRejected("invalid", "the package's manifest is missing");
        return text;
      },
      unpack: (snapshotIds) =>
        this.serial(host, async () => {
          snapshotIds.forEach(assertSnapshotId);
          await this.ensureRepo(host, { create: true });
          const result = await this.run(host, {
            args: [
              "copy",
              "--from-repo",
              PACKAGE_REPO,
              "--from-password-file",
              `${HELPER_SECRETS_DIR}/${PACKAGE_KEY_NAME}`,
              ...snapshotIds,
            ],
            mounts,
            secrets: sealed,
          });
          this.assertOk(host, result, "restic copy out of the package");
        }),
      close: async () => {
        if (closed) return;
        closed = true;
        await this.unstage(host, volume);
      },
    };
  }

  private serial<T>(host: HostCtx, fn: () => Promise<T>): Promise<T> {
    const key = host.host.id;
    const run = (this.queues.get(key) ?? Promise.resolve()).then(fn);
    this.queues.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /**
   * Opens the repository, initializing it only when `create` is set. Without `create`, a missing repository is an
   * error: a restore or a forget names a snapshot that the repository must already hold.
   */
  private async ensureRepo(host: HostCtx, { create }: { create: boolean }): Promise<void> {
    const key = host.host.id;
    if (this.ready.has(key)) return;
    await host.runtime.pullImage(this.image);
    if (create) {
      await host.runtime.createVolume(repoVolume(host), { [host.keys.internal]: "true", [host.keys.checkpoint]: key });
    } else {
      await host.runtime.inspectVolume(repoVolume(host));
    }
    const probe = await this.run(host, { args: ["cat", "config"] });
    if (probe.exitCode === 0) {
      this.ready.add(key);
      return;
    }
    if (probe.exitCode === EXIT_WRONG_PASSWORD) throw failure("the checkpoint repository password is wrong", probe);
    if (probe.exitCode !== EXIT_NO_REPO) throw failure("could not open the checkpoint repository", probe);
    if (!create) throw new RuntimeError("not_found", "the checkpoint repository does not exist");
    const init = await this.run(host, { args: ["init"] });
    if (init.exitCode !== 0) throw failure("restic init", init);
    this.ready.add(key);
  }

  /** A missing repository means its volume was removed behind the engine, so the next call checks it again. */
  private assertOk(host: HostCtx, result: HelperResult, what: string): void {
    if (result.exitCode === 0) return;
    if (result.exitCode === EXIT_NO_REPO) this.ready.delete(host.host.id);
    throw failure(what, result);
  }

  /** restic on this host's repository. The repository key and the repository mount are added to the call. */
  private run(host: HostCtx, call: Omit<HelperCall, "env">): Promise<HelperResult> {
    return this.helper(host, {
      ...call,
      mounts: [{ source: repoVolume(host), target: REPO_MOUNT, mode: "rw" }, ...(call.mounts ?? [])],
      secrets: [{ name: HELPER_KEY_NAME, value: this.password() }, ...(call.secrets ?? [])],
      env: repoEnv(HELPER_KEY_NAME, REPO_MOUNT),
    });
  }

  private helper(host: HostCtx, call: HelperCall): Promise<HelperResult> {
    return host.runtime.runHelper({
      image: this.image,
      cmd: ["--no-cache", ...call.args],
      user: "0:0",
      capAdd: call.capAdd,
      mounts: call.mounts ?? [],
      secrets: call.secrets ?? [],
      env: call.env ?? [],
      labels: { [host.keys.internal]: "true" },
      memoryBytes: HELPER_MEMORY_BYTES,
      pidsLimit: HELPER_PIDS_LIMIT,
      tmpfsBytes: HELPER_TMPFS_BYTES,
      timeoutSec: HELPER_TIMEOUT_SEC,
    });
  }

  /** A new, empty volume for one package. It holds the package's repository while the package is written or open. */
  private async stage(host: HostCtx): Promise<string> {
    await host.runtime.pullImage(this.image);
    const volume = `${host.prefix}-package-${randomBytes(6).toString("hex")}`;
    await host.runtime.createVolume(volume, { [host.keys.internal]: "true" });
    return volume;
  }

  private async unstage(host: HostCtx, volume: string): Promise<void> {
    try {
      await host.runtime.removeVolume(volume);
    } catch (e) {
      if (!isRuntimeError(e, "not_found")) log.warn("checkpoint.package_unstage_failed", { volume, error: String(e) });
    }
  }

  /** Copies a package file into an empty staging volume, which then holds the repository at `/pkg/repo`. */
  private async loadArchive(host: HostCtx, volume: string, file: string): Promise<void> {
    const created = await host.runtime.createContainer(stagingSpec(host, this.image, volume, "rw"));
    const source = createReadStream(file);
    try {
      await host.runtime.putArchive(created.id, PACKAGE_MOUNT, source);
    } finally {
      source.destroy();
      await host.runtime.removeContainer(created.id, { force: true }).catch(() => undefined);
    }
  }

  /** Streams the staged repository out as a package file, checked as it is written. */
  private async writeArchive(host: HostCtx, volume: string, file: string, maxBytes: number): Promise<PackageDigest> {
    const created = await host.runtime.createContainer(stagingSpec(host, this.image, volume, "ro"));
    try {
      const archive = await host.runtime.getArchive(created.id, PACKAGE_REPO);
      try {
        return await writePackageFile(archive, file, maxBytes);
      } finally {
        archive.destroy();
      }
    } finally {
      await host.runtime.removeContainer(created.id, { force: true }).catch(() => undefined);
    }
  }

  private password(): string {
    const path = join(this.opts.dataDir, "secrets", KEY_FILE);
    const existing = readSecretFile(path);
    if (existing) return existing;
    ensureDataDir(this.opts.dataDir);
    createSecretFile(path, randomBytes(32).toString("hex"));
    const created = readSecretFile(path);
    if (!created) throw new Error("could not create the checkpoint repository key");
    return created;
  }
}

function repoVolume(host: HostCtx): string {
  return `${host.prefix}-checkpoints-${host.host.id}`;
}

async function repoVolumeExists(host: HostCtx): Promise<boolean> {
  try {
    await host.runtime.inspectVolume(repoVolume(host));
    return true;
  } catch (e) {
    if (isRuntimeError(e, "not_found")) return false;
    throw e;
  }
}

async function assertVolume(host: HostCtx, volume: string): Promise<void> {
  await host.runtime.inspectVolume(volume);
}

function repoEnv(keyName: string, repository: string): string[] {
  return [`RESTIC_PASSWORD_FILE=${HELPER_SECRETS_DIR}/${keyName}`, `RESTIC_REPOSITORY=${repository}`, "HOME=/tmp"];
}

function packageMountOf(volume: string, mode: "rw" | "ro"): Mount {
  return { source: volume, target: PACKAGE_MOUNT, mode };
}

/**
 * A created container that mounts a staging volume, for the archive API. It is never started, so it has no command to
 * run, and it is hardened as the file service's archive containers are.
 */
function stagingSpec(host: HostCtx, image: string, volume: string, mode: "rw" | "ro"): CreateContainerSpec {
  return {
    image,
    name: `${volume}-archive`,
    cmd: ["true"],
    mounts: [{ source: volume, target: PACKAGE_MOUNT, mode, noCopy: true }],
    network: "none",
    labels: { [host.keys.internal]: "true" },
    memoryBytes: STAGE_MEMORY_BYTES,
    swapBytes: STAGE_MEMORY_BYTES,
    readonlyRootfs: true,
    tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16m" },
    hardening: { capDrop: ["ALL"], noNewPrivileges: true, pidsLimit: 64 },
  };
}

function assertSnapshotId(id: string): void {
  if (!SNAPSHOT_ID_RE.test(id)) throw new RuntimeError("invalid", `not a checkpoint snapshot id: ${id}`);
}

/** The `total_size` that `stats --json` printed. The output may be indented, so the object is cut from its braces. */
function storedBytesOf(logs: string): number | null {
  const start = logs.indexOf("{");
  const end = logs.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const value = JSON.parse(logs.slice(start, end + 1)) as { total_size?: unknown };
    return typeof value.total_size === "number" ? value.total_size : null;
  } catch {
    return null;
  }
}

/** The snapshots `snapshots --json` printed. An empty repository prints `null`, which reads as none. Null when the output is not a list. */
function snapshotsOf(logs: string): SnapshotRef[] | null {
  const start = logs.indexOf("[");
  const end = logs.lastIndexOf("]");
  if (start < 0 || end < start) return logs.trim() === "null" ? [] : null;
  let value: unknown;
  try {
    value = JSON.parse(logs.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const refs: SnapshotRef[] = [];
  for (const item of value) {
    const { id, tags } = (typeof item === "object" && item !== null ? item : {}) as { id?: unknown; tags?: unknown };
    if (typeof id !== "string" || !SNAPSHOT_ID_RE.test(id)) return null;
    const names = Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
    refs.push({ id, tags: names });
  }
  return refs;
}

/** The manifest `dump` printed: the text from its first brace to its last. Null when there are no braces. */
function manifestTextOf(logs: string): string | null {
  const start = logs.indexOf("{");
  const end = logs.lastIndexOf("}");
  return start < 0 || end < start ? null : logs.slice(start, end + 1);
}

/** The last `message_type: "summary"` line of `backup --json`. Progress lines come before it. */
function summaryOf(logs: string): BackupResult | null {
  const lines = logs.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (!line.startsWith("{")) continue;
    let value: { message_type?: unknown; snapshot_id?: unknown; total_bytes_processed?: unknown };
    try {
      value = JSON.parse(line) as typeof value;
    } catch {
      continue;
    }
    if (value.message_type !== "summary") continue;
    if (typeof value.snapshot_id !== "string" || !SNAPSHOT_ID_RE.test(value.snapshot_id)) return null;
    const bytes = typeof value.total_bytes_processed === "number" ? value.total_bytes_processed : 0;
    return { snapshotId: value.snapshot_id, bytes };
  }
  return null;
}

function failure(what: string, result: HelperResult): RuntimeError {
  const output = result.logs.trim().slice(-2000);
  const suffix = output ? `: ${output}` : "";
  return new RuntimeError("engine", `${what} exited with status ${result.exitCode}${suffix}`);
}
