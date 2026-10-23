import { HostKeyMismatchError, HostKeyUnconfirmedError } from "../host/ssh";

/**
 * What went wrong with a target, in the terms the operator acts on: the place cannot be reached, the credentials are
 * refused, the access is denied, the object is missing, or the server presents a host key that is not the pinned one.
 */
export type FailureReason =
  | "unreachable"
  | "auth"
  | "forbidden"
  | "missing"
  | "host_key_unconfirmed"
  | "host_key_mismatch"
  | "failed";

export class TargetFailure extends Error {
  constructor(
    readonly reason: FailureReason,
    detail: string,
    /** The host key the server presented, for the two host key reasons. */
    readonly fingerprint: string | null = null,
  ) {
    super(detail);
    this.name = "TargetFailure";
  }
}

const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
  "ConnectionRefused",
  "DNSResolveFailed",
]);
const S3_AUTH_CODES: ReadonlySet<string> = new Set([
  "AuthorizationHeaderMalformed",
  "ExpiredToken",
  "InvalidAccessKeyId",
  "InvalidToken",
  "SignatureDoesNotMatch",
]);
const S3_FORBIDDEN_CODES: ReadonlySet<string> = new Set(["AccessDenied", "Forbidden"]);
const S3_MISSING_CODES: ReadonlySet<string> = new Set(["NoSuchBucket", "NoSuchKey", "NotFound"]);

/** SFTP status codes the protocol defines, as ssh2 reports them: no such file, and permission denied. */
const SFTP_NO_SUCH_FILE = 2;
const SFTP_PERMISSION_DENIED = 3;

const MAX_DETAIL = 300;

function codeOf(e: unknown): string | number | undefined {
  if (typeof e !== "object" || e === null || !("code" in e)) return undefined;
  const { code } = e;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

/** The object or the bucket is not there. A missing object is an answer for a stat, and an error for a read. */
export function isMissing(e: unknown): boolean {
  const code = codeOf(e);
  return (typeof code === "string" && (S3_MISSING_CODES.has(code) || code === "ENOENT")) || code === SFTP_NO_SUCH_FILE;
}

/** Sorts any error from a target adapter into a reason. The text kept is short, and it never includes a credential. */
export function classifyFailure(e: unknown): TargetFailure {
  if (e instanceof TargetFailure) return e;
  if (e instanceof HostKeyUnconfirmedError) return new TargetFailure("host_key_unconfirmed", e.message, e.presented);
  if (e instanceof HostKeyMismatchError) return new TargetFailure("host_key_mismatch", e.message, e.presented);
  const code = codeOf(e);
  if (typeof code === "string") {
    if (S3_AUTH_CODES.has(code)) return new TargetFailure("auth", code);
    if (S3_FORBIDDEN_CODES.has(code)) return new TargetFailure("forbidden", code);
    if (NETWORK_CODES.has(code)) return new TargetFailure("unreachable", code);
  }
  if (code === SFTP_PERMISSION_DENIED) return new TargetFailure("forbidden", "permission denied");
  const text = (e instanceof Error ? e.message : String(e)).slice(0, MAX_DETAIL);
  if (/authentication methods failed|all configured authentication/i.test(text)) return new TargetFailure("auth", text);
  if (/timed out|handshake|connect/i.test(text)) return new TargetFailure("unreachable", text);
  return new TargetFailure("failed", text);
}
