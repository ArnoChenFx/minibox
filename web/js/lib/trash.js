const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days until an entry's retention ends, rounding a part day up. Zero once the time has passed. */
export function daysLeft(expiresAt, now = Date.now()) {
  const left = new Date(expiresAt).getTime() - now;
  return Number.isFinite(left) && left > 0 ? Math.ceil(left / DAY_MS) : 0;
}
