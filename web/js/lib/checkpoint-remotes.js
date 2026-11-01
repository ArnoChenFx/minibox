import { api, enc } from "./api.js";
import { hostsNow } from "./hosts.js";

/** How long one host's answer is reused. A checkpoint card loads on every task status frame, so the answer is not. */
const TTL_MS = 30 * 1000;

/** One host's answer: the remote mode, or null when its read failed or it has no remote. */
const entries = new Map();
/** Reads still running, so two loads of one page share a request per host instead of sending two. */
const inflight = new Map();
/** Bumped by `forgetOnlyHosts`, so a read that started before a save cannot put its old answer back into the cache. */
let generation = 0;

/**
 * Reads one host's remote repository, or answers from the cache while its answer is younger than the TTL. A failed read
 * is not cached and reads as "not remote-only", as the badges did before modes existed.
 */
function modeOf(hostId, now) {
  const cached = entries.get(hostId);
  if (cached && now() - cached.at < TTL_MS) return Promise.resolve(cached.mode);
  const running = inflight.get(hostId);
  if (running) return running;
  const started = generation;
  const read = api(`/api/hosts/${enc(hostId)}/checkpoint-remote`)
    .then(
      (reply) => {
        const mode = reply?.remote?.mode ?? null;
        if (started === generation) entries.set(hostId, { mode, at: now() });
        return mode;
      },
      () => null,
    )
    .finally(() => {
      if (inflight.get(hostId) === read) inflight.delete(hostId);
    });
  inflight.set(hostId, read);
  return read;
}

/**
 * The hosts whose checkpoints are kept only on their remote repository. A read that fails leaves its host out: the
 * badges then fall back to what the records say, which is what the page showed before modes existed. `now` is the
 * cache's clock, so a test can cross the TTL without waiting.
 */
export async function onlyHostsNow(now = Date.now) {
  const hosts = hostsNow();
  const modes = await Promise.all(hosts.map((host) => modeOf(host.id, now)));
  return new Set(hosts.filter((_host, index) => modes[index] === "only").map((host) => host.id));
}

/**
 * Drops every cached answer and forgets the reads in flight. The settings page calls it after saving or clearing a
 * remote, so the next load asks again instead of showing the position from before the save.
 */
export function forgetOnlyHosts() {
  generation += 1;
  entries.clear();
  inflight.clear();
}
