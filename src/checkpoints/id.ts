import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const ID_RE = /^ck_[0-9a-z]{8,32}$/;

/** A stable checkpoint id. It names no box and no volume, so a checkpoint outlives both. */
export function newCheckpointId(): string {
  const bytes = randomBytes(10);
  let id = "ck_";
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length] ?? "0";
  return id;
}

export function isCheckpointId(value: string): boolean {
  return ID_RE.test(value);
}
