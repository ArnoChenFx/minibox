import { test } from "bun:test";
import { existsSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { testConfig } from "../support/app";

/**
 * Run by tests/tmp-cleanup.test.ts as a `bun test` of its own, never by the suite (its name is not a test file's). It
 * makes the directories the suite makes, tells the test where they are, and then ends the way the test asks: it waits for
 * the test to signal it, finishes, or fails.
 */
const ready = process.env.TMP_FIXTURE_READY ?? "";
const go = `${ready}.go`;

test("makes the temporary directories of the suite", async () => {
  const dirs = [
    // A data directory from testConfig(), made below the one directory the suite makes for them.
    testConfig().dataDir,
    ...["bctx-", "mbp-", "mb-relay-", "minibox-files-test-"].map((prefix) => mkdtempSync(join(tmpdir(), prefix))),
  ];
  // Written whole and then moved into place, so the test never reads half of it.
  writeFileSync(`${ready}.part`, JSON.stringify(dirs));
  renameSync(`${ready}.part`, ready);
  const end = process.env.TMP_FIXTURE_END;
  if (end === "hang") await Bun.sleep(60_000);
  while (!existsSync(go)) await Bun.sleep(25);
  if (end === "fail") throw new Error("the run fails");
});
