import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

import { createSecretFile, ensureDataDir, readSecretFile } from "../data-dir";
import type { HostCtx } from "../host/registry";
import { log } from "../lib/logger";
import { type ByteProgress, countingChunks } from "../lib/transfer";
import {
  type CreateContainerSpec,
  HELPER_SECRETS_DIR,
  type HelperResult,
  type HelperSecret,
  isRuntimeError,
  type Mount,
  RuntimeError,
} from "../runtime";
import {
  type BackupResult,
  type EngineUsage,
  type OpenedPackage,
  type PackageInput,
  type SnapshotEngine,
  SnapshotHeld,
  type SnapshotRef,
} from "./engine";
import { MANIFEST_FILE, MANIFEST_TAG, PackageRejected, type PackageDigest, writePackageFile } from "./package";
import type { RemoteRepository, S3RemoteCredentials } from "./remote";

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
/** The remote repository's password, and the files its target's credentials are read from. */
const REMOTE_KEY_NAME = "remote.key";
const AWS_KEY_NAME = "aws-credentials";
const SFTP_KEY_NAME = "sftp.key";
const KNOWN_HOSTS_NAME = "known_hosts";
/**
 * How long restic waits for a repository lock before giving up. The engine's queue already serializes this process's
 * calls, so a lock can only belong to a helper left behind by a killed run (which never releases it) or to another
 * client of the remote repository. Five minutes lets a helper that is finishing clear its lock without holding a
 * scheduled pass for long; past that the copy fails, is recorded, and is retried later. An unconditional `unlock` is
 * never run, since a live holder would then be overridden.
 */
const REMOTE_LOCK_WAIT = "5m";
/**
 * How long a remote-only host's usage reading is kept. `stats` reads the repository's whole index, which over a network is
 * the most expensive call this engine makes; a reading that old is still useful for capacity decisions, and writing a
 * checkpoint or deleting one clears it at once.
 */
const USAGE_TTL_MS = 10 * 60 * 1000;
const SNAPSHOT_ID_RE = /^[0-9a-f]{64}$/;

const HELPER_MEMORY_BYTES = 1024 * 1024 * 1024;
const HELPER_PIDS_LIMIT = 256;
const HELPER_TMPFS_BYTES = 64 * 1024 * 1024;
const HELPER_TIMEOUT_SEC = 3600;
/**
 * How long the check that opens a remote before it becomes a host's only repository may run. It holds that host's
 * relocation gate, and every checkpoint write on the host waits behind it, so it is bounded much shorter than a backup.
 * A target that cannot answer in this time is refused and the operator can try again.
 */
const REMOTE_CHECK_TIMEOUT_SEC = 120;
const STAGE_MEMORY_BYTES = 256 * 1024 * 1024;

/** restic exits 10 when the repository does not exist, and 12 when the password does not open it. */
const EXIT_NO_REPO = 10;
const EXIT_WRONG_PASSWORD = 12;

export interface ResticOptions {
  /** `DATA_DIR`. The repository key lives in `secrets/`. */
  dataDir: string;
  image?: string;
  /** The clock the usage cache reads, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** A repository a host's helpers read and write: its restic options, the files those options name, and its environment. */
interface PrimaryRepository {
  /** Names the repository itself, apart from the host's name, so a mode or position change is probed again. */
  key: string;
  /** Null when the repository is the local volume. */
  remote: RemoteRepository | null;
  /** Restic options that precede the command, such as the S3 region or the SFTP ssh arguments. */
  options: string[];
  mounts: Mount[];
  secrets: HelperSecret[];
  env: string[];
  /** The environment that names a target's credential files alone, without the repository a helper writes. */
  credentialEnv: string[];
  network: boolean;
}

/** One restic or helper run: its arguments, and what the helper gets beside the defaults. */
interface HelperCall {
  args: string[];
  mounts?: Mount[];
  capAdd?: string[];
  secrets?: HelperSecret[];
  env?: string[];
  /** Joins the bridge, so a helper that copies to a remote repository can reach it. */
  network?: boolean;
  /** Appends the bounded lock wait to a restic call that writes the repository. Remote-only repositories set it. */
  write?: boolean;
  /** Overrides the helper's lifetime, for the remote check that must not hold a relocation gate for an hour. */
  timeoutSec?: number;
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
  /** The repository identities whose `cat config` has answered since the engine started. */
  private readonly ready = new Set<string>();
  /** Remote-only usage readings, by repository identity. Cleared when the repository changes. */
  private readonly usageCache = new Map<string, { bytes: number; at: number }>();
  private readonly now: () => number;
  /** Answers the remote repository of a host that keeps its checkpoints only there, bound after the target service is built. */
  private remotes: ((hostId: string) => Promise<RemoteRepository | null>) | undefined;

