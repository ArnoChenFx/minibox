/**
 * Checks on where a template or a box gets its files: a Dockerfile pasted in, a Git repository, or a build context URL.
 * They run before anything is fetched, cloned or built, so a refused value never reaches the network or the engine.
 */

/** Largest Dockerfile that can be pasted in, measured in UTF-8 bytes. */
export const DOCKERFILE_MAX_BYTES = 64 * 1024;
/** Longest URL a build context or a repository may be given. */
export const SOURCE_URL_MAX = 2048;
/** Longest relative path inside a build context or a repository. */
export const SOURCE_PATH_MAX = 512;

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** `user@host:path`, the scp-like form of an SSH address. The host starts with a letter or digit, so it cannot be an option. */
const SCP_LIKE_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]*:\S+$/;
const FROM_RE = /^\s*FROM\s+\S/im;

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Why a build context URL is refused, or null. Only http and https, with no user name or password in the address. */
export function contextUrlProblem(value: string): string | null {
  if (value.length > SOURCE_URL_MAX) return "too long";
  if (/[\s\p{Cc}]/u.test(value)) return "whitespace";
  const url = parseUrl(value);
  if (!url) return "not a URL";
  if (url.protocol !== "https:" && url.protocol !== "http:") return "scheme";
  if (url.username !== "" || url.password !== "") return "credentials";
  return null;
}

export type RepoUrlProblem = "syntax" | "credentials";

/**
 * Why a repository URL is refused, or null. Accepted: https://host/path, ssh://[user@]host/path, and the scp-like
 * `user@host:path`. A password in the address is refused, because a credential belongs in a secret.
 */
export function repoUrlProblem(value: string): RepoUrlProblem | null {
  if (value.length > SOURCE_URL_MAX || /[\s\p{Cc}]/u.test(value) || value.startsWith("-")) return "syntax";
  if (/^https:\/\//i.test(value)) {
    const url = parseUrl(value);
    if (!url || !url.hostname) return "syntax";
    return url.username !== "" || url.password !== "" ? "credentials" : null;
  }
  if (/^ssh:\/\//i.test(value)) {
    const url = parseUrl(value);
    if (!url || !url.hostname) return "syntax";
    return url.password !== "" ? "credentials" : null;
  }
  return SCP_LIKE_RE.test(value) ? null : "syntax";
}

/** Whether a repository URL names the SSH transport, which authenticates with a deploy key rather than a token. */
export function isSshRepoUrl(value: string): boolean {
  return /^ssh:\/\//i.test(value) || SCP_LIKE_RE.test(value);
}

/** A branch name git accepts: starts with a letter or digit, and holds no `..`, `//`, or trailing `/` or `.lock`. */
export function repoBranchProblem(value: string): boolean {
  return !BRANCH_RE.test(value) || value.includes("..") || value.includes("//") || /(\/|\.lock)$/.test(value);
}

/** A path inside a build context or a repository: relative, no `..` part, no NUL or control characters. */
export function relativePathProblem(value: string): boolean {
  if (value.length === 0 || value.length > SOURCE_PATH_MAX) return true;
  if (/\p{Cc}/u.test(value) || value.startsWith("/")) return true;
  return value.split("/").includes("..");
}

/**
 * `relative` resolved against the directory `base`, as parts from the repository root. `..` may climb toward the root
 * but never past it. Null when the result would leave the repository, or `relative` is absolute or holds a NUL byte.
 */
export function resolveInside(base: readonly string[], relative: string): string[] | null {
  if (relative.includes("\0") || relative.startsWith("/")) return null;
  const parts = [...base];
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") {
      parts.push(part);
    } else if (parts.length > 0) {
      parts.pop();
    } else {
      return null;
    }
  }
  return parts;
}

/** The Dockerfile text a template is built from: at most DOCKERFILE_MAX_BYTES, no NUL, and a FROM instruction. */
export function dockerfileProblem(text: string): string | null {
  if (Buffer.byteLength(text, "utf8") > DOCKERFILE_MAX_BYTES) return "too large";
  if (text.includes("\0") || !FROM_RE.test(text)) return "not a Dockerfile";
  return null;
}
