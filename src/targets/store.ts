import { readSecretFile, SECRET_FILE_MODE, targetsPath, writeFileAtomic } from "../data-dir";
import { TARGET_VERSION, TargetFileSchema, type RemoteRepo, type TargetRecord } from "./types";

/** The file cannot be used as it is. The message names the file so the operator can fix or remove it. */
export class TargetFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetFileError";
  }
}

/**
 * Off-site targets, kept in `DATA_DIR/targets.json`. The file holds where each target is, what was last synced, and the
 * remote checkpoint repository of each host that has one, named by target id and folder. It never holds a credential. It
 * is read once at startup and kept in memory. A change is written whole, and is undone in memory when the write fails, so
 * the file and the list never disagree.
 */
export class TargetStore {
  private readonly records = new Map<string, TargetRecord>();
  /** The remote repository of each host that has one, by host id. */
  private readonly remotes = new Map<string, RemoteRepo>();

  constructor(private readonly dataDir: string) {}

  /** Reads the targets. A file that exists but does not match the format is an error, never an empty list. */
  load(): void {
    const path = targetsPath(this.dataDir);
    const text = readSecretFile(path);
    if (text === null) return;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new TargetFileError(`${path} is not valid JSON (${String(e)}). Fix or remove it.`);
    }
    const parsed = TargetFileSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? issue.path.join(".") : "the file";
      throw new TargetFileError(`${path} does not match the target format at ${where}. Fix or remove it.`);
    }
    for (const record of parsed.data.targets) {
      if (this.records.has(record.id)) {
        throw new TargetFileError(`${path} lists target ${record.id} more than once. Fix or remove it.`);
      }
      this.records.set(record.id, record);
    }
    for (const remote of parsed.data.remotes ?? []) {
      if (this.remotes.has(remote.hostId)) {
        throw new TargetFileError(
          `${path} lists a remote repository for ${remote.hostId} more than once. Fix or remove it.`,
        );
      }
      this.remotes.set(remote.hostId, remote);
    }
  }

  list(): TargetRecord[] {
    return [...this.records.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): TargetRecord | undefined {
    return this.records.get(id);
  }

  /** The remote repository a host's checkpoints are copied to, or undefined when the host has none. */
  remoteOf(hostId: string): RemoteRepo | undefined {
    return this.remotes.get(hostId);
  }

  /** The remote repositories that copy to one target. Removing such a target would leave them dangling. */
  remotesFor(targetId: string): RemoteRepo[] {
    return [...this.remotes.values()].filter((remote) => remote.targetId === targetId);
  }

  putRemote(remote: RemoteRepo): void {
    const previous = this.remotes.get(remote.hostId);
    this.remotes.set(remote.hostId, remote);
    try {
      this.write();
    } catch (e) {
      if (previous) this.remotes.set(remote.hostId, previous);
      else this.remotes.delete(remote.hostId);
      throw e;
    }
  }

  deleteRemote(hostId: string): boolean {
    const previous = this.remotes.get(hostId);
    if (!previous) return false;
    this.remotes.delete(hostId);
    try {
      this.write();
    } catch (e) {
      this.remotes.set(hostId, previous);
      throw e;
    }
    return true;
  }

  put(record: TargetRecord): void {
    const previous = this.records.get(record.id);
    this.records.set(record.id, record);
    try {
      this.write();
    } catch (e) {
      if (previous) this.records.set(record.id, previous);
      else this.records.delete(record.id);
      throw e;
    }
  }

  delete(id: string): boolean {
    const previous = this.records.get(id);
    if (!previous) return false;
    this.records.delete(id);
    try {
      this.write();
    } catch (e) {
      this.records.set(id, previous);
      throw e;
    }
    return true;
  }

  private write(): void {
    const body = { version: TARGET_VERSION, targets: this.list(), remotes: [...this.remotes.values()] };
    writeFileAtomic(targetsPath(this.dataDir), `${JSON.stringify(body, null, 2)}\n`, SECRET_FILE_MODE);
  }
}