  constructor(private readonly opts: ResticOptions) {
    this.image = opts.image ?? RESTIC_IMAGE;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Binds the remote-only repositories after the target service exists. The resolver returns a repository only for a host
   * in `only` mode; every other host keeps using its local volume.
   */
  bindRemotes(resolve: (hostId: string) => Promise<RemoteRepository | null>): void {
    this.remotes = resolve;
  }

  backup(host: HostCtx, volume: string, tags: string[]): Promise<BackupResult> {
    return this.serial(host, async () => {
      await assertVolume(host, volume);
      await this.ensureRepo(host, { create: true });
      const tagFlags = tags.flatMap((tag) => ["--tag", tag]);
      try {
        const result = await this.run(host, {
          args: ["backup", DATA_MOUNT, "--json", "--host", host.host.id, ...tagFlags],
          mounts: [{ source: volume, target: DATA_MOUNT, mode: "ro" }],
          capAdd: ["DAC_READ_SEARCH"],
          write: true,
        });
        this.assertOk(host, result, "restic backup");
        const summary = summaryOf(result.logs);
        if (!summary) throw failure("restic backup printed no summary", result);
        return summary;
      } finally {
        // A failed backup may already have written a pack, so the cached reading is dropped either way.
        this.invalidateUsage(host);
      }
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
      try {
        const result = await this.run(host, { args: ["forget", snapshotId, "--prune"], write: true });
        this.assertOk(host, result, "restic forget");
      } finally {
        // A prune that failed part way may still have freed packs, so the cached reading is dropped either way.
        this.invalidateUsage(host);
      }
    });
  }

  /** Reads the raw data size from the index. A repository that was never created is empty, and nothing is created here. */
  usage(host: HostCtx): Promise<EngineUsage> {
    return this.serial(host, async () => {
      const repo = await this.primary(host);
      if (repo.remote) {
        const cached = this.usageCache.get(repo.key);
        if (cached && this.now() - cached.at < USAGE_TTL_MS) return { bytes: cached.bytes };
      } else if (!(await repoVolumeExists(host))) {
        return { bytes: 0 };
      }
      try {
        await this.ensureRepo(host, { create: false });
      } catch (e) {
        if (isRuntimeError(e, "not_found")) return { bytes: 0 };
        throw e;
      }
      const result = await this.run(host, { args: ["stats", "--mode", "raw-data", "--json"] });
      // A repository removed behind the engine is empty, not an error: the next backup creates it again.
      if (result.exitCode === EXIT_NO_REPO) {
        this.forgetReady(host);
        return { bytes: 0 };
      }
      this.assertOk(host, result, "restic stats");
      const bytes = storedBytesOf(result.logs);
      if (bytes === null) throw failure("restic stats printed no size", result);
      if (repo.remote) this.usageCache.set(repo.key, { bytes, at: this.now() });
      return { bytes };
    });
  }

  tagged(host: HostCtx, tag: string): Promise<SnapshotRef[]> {
    return this.serial(host, async () => {
      if (!(await this.primary(host)).remote && !(await repoVolumeExists(host))) return [];
      try {
        await this.ensureRepo(host, { create: false });
      } catch (e) {
        if (isRuntimeError(e, "not_found")) return [];
        throw e;
      }
      return this.listing(host, ["--tag", tag]);
    });
  }

  /**
   * Copies snapshots into the remote repository, creating it on the first copy. Only `copy` runs against the remote: no
   * forget, prune or unlock is ever sent there, so a local deletion does not reach it. The helper joins the bridge,
   * because the remote is elsewhere; its credentials still arrive as secret files, not environment variables, which
   * `docker inspect` would show.
   */
  copyToRemote(host: HostCtx, remote: RemoteRepository, snapshotIds: string[]): Promise<void> {
    return this.serial(host, async () => {
      snapshotIds.forEach(assertSnapshotId);
      // A remote-only host has no local repository to copy from; its snapshots are already on the remote.
      if ((await this.primary(host)).remote) {
        throw new RuntimeError("engine", "a host that keeps its checkpoints only on the remote has nothing to copy");
      }
      if (snapshotIds.length === 0) return;
      await this.ensureRepo(host, { create: false });
      const call = remoteHelperCall(remote, []);
      const common = {
        mounts: [{ source: repoVolume(host), target: REPO_MOUNT, mode: "rw" as const }],
        secrets: [{ name: HELPER_KEY_NAME, value: this.password() }, ...call.secrets],
        env: call.env,
        network: true,
      };
      const probe = await this.helper(host, { ...common, args: [...call.args, "cat", "config"] });
      if (probe.exitCode === EXIT_WRONG_PASSWORD) {
        throw failure("the remote checkpoint repository password is wrong", probe);
      }
      if (probe.exitCode === EXIT_NO_REPO) {
        const init = await this.helper(host, {
          ...common,
          args: [...call.args, "--retry-lock", REMOTE_LOCK_WAIT, "init"],
        });
        if (init.exitCode !== 0) throw failure("restic init of the remote checkpoint repository", init);
      } else if (probe.exitCode !== 0) {
        throw failure("could not open the remote checkpoint repository", probe);
      }
      const copy = await this.helper(host, {
        ...common,
        args: [
          ...call.args,
          "--retry-lock",
          REMOTE_LOCK_WAIT,
          "copy",
          "--from-repo",
          REPO_MOUNT,
          "--from-password-file",
          `${HELPER_SECRETS_DIR}/${HELPER_KEY_NAME}`,
          ...snapshotIds,
        ],
      });
      if (copy.exitCode !== 0) throw failure("restic copy to the remote checkpoint repository", copy);
    });
  }

  /**
   * Opens a remote repository that is about to become a host's only one, creating it when it does not exist yet. Its
   * password is the one the target service generated, so a wrong password refuses the setting rather than replacing a
   * repository. The helper joins the bridge and gets the credentials as files, exactly as a remote-only backup does.
   */
  checkRemote(host: HostCtx, remote: RemoteRepository): Promise<void> {
    return this.serial(host, async () => {
      await host.runtime.pullImage(this.image);
      const call = remoteHelperCall(remote, []);
      const common = {
        secrets: call.secrets,
        env: call.env,
        network: true,
        timeoutSec: REMOTE_CHECK_TIMEOUT_SEC,
      };
      const probe = await this.helper(host, { ...common, args: [...call.args, "cat", "config"] });
      if (probe.exitCode === EXIT_WRONG_PASSWORD) {
        throw failure("the remote checkpoint repository password is wrong", probe);
      }
      if (probe.exitCode === EXIT_NO_REPO) {
        const init = await this.helper(host, {
          ...common,
          args: [...call.args, "--retry-lock", REMOTE_LOCK_WAIT, "init"],
        });
        if (init.exitCode !== 0) throw failure("restic init of the remote checkpoint repository", init);
        return;
      }
      if (probe.exitCode !== 0) throw failure("could not open the remote checkpoint repository", probe);
    });
  }

  /** The snapshots of this repository that match the `snapshots` filter flags. The caller holds the host's queue. */
  private async listing(host: HostCtx, filter: string[]): Promise<SnapshotRef[]> {
    const result = await this.run(host, { args: ["snapshots", ...filter, "--json"] });
    this.assertOk(host, result, "restic snapshots");
    const refs = snapshotsOf(result.logs);
    if (refs === null) throw failure("restic snapshots printed no list", result);
    return refs;
  }

  /**
   * Forgets what a failed copy left: the snapshots that appeared during it, under one of its roots. It runs inside the
   * host's queue, so it calls restic directly, since `forget` would wait for the queue it already holds.
   */
  private async forgetCopies(host: HostCtx, known: Set<string>, roots: Set<string>): Promise<void> {
    let leftovers: SnapshotRef[];
    try {
      leftovers = (await this.listing(host, [])).filter(
        (snapshot) => !known.has(snapshot.id) && snapshot.original !== null && roots.has(snapshot.original),
      );
    } catch (e) {
      log.warn("checkpoint.copy_cleanup_failed", { host: host.host.id, error: String(e) });
      return;
    }
    for (const snapshot of leftovers) {
      try {
        const result = await this.run(host, { args: ["forget", snapshot.id, "--prune"], write: true });
        if (result.exitCode !== 0) {
          log.warn("checkpoint.copy_cleanup_failed", { host: host.host.id, snapshot: snapshot.id });
        }
      } catch (e) {
        log.warn("checkpoint.copy_cleanup_failed", { host: host.host.id, snapshot: snapshot.id, error: String(e) });
      }
    }
  }

  pack(
    host: HostCtx,
    input: PackageInput,
    file: string,
    maxBytes: number,
    onBytes?: ByteProgress,
  ): Promise<PackageDigest> {
    return this.serial(host, async () => {
      input.snapshotIds.forEach(assertSnapshotId);
      await this.ensureRepo(host, { create: false });
      const repo = await this.primary(host);
      const volume = await this.stage(host);
      try {
        const sealed: HelperSecret[] = [{ name: PACKAGE_KEY_NAME, value: input.passphrase }];
        const env = repoEnv(PACKAGE_KEY_NAME, PACKAGE_REPO);
        const packageMount = packageMountOf(volume, "rw");
        const init = await this.helper(host, { args: ["init"], mounts: [packageMount], secrets: sealed, env });
        if (init.exitCode !== 0) throw failure("restic init of the package", init);
        // The package is the destination, so the repository being written stays the package's. The source repository
        // arrives as restic options and a password file, together with the credential file a remote target needs.
        const copy = await this.helper(host, {
          args: [
            ...repo.options,
            "copy",
            "--from-repo",
            repo.remote?.repository ?? REPO_MOUNT,
            "--from-password-file",
            `${HELPER_SECRETS_DIR}/${repo.remote ? REMOTE_KEY_NAME : HELPER_KEY_NAME}`,
            ...input.snapshotIds,
          ],
          mounts: [...repo.mounts, packageMount],
          secrets: [...repo.secrets, ...sealed],
          env: repo.remote ? [...env, ...repo.credentialEnv] : env,
          ...(repo.network ? { network: true } : {}),
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
        return await this.writeArchive(host, volume, file, maxBytes, onBytes);
      } finally {
        await this.unstage(host, volume);
      }
    });
  }

  async open(host: HostCtx, file: string, passphrase: string, onBytes?: ByteProgress): Promise<OpenedPackage> {
    const volume = await this.stage(host);
    try {
      await this.loadArchive(host, volume, file, onBytes);
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
          const roots = rootsOf(snapshots, snapshotIds);
          const rootSet = new Set(roots.values());
          await this.ensureRepo(host, { create: true });
          const before = await this.listing(host, []);
          const known = new Set(before.map((snapshot) => snapshot.id));
          for (const root of rootSet) {
            if (before.some((snapshot) => snapshot.id === root || snapshot.original === root)) {
              throw new SnapshotHeld(root);
            }
          }
          try {
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
              write: true,
            });
            this.assertOk(host, result, "restic copy out of the package");
            const copies = (await this.listing(host, [])).filter((snapshot) => !known.has(snapshot.id));
            return copiedIds(roots, copies);
          } catch (e) {
            await this.forgetCopies(host, known, rootSet);
            throw e;
          } finally {
            // A copy that failed may have written packs, so the cached reading is dropped either way.
            this.invalidateUsage(host);
          }
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
   * error: a restore or a forget names a snapshot that the repository must already hold. A host in remote-only mode has
   * no local volume to create or inspect: the repository is the remote one, opened with `cat config`.
   */
  private async ensureRepo(host: HostCtx, { create }: { create: boolean }): Promise<void> {
    const repo = await this.primary(host);
    if (this.ready.has(repo.key)) return;
    await host.runtime.pullImage(this.image);
    if (!repo.remote) {
      if (create) {
        await host.runtime.createVolume(repoVolume(host), {
          [host.keys.internal]: "true",
          [host.keys.checkpoint]: host.host.id,
        });
      } else {
        await host.runtime.inspectVolume(repoVolume(host));
      }
    }
    const probe = await this.runIn(host, repo, { args: ["cat", "config"] });
    if (probe.exitCode === 0) {
      this.ready.add(repo.key);
      return;
    }
    if (probe.exitCode === EXIT_WRONG_PASSWORD) throw failure("the checkpoint repository password is wrong", probe);
    if (probe.exitCode !== EXIT_NO_REPO) throw failure("could not open the checkpoint repository", probe);
    if (!create) throw new RuntimeError("not_found", "the checkpoint repository does not exist");
    const init = await this.runIn(host, repo, { args: ["init"], write: true });
    if (init.exitCode !== 0) throw failure("restic init", init);
    this.ready.add(repo.key);
  }

  /** A missing repository means its volume was removed behind the engine, so the next call checks it again. */
  private assertOk(host: HostCtx, result: HelperResult, what: string): void {
    if (result.exitCode === 0) return;
    if (result.exitCode === EXIT_NO_REPO) this.forgetReady(host);
    throw failure(what, result);
  }

  /**
   * The repository this host's checkpoints live in. A host in remote-only mode has no local volume: its repository is
   * the remote one, with restic's options for it and its credentials as files. The key names the repository itself, so
   * switching modes or moving the remote probes the new one instead of trusting the old one's `cat config`.
   */
  private async primary(host: HostCtx): Promise<PrimaryRepository> {
    const remote = this.remotes ? await this.remotes(host.host.id) : null;
    if (remote) {
      const call = remoteHelperCall(remote, []);
      return {
        key: `${host.host.id}\u0000remote:${remote.repository}`,
        remote,
        options: call.args,
        mounts: [],
        secrets: call.secrets,
        env: call.env,
        credentialEnv: credentialEnvOf(remote),
        network: true,
      };
    }
    return {
      key: `${host.host.id}\u0000local:${repoVolume(host)}`,
      remote: null,
      options: [],
      mounts: [{ source: repoVolume(host), target: REPO_MOUNT, mode: "rw" }],
      secrets: [{ name: HELPER_KEY_NAME, value: this.password() }],
      env: repoEnv(HELPER_KEY_NAME, REPO_MOUNT),
      credentialEnv: [],
      network: false,
    };
  }

  /** restic on this host's repository. Its options, key and mount are added to the call. */
  private async run(host: HostCtx, call: Omit<HelperCall, "env">): Promise<HelperResult> {
    return this.runIn(host, await this.primary(host), call);
  }

  private runIn(host: HostCtx, repo: PrimaryRepository, call: Omit<HelperCall, "env">): Promise<HelperResult> {
    const { write, ...rest } = call;
    return this.helper(host, {
      ...rest,
      args: [...repo.options, ...(write && repo.remote ? ["--retry-lock", REMOTE_LOCK_WAIT] : []), ...call.args],
      mounts: [...repo.mounts, ...(call.mounts ?? [])],
      secrets: [...repo.secrets, ...(call.secrets ?? [])],
      env: repo.env,
      network: repo.network || undefined,
    });
  }

  /** A repository that was removed behind the engine is probed and read again on the next call. */
  private forgetReady(host: HostCtx): void {
    for (const key of this.ready) if (key.startsWith(`${host.host.id}\u0000`)) this.ready.delete(key);
    this.invalidateUsage(host);
  }

  /** Drops a host's cached usage reading, since a write changed what the repository stores. */
  private invalidateUsage(host: HostCtx): void {
    for (const key of this.usageCache.keys()) {
      if (key.startsWith(`${host.host.id}\u0000`)) this.usageCache.delete(key);
    }
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
      network: call.network,
      labels: { [host.keys.internal]: "true" },
      memoryBytes: HELPER_MEMORY_BYTES,
      pidsLimit: HELPER_PIDS_LIMIT,
      tmpfsBytes: HELPER_TMPFS_BYTES,
      timeoutSec: call.timeoutSec ?? HELPER_TIMEOUT_SEC,
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
  private async loadArchive(host: HostCtx, volume: string, file: string, onBytes?: ByteProgress): Promise<void> {
    const created = await host.runtime.createContainer(stagingSpec(host, this.image, volume, "rw"));
    const source = createReadStream(file);
    try {
      const body = onBytes ? Readable.from(countingChunks(source, onBytes), { objectMode: false }) : source;
      await host.runtime.putArchive(created.id, PACKAGE_MOUNT, body);
    } finally {
      source.destroy();
      await host.runtime.removeContainer(created.id, { force: true }).catch(() => undefined);
    }
  }

  /** Streams the staged repository out as a package file, checked as it is written. */
  private async writeArchive(
    host: HostCtx,
    volume: string,
    file: string,
    maxBytes: number,
    onBytes?: ByteProgress,
  ): Promise<PackageDigest> {
    const created = await host.runtime.createContainer(stagingSpec(host, this.image, volume, "ro"));
    try {
      const archive = await host.runtime.getArchive(created.id, PACKAGE_REPO);
      try {
        return await writePackageFile(onBytes ? countingChunks(archive, onBytes) : archive, file, maxBytes);
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

/** One helper call to a remote repository: restic's options, the files it reads them from, and its environment. */
export interface RemoteHelperCall {
  args: string[];
  secrets: HelperSecret[];
  env: string[];
}

/**
 * The options and files that name a remote repository, without the repository environment. A helper that reads the remote
 * as a copy source writes another repository, so its `RESTIC_REPOSITORY` and `RESTIC_PASSWORD_FILE` must stay that
 * other one's; only the target's credential file, which restic's SDK reads by itself, joins its environment.
 */
function remoteFileParts(remote: RemoteRepository): { options: string[]; secrets: HelperSecret[]; env: string[] } {
  const secrets: HelperSecret[] = [{ name: REMOTE_KEY_NAME, value: remote.password }];
  const env: string[] = [];
  const options: string[] = [];
  if (remote.credentials.kind === "s3") {
    secrets.push({ name: AWS_KEY_NAME, value: s3CredentialsFile(remote.credentials) });
    env.push(`AWS_SHARED_CREDENTIALS_FILE=${HELPER_SECRETS_DIR}/${AWS_KEY_NAME}`);
    options.push("-o", `s3.region=${remote.credentials.region}`);
  } else {
    secrets.push({ name: SFTP_KEY_NAME, value: remote.credentials.privateKey });
    secrets.push({ name: KNOWN_HOSTS_NAME, value: `${remote.credentials.knownHosts}\n` });
    const sshArgs = [
      `-i ${HELPER_SECRETS_DIR}/${SFTP_KEY_NAME}`,
      "-o IdentitiesOnly=yes",
      "-o StrictHostKeyChecking=yes",
      `-o UserKnownHostsFile=${HELPER_SECRETS_DIR}/${KNOWN_HOSTS_NAME}`,
      `-p ${remote.credentials.port}`,
    ].join(" ");
    options.push("-o", `sftp.args=${sshArgs}`);
  }
  return { options, secrets, env };
}

/** The credential-file environment of a remote repository, which a helper may add beside another repository's own. */
function credentialEnvOf(remote: RemoteRepository): string[] {
  return remoteFileParts(remote).env;
}

/**
 * The options, secret files and environment of a helper that talks to a remote repository. The repository password and
 * the target's credentials are only ever files under `HELPER_SECRETS_DIR`; the environment names those files and never
 * holds a credential, because `docker inspect` shows it to anyone who can reach the engine.
 */
export function remoteHelperCall(remote: RemoteRepository, command: string[]): RemoteHelperCall {
  const parts = remoteFileParts(remote);
  return {
    args: [...parts.options, ...command],
    secrets: parts.secrets,
    env: [...repoEnv(REMOTE_KEY_NAME, remote.repository), ...parts.env],
  };
}

/** The `[default]` section of an AWS shared credentials file, which restic's SDK reads by itself. */
function s3CredentialsFile(credentials: S3RemoteCredentials): string {
  return `[default]\naws_access_key_id = ${credentials.accessKeyId}\naws_secret_access_key = ${credentials.secretAccessKey}\n`;
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
    const { id, tags, original } = (typeof item === "object" && item !== null ? item : {}) as {
      id?: unknown;
      tags?: unknown;
      original?: unknown;
    };
    if (typeof id !== "string" || !SNAPSHOT_ID_RE.test(id)) return null;
    const names = Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
    const origin = typeof original === "string" && SNAPSHOT_ID_RE.test(original) ? original : null;
    refs.push({ id, tags: names, original: origin });
  }
  return refs;
}

/**
 * The origin of each package snapshot: the snapshot it was first taken as, or itself when it was taken here. Two of
 * them with one origin cannot be copied together, so that is refused.
 */
function rootsOf(snapshots: SnapshotRef[], ids: string[]): Map<string, string> {
  const roots = new Map<string, string>();
  for (const id of ids) {
    const snapshot = snapshots.find((item) => item.id === id);
    if (!snapshot) throw new PackageRejected("invalid", `the package holds no snapshot ${id}`);
    const root = snapshot.original ?? snapshot.id;
    if ([...roots.values()].includes(root))
      throw new PackageRejected("invalid", "the package holds one snapshot twice");
    roots.set(id, root);
  }
  return roots;
}

/** Each package snapshot's copy in the repository: the new snapshot that carries the same origin. */
function copiedIds(roots: Map<string, string>, copies: SnapshotRef[]): Map<string, string> {
  const ids = new Map<string, string>();
  for (const [packaged, root] of roots) {
    const copy = copies.find((snapshot) => snapshot.original === root);
    if (!copy) throw new RuntimeError("engine", `restic copy wrote no snapshot for ${packaged}`);
    ids.set(packaged, copy.id);
  }
  return ids;
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
