import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const ID_RE = /^vol_[0-9a-z]{8,32}$/;

/** A stable volume id. The engine volume uses the same string, so it never has to follow a box name. */
export function newVolumeId(): string {
  const bytes = randomBytes(10);
  let id = "vol_";
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length] ?? "0";
  return id;
}

export function isVolumeId(value: string): boolean {
  return ID_RE.test(value);
}
