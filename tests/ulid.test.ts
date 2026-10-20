import { describe, expect, test } from "bun:test";

import { createUlid } from "../src/events/ulid";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The millisecond timestamp a ULID encodes in its first ten characters. */
function timeOf(id: string): number {
  let time = 0;
  for (const ch of id.slice(0, 10)) time = time * 32 + ALPHABET.indexOf(ch);
  return time;
}

describe("ulid", () => {
  test("is 26 Crockford base32 characters", () => {
    const make = createUlid();
    for (let i = 0; i < 50; i++) expect(make()).toMatch(ULID);
  });

  test("encodes the millisecond it was made for", () => {
    const make = createUlid();
    const at = 1_750_000_000_123;
    expect(timeOf(make(at))).toBe(at);
  });

  test("ids made in the same millisecond are distinct and strictly increasing", () => {
    const make = createUlid();
    const at = 1_750_000_000_000;
    const ids = Array.from({ length: 2000 }, () => make(at));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(ids.toSorted());
  });

  test("ids stay increasing when the clock steps back", () => {
    const make = createUlid();
    const later = make(1_750_000_005_000);
    const earlier = make(1_750_000_001_000);
    expect(earlier > later).toBe(true);
    expect(timeOf(earlier)).toBe(1_750_000_005_000);
  });

  test("ids made later in time sort after earlier ones", () => {
    const make = createUlid();
    const first = make(1_750_000_100_000);
    const second = make(1_750_000_100_001);
    expect(timeOf(second)).toBe(1_750_000_100_001);
    expect(first < second).toBe(true);
  });

  test("separate generators do not share their clock", () => {
    const advanced = createUlid();
    const fresh = createUlid();
    advanced(1_750_000_300_000);
    expect(timeOf(fresh(1_750_000_200_000))).toBe(1_750_000_200_000);
  });

  test("the default clock is the current time", () => {
    const make = createUlid();
    const before = Date.now();
    const id = make();
    const after = Date.now();
    expect(timeOf(id)).toBeGreaterThanOrEqual(before);
    expect(timeOf(id)).toBeLessThanOrEqual(after);
  });
});
