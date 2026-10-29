import { createHash, randomBytes } from "node:crypto";

import { AppError } from "../../lib/errors";
import { msg } from "../../lib/messages";

const PAIRING_TTL_MS = 10 * 60_000;
const PAIRING_MAX_OUTSTANDING = 50;

/** Crockford base32: no I, L, O or U, so a code copied from a screen is not misread. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 10;

export interface PairingCode {
  /** The code as the operator types it, with a dash after the fifth character. */
  readonly code: string;
  readonly expiresAt: string;
}

/** What a spent code allows: the host it creates and the name it gets. */
export interface PairingGrant {
  readonly hostId: string;
  readonly name: string;
}

interface Entry extends PairingGrant {
  readonly expiresAt: number;
  spent: boolean;
}

/** Writes a code as the operator reads it. */
function formatCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** The code the book compares: upper case, no separators, and Crockford's look-alikes read as the digits they stand for. */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

function keyOf(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function newCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length];
  return code;
}

/**
 * The one-time codes an agent pairs with. A code is kept only as a hash, lives for `ttlMs`, and allows one pairing. A code
 * that is unknown, spent or expired is refused with a reason the operator can act on. Spent and expired codes are kept for
 * one more lifetime, so a repeat is reported as a reuse rather than as an unknown code.
 */
export class PairingBook {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number = PAIRING_TTL_MS,
    private readonly maxOutstanding: number = PAIRING_MAX_OUTSTANDING,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** A new code for a host that does not exist yet. Refused when too many codes are waiting. */
  create(hostId: string, name: string): PairingCode {
    const now = this.now();
    this.prune(now);
    const waiting = [...this.entries.values()].filter((entry) => !entry.spent && entry.expiresAt > now).length;
    if (waiting >= this.maxOutstanding) {
      throw new AppError(429, "too_many_requests", msg("agent_pairing_limit", { max: this.maxOutstanding }));
    }
    let code = newCode();
    while (this.entries.has(keyOf(code))) code = newCode();
    this.entries.set(keyOf(code), { hostId, name, expiresAt: now + this.ttlMs, spent: false });
    return { code: formatCode(code), expiresAt: new Date(now + this.ttlMs).toISOString() };
  }

  /** Spends a code. It allows one pairing, so a second attempt with the same code is refused. */
  redeem(raw: string): PairingGrant {
    const entry = this.entries.get(keyOf(normalizeCode(raw)));
    if (!entry) throw new AppError(401, "unauthorized", msg("agent_pairing_unknown"));
    if (entry.spent) throw new AppError(401, "unauthorized", msg("agent_pairing_used"));
    if (entry.expiresAt <= this.now()) throw new AppError(401, "unauthorized", msg("agent_pairing_expired"));
    entry.spent = true;
    return { hostId: entry.hostId, name: entry.name };
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt + this.ttlMs) this.entries.delete(key);
    }
  }
}
