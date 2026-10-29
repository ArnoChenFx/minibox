import { rateLimitKey } from "../auth";

/** Failed logins from one address before it is locked out. */
export const SSH_FAILURES_FREE = 5;
/** The first lockout. Each failure after it doubles the lockout, up to SSH_LOCKOUT_MAX_MS. */
export const SSH_LOCKOUT_BASE_MS = 30_000;
export const SSH_LOCKOUT_MAX_MS = 60 * 60_000;
/** Failures older than this are forgotten, unless the address is still locked out. */
const SSH_FAILURE_WINDOW_MS = 15 * 60_000;
/** Addresses tracked at once. The oldest is dropped past it, so a scan from many addresses cannot grow memory. */
const SSH_TRACKED_MAX = 10_000;
/** Connections that have not logged in yet, from all addresses and from one. */
const SSH_PENDING_MAX = 32;
export const SSH_PENDING_PER_IP_MAX = 8;
/** Authentication attempts one connection may make, counting key queries, before it is closed. OpenSSH allows 6. */
export const SSH_ATTEMPTS_PER_CONNECTION = 10;

interface Failures {
  count: number;
  last: number;
  lockedUntil: number;
}

/**
 * Throttles direct SSH logins by source address. IPv6 addresses share a /64, as the web login throttle does. After
 * SSH_FAILURES_FREE failures each further failure locks the address out for a doubling time; a success clears it.
 * Separately it caps the connections still in their handshake, which is all an attacker without a credential can hold.
 */
export class SshLoginLimiter {
  private readonly failures = new Map<string, Failures>();
  private readonly pendingByIp = new Map<string, number>();
  private pending = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Milliseconds the address is still locked out for, 0 when it may try. */
  lockedFor(address: string): number {
    const entry = this.entry(rateLimitKey(address));
    return entry ? Math.max(0, entry.lockedUntil - this.now()) : 0;
  }

  /** Records a failed login and returns the lockout it starts, 0 while the address is under the free count. */
  fail(address: string): number {
    const key = rateLimitKey(address);
    const now = this.now();
    const entry = this.entry(key) ?? { count: 0, last: now, lockedUntil: 0 };
    entry.count += 1;
    entry.last = now;
    const over = entry.count - SSH_FAILURES_FREE;
    const lockout = over > 0 ? Math.min(SSH_LOCKOUT_BASE_MS * 2 ** (over - 1), SSH_LOCKOUT_MAX_MS) : 0;
    entry.lockedUntil = lockout > 0 ? now + lockout : 0;
    this.failures.delete(key);
    this.failures.set(key, entry);
    while (this.failures.size > SSH_TRACKED_MAX) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
    return lockout;
  }

  succeed(address: string): void {
    this.failures.delete(rateLimitKey(address));
  }

  /** Takes a handshake slot for a new connection. Returns its release, or null when the address or the server is full. */
  admit(address: string): (() => void) | null {
    const key = rateLimitKey(address);
    const mine = this.pendingByIp.get(key) ?? 0;
    if (this.pending >= SSH_PENDING_MAX || mine >= SSH_PENDING_PER_IP_MAX) return null;
    this.pending += 1;
    this.pendingByIp.set(key, mine + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.pending -= 1;
      const left = (this.pendingByIp.get(key) ?? 1) - 1;
      if (left > 0) this.pendingByIp.set(key, left);
      else this.pendingByIp.delete(key);
    };
  }

  get pendingCount(): number {
    return this.pending;
  }

  private entry(key: string): Failures | null {
    const entry = this.failures.get(key);
    if (!entry) return null;
    const now = this.now();
    if (entry.lockedUntil <= now && now - entry.last > SSH_FAILURE_WINDOW_MS) {
      this.failures.delete(key);
      return null;
    }
    return entry;
  }
}
