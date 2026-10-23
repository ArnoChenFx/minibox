import { Database } from "bun:sqlite";
import { Worker } from "node:worker_threads";

/** Copies a store with `VACUUM INTO`, which reads one consistent snapshot through a read-only connection. */
export function copySqlite(livePath: string, target: string): void {
  const db = new Database(livePath, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.run("VACUUM INTO ?", [target]);
  } finally {
    db.close();
  }
}

/**
 * Runs `copySqlite` in a worker thread. The copy of a large store takes a while, and the API keeps serving meanwhile.
 * Writers keep going, and an uncommitted transaction is never in the copy.
 */
export function snapshotDatabase(livePath: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./snapshot-worker.ts", import.meta.url), {
      workerData: { livePath, target },
    });
    worker.once("error", reject);
    worker.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`the snapshot of ${livePath} failed`))));
  });
}
