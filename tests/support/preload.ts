import { tmpdir } from "node:os";

import { createTestRoot, startJanitor, sweepStaleRoots } from "./tmp-root";

/**
 * Loaded before every `bun test` run (`bunfig.toml`). The run keeps all its temporary files in one directory of its own,
 * `$TMPDIR/mbrun-<pid>-…`: it points `TMPDIR` there, so every `mkdtemp(join(tmpdir(), …))` in the suite lands in it, and a
 * janitor process removes the directory when the run ends, however it ends (see `startJanitor`).
 *
 * An `exit` handler, which is where a test file would naturally put this, never runs under `bun test`: Bun does not emit
 * `exit` when a run ends. Every run used to leave its `minibox-test-data-*` behind, and the runs that a timeout or a
 * signal stopped left every other directory they had made as well.
 *
 * The janitor is the only way a run is cleaned up. If it was killed with the run, or `sh` is missing, the next run
 * sweeps the leftover (`sweepStaleRoots`).
 */
const LOADED = Symbol.for("minibox.test-tmp-root");
const slot = globalThis as unknown as Record<symbol, string | undefined>;

if (slot[LOADED] === undefined) {
  const base = tmpdir();
  try {
    sweepStaleRoots(base);
  } catch {
    // The sweep tidies up after earlier runs; a failure of it must not fail this one.
  }
  try {
    const root = createTestRoot(base);
    slot[LOADED] = root;
    process.env.TMPDIR = root;
    startJanitor(root);
  } catch {
    // No directory of its own: the run keeps writing to the temporary directory, as it did before.
  }
}
