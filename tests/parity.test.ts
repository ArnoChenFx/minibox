import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type Exchange, runParityScenario } from "./parity/scenario";

// Regenerated when the HTTP contract changes on purpose. Error bodies include retryable, and hint when one is set.
// Volumes and pools (#24) and exec routes (Refs #9) are part of the transcript. `bx_…` ids are normalized to <boxId>,
// `vol_…` ids to <volumeId> and exec ids to ex_<ulid>. Image lists carry sourceId and createdBy, and the token steps
// come last so the exchanges before them keep their positions.
// Do not refresh this file for a change that should stay compatible.
const TRANSCRIPT = join(import.meta.dir, "fixtures", "parity-transcript.json");

describe("HTTP parity", () => {
  test("every exchange matches the transcript recorded before the operation registry", async () => {
    const actual: Exchange[] = await runParityScenario();
    const expected = JSON.parse(readFileSync(TRANSCRIPT, "utf8")) as Exchange[];
    expect(actual.length).toBe(expected.length);
    for (const [index, exchange] of expected.entries()) {
      expect({ index, ...actual[index] }).toEqual({ index, ...exchange });
    }
  }, 15_000);
});
