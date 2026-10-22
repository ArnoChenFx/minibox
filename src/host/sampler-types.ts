export interface SamplerOptions {
  /** Time between two sample rounds while a live subscriber watches. Host metrics use the same interval. */
  intervalMs: number;
  /** Time between two sample rounds while none does. Never shorter than `intervalMs`. */
  idleIntervalMs?: number;
  /** Age past which a sample is no longer reported. See `STALE_AFTER_MS`. */
  staleAfterMs?: number;
  /** Time between two full listings of the containers. A stalled event stream hides a change for at most this long. */
  relistMs?: number;
  /** Longest a re-list waits for its listing. See `RELIST_TIMEOUT_MS`. */
  relistTimeoutMs?: number;
  /** Longest a container inspect may take. See `INSPECT_TIMEOUT_MS`. */
  inspectTimeoutMs?: number;
  /** Longest the first listing after a subscription may take. See `LIST_TIMEOUT_MS`. */
  listTimeoutMs?: number;
  /** Longest `observe()` waits for the queued writes. See `OBSERVE_WAIT_MS`. */
  observeWaitMs?: number;
  /** Samples kept per box. The oldest are dropped first. */
  history: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
}

export interface BoxTotals {
  total: number;
  running: number;
  allocatedCpus: number;
  allocatedMemory: number;
  unlimited: number;
}
