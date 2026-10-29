import { createHash, randomBytes } from "node:crypto";

import { AppError } from "../../lib/errors";
import { msg } from "../../lib/messages";
import { foldName } from "../label";

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
  /** A newer code for the same host took this one's place, so it no longer pairs. */
  replaced: boolean;
}

/** A waiting code that holds a name: the name it will give its host, and that host's id. */
export interface WaitingName {
  readonly hostId: string;
  readonly name: string;
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

  /**
   * A new code for a host that does not exist yet. It replaces any code still waiting for the same host, so an operator
   * who lost a code can ask for another at once, and only the newest code for a host pairs. Refused when too many codes
   * are waiting.
   */
  create(hostId: string, name: string): PairingCode {
    const now = this.now();
    this.prune(now);
    for (const entry of this.entries.values()) {
      if (entry.hostId === hostId && this.waiting(entry, now)) entry.replaced = true;
    }
    const waiting = [...this.entries.values()].filter((entry) => this.waiting(entry, now)).length;
    if (waiting >= this.maxOutstanding) {
      throw new AppError(429, "too_many_requests", msg("agent_pairing_limit", { max: this.maxOutstanding }));
    }
    let code = newCode();
    while (this.entries.has(keyOf(code))) code = newCode();
    this.entries.set(keyOf(code), { hostId, name, expiresAt: now + this.ttlMs, spent: false, replaced: false });
    return { code: formatCode(code), expiresAt: new Date(now + this.ttlMs).toISOString() };
  }

  /** Spends a code. It allows one pairing, so a second attempt with the same code is refused. */
  redeem(raw: string): PairingGrant {
    const entry = this.entries.get(keyOf(normalizeCode(raw)));
    if (!entry) throw new AppError(401, "unauthorized", msg("agent_pairing_unknown"));
    if (entry.spent) throw new AppError(401, "unauthorized", msg("agent_pairing_used"));
    if (entry.replaced) throw new AppError(401, "unauthorized", msg("agent_pairing_replaced"));
    if (entry.expiresAt <= this.now()) throw new AppError(401, "unauthorized", msg("agent_pairing_expired"));
    entry.spent = true;
    return { hostId: entry.hostId, name: entry.name };
  }

  /**
   * The waiting code that holds `name`, or null when none does. A waiting code holds its name the way a host does: it
   * names the host that is about to exist, so another host cannot take the name in the meantime. A code for `forHost`
   * is not counted, since a new code for that host replaces it and an added host of that id makes it unusable.
   */
  waitingName(name: string, forHost: string): WaitingName | null {
    const now = this.now();
    const folded = foldName(name);
    for (const entry of this.entries.values()) {
      if (entry.hostId === forHost || !this.waiting(entry, now)) continue;
      if (foldName(entry.name) === folded) return { hostId: entry.hostId, name: entry.name };
    }
    return null;
  }

  private waiting(entry: Entry, now: number): boolean {
    return !entry.spent && !entry.replaced && entry.expiresAt > now;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt + this.ttlMs) this.entries.delete(key);
    }
  }
}
