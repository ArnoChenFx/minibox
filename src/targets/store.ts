import { readSecretFile, SECRET_FILE_MODE, targetsPath, writeFileAtomic } from "../data-dir";
import { TARGET_VERSION, TargetFileSchema, type TargetRecord } from "./types";

/** The file cannot be used as it is. The message names the file so the operator can fix or remove it. */
export class TargetFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetFileError";
  }
}

/**
 * Off-site targets, kept in `DATA_DIR/targets.json`. The file holds where each target is and what was last synced, and
 * never a credential. It is read once at startup and kept in memory. A change is written whole, and is undone in memory
 * when the write fails, so the file and the list never disagree.
 */
export class TargetStore {
  private readonly records = new Map<string, TargetRecord>();

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
  }

  list(): TargetRecord[] {
    return [...this.records.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): TargetRecord | undefined {
    return this.records.get(id);
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
    const body = { version: TARGET_VERSION, targets: this.list() };
    writeFileAtomic(targetsPath(this.dataDir), `${JSON.stringify(body, null, 2)}\n`, SECRET_FILE_MODE);
  }
}
