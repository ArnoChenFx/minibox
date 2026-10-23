/** Container actions that can change how a box looks. Exec, attach and the like leave the box as it was. */
export const STATE_VERBS = new Set([
  "create",
  "start",
  "restart",
  "die",
  "stop",
  "kill",
  "pause",
  "unpause",
  "oom",
  "rename",
  "update",
  "health_status",
]);

export const STATS_CONCURRENCY = 8;

/** Container inspects a drain runs at once. A burst of starts and stops then takes a few engine round trips, not one per box. */
export const INSPECT_CONCURRENCY = 8;

/** Longest a stats call may take. A longer interval waits this long for a sample at most. */
export const STATS_TIMEOUT_MS = 5000;

export const BACKOFF_MIN_MS = 1000;

export const BACKOFF_MAX_MS = 30_000;

export const IDLE_INTERVAL_MS = 30_000;

/**
 * How long one `need()` keeps the samples going while no live subscriber watches. A reader of usage renews it, so
 * a host that nobody reads costs no stats call once the lease runs out.
 */
export const DEMAND_LEASE_MS = 5 * 60_000;

/** A sample older than this is not reported. The idle cadence sits well inside it, so a leased sampler keeps it current. */
export const STALE_AFTER_MS = 60_000;

/** How long a delivered event is remembered, so a replay of it after a reconnect is not delivered again. */
export const EVENT_MEMORY_MS = 60_000;

/** Remembered events above this count are swept of the expired ones before a new one is remembered. */
export const EVENT_MEMORY_SWEEP = 1024;

/** How often the containers are listed again, so a change the event stream never reported is caught up. */
export const RELIST_MS = 60_000;

/** Longest a re-list waits for the engine's listing. A listing that is still pending past this is given up. */
export const RELIST_TIMEOUT_MS = 30_000;

/** Longest a container inspect may take. A longer one keeps the cached entry, and the next round reads it again. */
export const INSPECT_TIMEOUT_MS = 5000;

/** Longest the first listing after a subscription may take. A longer one takes the link down, and backoff retries. */
export const LIST_TIMEOUT_MS = 30_000;

/** Longest `observe()` waits for the queued writes. Past it, the caller goes on, and the writes still run in order. */
export const OBSERVE_WAIT_MS = 5000;
