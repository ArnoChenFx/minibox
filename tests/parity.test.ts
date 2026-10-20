import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type Exchange, runParityScenario } from "./parity/scenario";

// Recorded from commit 68ec685, before the operation registry existed. Regenerating it from the current code would
// make the test compare the code with itself, so it must only change when the HTTP contract changes on purpose.
const TRANSCRIPT = join(import.meta.dir, "fixtures", "parity-transcript.json");

describe("HTTP parity", () => {
  test("every exchange matches the transcript recorded before the operation registry", async () => {
    const actual: Exchange[] = await runParityScenario();
    const expected = JSON.parse(readFileSync(TRANSCRIPT, "utf8")) as Exchange[];
    expect(actual.length).toBe(expected.length);
    for (const [index, exchange] of expected.entries()) {
      expect({ index, ...actual[index] }).toEqual({ index, ...exchange });
    }
  });
});
