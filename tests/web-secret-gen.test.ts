import { describe, expect, test } from "bun:test";

import { generateSecret, type RandomSource } from "../web/js/lib/secret-gen.js";

/** A random source that fills each array with the given bytes, in order. */
function fixedRandom(bytes: number[]): RandomSource {
  return {
    getRandomValues<T extends ArrayBufferView | null>(array: T): T {
      if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes);
      return array;
    },
  };
}

describe("generated secret values", () => {
  test("a new value is 43 URL-safe base64 characters with no padding, the length of 32 random bytes", () => {
    expect(generateSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("the value is the random bytes in URL-safe base64, so the same bytes always give the same value", () => {
    const bytes = Array.from({ length: 32 }, (_, index) => (index * 37 + 11) % 256);
    expect(generateSecret(fixedRandom(bytes))).toBe(Buffer.from(bytes).toString("base64url"));
  });

  test("bytes whose standard base64 has + or / give - and _ instead, and no padding", () => {
    const bytes = Array.from({ length: 32 }, () => 0xff);
    expect(Buffer.from(bytes).toString("base64")).toContain("/");
    const value = generateSecret(fixedRandom(bytes));
    expect(value).toContain("_");
    expect(value).not.toMatch(/[+/=]/);
  });

  test("it asks the random source for exactly 32 bytes", () => {
    let requested = -1;
    generateSecret({
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        requested = array?.byteLength ?? -1;
        return array;
      },
    });
    expect(requested).toBe(32);
  });

  test("each value is new, so a value generated earlier is never handed out again", () => {
    const values = new Set(Array.from({ length: 200 }, () => generateSecret()));
    expect(values.size).toBe(200);
  });
});
