import { existsSync, readFileSync } from "node:fs";

import { writeFileAtomic } from "../data-dir";
import { log } from "../lib/logger";

/**
 * The source lists each host's firewall was last set to. The rules live in the host kernel and outlive MiniBox, so the
 * list is kept on disk: a restart can then clear rules that no box needs any more. A host with no entry has never had a
 * rule set, so it holds none.
 */
export class FirewallStore {
  private readonly marks = new Map<string, string[]>();

  constructor(private readonly file: string | null) {
    if (file === null || !existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const [hostId, sources] of Object.entries(parsed)) {
        if (Array.isArray(sources) && sources.every((source) => typeof source === "string")) {
          this.marks.set(hostId, sources);
        }
      }
    } catch (e) {
      log.warn("egress.firewall_store_unreadable", { file, error: String(e) });
    }
  }

  read(hostId: string): readonly string[] {
    return this.marks.get(hostId) ?? [];
  }

  write(hostId: string, sources: readonly string[]): void {
    this.marks.set(hostId, [...sources]);
    if (this.file === null) return;
    writeFileAtomic(this.file, `${JSON.stringify(Object.fromEntries(this.marks), null, 2)}\n`);
  }
}

/** Applies one host's source list. Calls run one at a time, and a list the host already holds is not sent again. */
export class EgressFirewall {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly hostId: string,
    private readonly store: FirewallStore,
  ) {}

  apply(sources: readonly string[], set: (sources: string[]) => Promise<void>): Promise<void> {
    const run = this.queue.then(async () => {
      if (sameList(this.store.read(this.hostId), sources)) return;
      await set([...sources]);
      this.store.write(this.hostId, sources);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}
