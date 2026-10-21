import { chmodSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureDataDir, SECRET_FILE_MODE } from "../data-dir";
import { log } from "../lib/logger";
import { isBoxId } from "./revision";
import { SPEC_VERSION, type BoxSpec } from "./types";

const isEnoent = (e: unknown): boolean => typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";

function isSpec(value: unknown): value is BoxSpec {
  if (typeof value !== "object" || value === null) return false;
  const spec = value as Partial<BoxSpec>;
  return (
    spec.version === SPEC_VERSION &&
    typeof spec.id === "string" &&
    isBoxId(spec.id) &&
    typeof spec.name === "string" &&
    typeof spec.revision === "number" &&
    spec.restart === "no" &&
    (spec.lifecycle?.desired === "running" || spec.lifecycle?.desired === "stopped") &&
    typeof spec.containerId === "string" &&
    typeof spec.containerName === "string"
  );
}

/**
 * `DATA_DIR/boxes/<id>.json`. Writes are atomic (temp file in the same directory, then rename)
 * and the file mode is 600, matching the other control-plane files. One store is shared by every host.
 */
export class SpecStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {}

  dir(): string {
    return join(this.dataDir, "boxes");
  }

  pathFor(id: string): string {
    if (!isBoxId(id)) throw new Error(`refusing a box spec path for ${id}`);
    return join(this.dir(), `${id}.json`);
  }

  /**
   * Runs `fn` only after every earlier mutation has finished. Not re-entrant:
   * a function inside the lock must not call `exclusive` again.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => fn());
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  list(): BoxSpec[] {
    let names: string[];
    try {
      names = readdirSync(this.dir());
    } catch (e) {
      if (isEnoent(e)) return [];
      throw e;
    }
    const specs: BoxSpec[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (!isBoxId(id)) continue;
      const spec = this.read(id);
      if (spec) specs.push(spec);
    }
    return specs;
  }

  /** `null` when the file is missing. A file that is not a spec is logged and treated as missing, not overwritten. */
  read(id: string): BoxSpec | null {
    if (!isBoxId(id)) return null;
    let text: string;
    try {
      text = readFileSync(this.pathFor(id), "utf8");
    } catch (e) {
      if (isEnoent(e)) return null;
      throw e;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (e) {
      log.warn("box.spec_unreadable", { id, error: String(e) });
      return null;
    }
    if (!isSpec(parsed)) {
      log.warn("box.spec_unreadable", { id, error: "not a box spec" });
      return null;
    }
    if (!Array.isArray(parsed.history)) parsed.history = [];
    return parsed;
  }

  findByName(name: string): BoxSpec | null {
    return this.list().find((spec) => spec.name === name) ?? null;
  }

  findByContainer(containerId: string, containerName: string): BoxSpec | null {
    return this.list().find((spec) => spec.containerId === containerId || spec.containerName === containerName) ?? null;
  }

  write(spec: BoxSpec): void {
    ensureDataDir(this.dataDir);
    const path = this.pathFor(spec.id);
    const tmp = `${path}.${process.pid}.tmp`;
    const body = `${JSON.stringify(spec, null, 2)}\n`;
    try {
      writeFileSync(tmp, body, { mode: SECRET_FILE_MODE });
      chmodSync(tmp, SECRET_FILE_MODE);
      renameSync(tmp, path);
      chmodSync(path, SECRET_FILE_MODE);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        // The temp file was already renamed, or it was never created.
      }
      throw e;
    }
  }

  remove(id: string): void {
    if (!isBoxId(id)) return;
    try {
      unlinkSync(this.pathFor(id));
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
  }
}
