import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { createSecretFile, ensureDataDir, readSecretFile } from "../data-dir";
import type { HostCtx } from "../host/registry";
import { HELPER_SECRETS_DIR, type HelperResult, type Mount, RuntimeError } from "../runtime";
import type { BackupResult, SnapshotEngine } from "./engine";

/** Pinned engine image. Its flags below follow restic 0.18. */
export const RESTIC_IMAGE = "restic/restic:0.18.1";

const REPO_MOUNT = "/repo";
const DATA_MOUNT = "/data";
const TARGET_MOUNT = "/dst";
/** The password file on the host, under `DATA_DIR/secrets`. */
const KEY_FILE = "checkpoint-repo.key";
/** The same password as a file inside the helper, under `HELPER_SECRETS_DIR`. */
const HELPER_KEY_NAME = "repo.key";
const SNAPSHOT_ID_RE = /^[0-9a-f]{64}$/;

const HELPER_MEMORY_BYTES = 1024 * 1024 * 1024;
const HELPER_PIDS_LIMIT = 256;
const HELPER_TMPFS_BYTES = 64 * 1024 * 1024;
const HELPER_TIMEOUT_SEC = 3600;

/** restic exits 10 when the repository does not exist, and 12 when the password does not open it. */
const EXIT_NO_REPO = 10;
const EXIT_WRONG_PASSWORD = 12;

export interface ResticOptions {
  /** `DATA_DIR`. The repository key lives in `secrets/`. */
  dataDir: string;
  image?: string;
}

/**
 * Snapshots with restic, run in a short-lived helper from `RESTIC_IMAGE`. Each host has one repository, in a volume
 * named `<prefix>-checkpoints-<host>`. The repository password is generated once into `DATA_DIR/secrets`. Each helper
 * gets it as a secret file, read through `RESTIC_PASSWORD_FILE`, so it never appears in the helper's environment.
 *
 * Operations on one host run one at a time, so the repository is never initialized twice and backups do not compete
 * for its lock. A repository the password cannot open is an error, never a reason to initialize a new one.
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

  private async run(
    host: HostCtx,
    call: { args: string[]; mounts?: Mount[]; capAdd?: string[] },
  ): Promise<HelperResult> {
    return host.runtime.runHelper({
      image: this.image,
      cmd: ["--no-cache", ...call.args],
      user: "0:0",
      capAdd: call.capAdd,
      mounts: [{ source: repoVolume(host), target: REPO_MOUNT, mode: "rw" }, ...(call.mounts ?? [])],
      secrets: [{ name: HELPER_KEY_NAME, value: this.password() }],
      env: [
        `RESTIC_PASSWORD_FILE=${HELPER_SECRETS_DIR}/${HELPER_KEY_NAME}`,
        `RESTIC_REPOSITORY=${REPO_MOUNT}`,
        "HOME=/tmp",
      ],
      labels: { [host.keys.internal]: "true" },
      memoryBytes: HELPER_MEMORY_BYTES,
      pidsLimit: HELPER_PIDS_LIMIT,
      tmpfsBytes: HELPER_TMPFS_BYTES,
      timeoutSec: HELPER_TIMEOUT_SEC,
    });
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

async function assertVolume(host: HostCtx, volume: string): Promise<void> {
  await host.runtime.inspectVolume(volume);
}

function assertSnapshotId(id: string): void {
  if (!SNAPSHOT_ID_RE.test(id)) throw new RuntimeError("invalid", `not a checkpoint snapshot id: ${id}`);
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
