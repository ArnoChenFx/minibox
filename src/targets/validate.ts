import type { TargetKind } from "./types";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SFTP_HOST_RE = /^[A-Za-z0-9.:_-]{1,255}$/;
const SFTP_USER_RE = /^[A-Za-z0-9._@-]{1,64}$/;
const CONTROL_RE = /[\p{Cc}]/u;

/**
 * The https origin of an S3-compatible service, or null when the address is refused. Credentials are sent with every
 * request, so plain http is accepted only for this machine, where a test service or a local gateway runs.
 */
export function s3Endpoint(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  const local = LOOPBACK.has(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && local)) return url.origin;
  return null;
}

/**
 * A folder on the target, normalized. S3 keys have no leading slash, and an SFTP path may be absolute. A `.` or `..`
 * segment, an empty segment and a control character are refused, so no object can be written outside the folder.
 */
export function remotePath(raw: string, kind: TargetKind): string | null {
  if (CONTROL_RE.test(raw) || raw.includes("\\")) return null;
  const absolute = kind === "sftp" && raw.startsWith("/");
  const segments = raw.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  const joined = segments.join("/");
  return absolute ? `/${joined}` : joined;
}

export function sftpHost(raw: string): boolean {
  return SFTP_HOST_RE.test(raw);
}

export function sftpUser(raw: string): boolean {
  return SFTP_USER_RE.test(raw);
}

export function s3Bucket(raw: string): boolean {
  return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(raw) || /^[A-Za-z0-9._-]{1,63}$/.test(raw);
}
