import { spyOn } from "bun:test";
import * as nodeCrypto from "node:crypto";

const realScryptSync = nodeCrypto.scryptSync;
const derived = new Map<string, Buffer>();

/**
 * Serves repeated `scryptSync` calls from memory. `SessionStore` derives a fingerprint of the access key with scrypt in its
 * constructor, about 25 ms of CPU, and every app a test builds runs it. The derivation is pure, so the bytes are the same
 * either way and only the time changes. `mock.restore()` removes the spy, so this is installed again whenever a test
 * config is built, and it does nothing while the spy is still in place.
 */
export function memoizeScryptSync(): void {
  if (nodeCrypto.scryptSync !== realScryptSync) return;
  spyOn(nodeCrypto, "scryptSync").mockImplementation((...args) => {
    const key = JSON.stringify(args);
    let value = derived.get(key);
    if (value === undefined) {
      value = realScryptSync(...args);
      derived.set(key, value);
    }
    return Buffer.from(value);
  });
}
