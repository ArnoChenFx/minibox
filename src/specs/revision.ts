import { randomBytes } from "node:crypto";

import { AppError } from "../lib/errors";
import { msg } from "../lib/messages";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const ID_RE = /^bx_[0-9a-z]{8,32}$/;

/** A stable box id, independent of the container id. Crockford alphabet, so it is safe in a container name later. */
export function newBoxId(): string {
  const bytes = randomBytes(10);
  let id = "bx_";
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length] ?? "0";
  return id;
}

export function isBoxId(value: string): boolean {
  return ID_RE.test(value);
}

/**
 * `If-Match` is an entity tag. Accept the bare revision, a quoted tag, and a weak tag.
 * An empty header is missing, not invalid: the client has to send one.
 */
export function parseRevision(header: string | undefined): number | "missing" | "invalid" {
  if (header === undefined || header.trim() === "") return "missing";
  const raw = header
    .trim()
    .replace(/^W\//i, "")
    .replace(/^"(.*)"$/, "$1");
  if (!/^[1-9]\d*$/.test(raw)) return "invalid";
  const revision = Number(raw);
  return Number.isSafeInteger(revision) ? revision : "invalid";
}

/** Turns a parsed `If-Match` into the 428 or 400 the update API returns before it looks at the spec. */
export function requireRevision(header: string | undefined): number {
  const parsed = parseRevision(header);
  if (parsed === "missing") throw new AppError(428, "precondition_required", msg("revision_required"));
  if (parsed === "invalid") {
    throw new AppError(400, "validation_failed", msg("revision_invalid"), { field: "If-Match" });
  }
  return parsed;
}

export function revisionMismatch(revision: number, expected: number): AppError {
  return new AppError(412, "precondition_failed", msg("revision_mismatch", { revision, expected }), {
    revision,
    expected,
  });
}
