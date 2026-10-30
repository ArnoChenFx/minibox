import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { ensureDataDir, SECRET_FILE_MODE, writeFileAtomic } from "../data-dir";
import { hostGone } from "../host/gone";
import { log } from "../lib/logger";
import { isBoxId } from "./revision";
import { StagedStore } from "./staged";
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

/** A spec was written, or a box was removed. Listeners hear it after the file has changed. */
export type SpecChange = { kind: "write"; spec: BoxSpec } | { kind: "remove"; id: string };

/** Long enough that no read started before a removal can still be waiting to claim the container it names. */
const RETIRED_MS = 10 * 60_000;

/**
 * `DATA_DIR/boxes/<id>.json`. Writes are atomic (temp file in the same directory, then rename)
 * and the file mode is 600, matching the other control-plane files. One store is shared by every host.
 */
export class SpecStore {
  private tail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(change: SpecChange) => void>();
  private readonly retired = new Map<string, number>();
  /** Hosts that were removed, so a write that was already on its way cannot bring one of their boxes back. */
  private readonly closed = new Set<string>();

  /** Rebuild changes staged per box. A box's staged file goes when its spec does. */
  readonly staged: StagedStore;

  constructor(private readonly dataDir: string) {
    this.staged = new StagedStore(dataDir);
  }

  /** Refuses later spec writes for a host that was removed. Removals stay allowed, so the caller can clean up. */
  closeHost(hostId: string): void {
    this.closed.add(hostId);
  }

  /** Puts a host id back into service, when a host with it is added again. */
  openHost(hostId: string): void {
    this.closed.delete(hostId);
  }

  isClosed(hostId: string): boolean {
    return this.closed.has(hostId);
  }

  /** Returns the function that removes the listener. A listener that throws is logged and the others still hear it. */
  subscribe(listener: (change: SpecChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

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
    // v0.6.x wrote the setup wait as `startupAwaitsClone`. Rename it so a spec on disk from before the rename still holds
    // back the box's startup command instead of reading as one that need not wait.
    const spec = parsed as BoxSpec & { startupAwaitsClone?: boolean };
    if (spec.startupAwaitsClone === true) {
      spec.startupAwaitsSetup = true;
      delete spec.startupAwaitsClone;
    }
    return spec;
  }

  findByName(name: string): BoxSpec | null {
    return this.list().find((spec) => spec.name === name) ?? null;
  }

  /**
   * The spec that names a container by id or name. Hosts that share an engine see the same containers, so pass the
   * host id to get only that host's spec: a spec of another host is then never returned.
   */
  findByContainer(containerId: string, containerName: string, hostId?: string): BoxSpec | null {
    return (
      this.list().find(
        (spec) =>
          (hostId === undefined || spec.hostId === hostId) &&
          (spec.containerId === containerId || spec.containerName === containerName),
      ) ?? null
    );
  }

  /** Every spec that names a container by id or name, whichever host it belongs to. */
  holdersOf(containerId: string, containerName: string): BoxSpec[] {
    return this.list().filter((spec) => spec.containerId === containerId || spec.containerName === containerName);
  }

  write(spec: BoxSpec): void {
    if (this.closed.has(spec.hostId)) throw hostGone(spec.hostId);
    ensureDataDir(this.dataDir);
    writeFileAtomic(this.pathFor(spec.id), `${JSON.stringify(spec, null, 2)}\n`, SECRET_FILE_MODE);
    this.notify({ kind: "write", spec });
  }

  remove(id: string): void {
    if (!isBoxId(id)) return;
    try {
      unlinkSync(this.pathFor(id));
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
    this.staged.remove(id);
    this.notify({ kind: "remove", id });
  }

  /**
   * Records that a container was removed along with its spec. A read taken before the removal can reach its claim after
   * the spec is gone, and must not write a spec for a container that no longer exists. Docker does not reuse container ids.
   */
  retire(containerId: string): void {
    const now = Date.now();
    for (const [id, until] of this.retired) if (until <= now) this.retired.delete(id);
    this.retired.set(containerId, now + RETIRED_MS);
  }

  isRetired(containerId: string): boolean {
    return (this.retired.get(containerId) ?? 0) > Date.now();
  }

  private notify(change: SpecChange): void {
    for (const listener of new Set(this.listeners)) {
      try {
        listener(change);
      } catch (e) {
        log.error("box.spec_listener_failed", { kind: change.kind, error: String(e) });
      }
    }
  }
}
