import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type Exchange, runParityScenario } from "./parity/scenario";

// Regenerated when the HTTP contract changes on purpose. Box specs added stable ids, revisions and If-Match
// (Refs #23). `bx_…` ids are normalized to <boxId>. Do not refresh this file for a change that should stay compatible.
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
