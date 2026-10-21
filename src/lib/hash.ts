import { createHash } from "node:crypto";

/** SHA-256 hex of a token. Sessions and API tokens both store this and never the token itself. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
