import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Redactor } from "./redact";

/** How much of each stream is kept: the first and the last this many bytes. */
export const OUTPUT_HEAD_TAIL_BYTES = 64 * 1024;

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The start and the end of a text, with a note in between for what was dropped. Text within the limit is unchanged. */
export function headAndTail(text: string, limit = OUTPUT_HEAD_TAIL_BYTES): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit * 2) return text;
  const head = bytes.subarray(0, limit).toString("utf8");
  const tail = bytes.subarray(bytes.length - limit).toString("utf8");
  return `${head}\n… ${bytes.length - limit * 2} bytes omitted …\n${tail}`;
}

interface StoredFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Command output, kept apart from the events because it is large and short-lived. Each record is one JSON file under
 * the output directory, with credentials redacted and each stream cut to its head and tail.
 */
export class OutputStore {
  constructor(
    private readonly dir: string,
    private readonly redactor: Redactor,
  ) {}

  /** Writes one record and returns the reference an event uses to point at it. */
  save(name: string, output: { stdout: string; stderr: string }): string {
    if (!NAME.test(name)) throw new Error(`output name is not a plain identifier: ${name}`);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const record = {
      stdout: headAndTail(this.redactor.text(output.stdout)),
      stderr: headAndTail(this.redactor.text(output.stderr)),
    };
    writeFileSync(this.pathOf(name), JSON.stringify(record), { mode: 0o600 });
    return `exec/${name}`;
  }

  /**
   * Removes records older than `maxAgeMs`, then the oldest of the rest until their total size is within `maxBytes`.
   * Returns how many records went.
   */
  prune(now: number, maxAgeMs: number, maxBytes: number): number {
    let removed = 0;
    const kept: StoredFile[] = [];
    for (const file of this.files()) {
      if (now - file.mtimeMs > maxAgeMs) {
        unlinkSync(file.path);
        removed += 1;
      } else {
        kept.push(file);
      }
    }
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = kept.reduce((sum, file) => sum + file.size, 0);
    for (const file of kept) {
      if (total <= maxBytes) break;
      unlinkSync(file.path);
      total -= file.size;
      removed += 1;
    }
    return removed;
  }

  private pathOf(name: string): string {
    return join(this.dir, `${name}.json`);
  }

  private files(): StoredFile[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    return names.map((name) => {
      const path = join(this.dir, name);
      const stat = statSync(path);
      return { path, size: stat.size, mtimeMs: stat.mtimeMs };
    });
  }
}
