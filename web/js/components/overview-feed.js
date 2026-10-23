import { api } from "../lib/api.js";
import { subscribe } from "../lib/live.js";
import { pollDelay } from "../lib/overview.js";

/** How long events must stay quiet before a read, so a burst of events costs one read. */
const EVENT_SETTLE_MS = 300;
/** How long to wait before the next try, while no overview has arrived yet. */
const RETRY_MS = 10_000;

/**
 * Reads the overview and passes each reading to `draw`. The next read comes on the cadence `pollDelay` gives, sooner
 * while a command runs, since its output changes as it goes. A stored event brings the read forward, so new activity
 * and new attention items show at once. Reads never overlap. Returns the function that stops the feed.
 */
export function followOverview(draw) {
  let overview = null;
  let timer = null;
  let settle = null;
  let busy = false;
  let again = false;
  let stopped = false;

  async function load() {
    clearTimeout(timer);
    if (stopped) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    const next = await api("/api/overview").catch(() => null);
    busy = false;
    if (stopped) return;
    if (next) {
      overview = next;
      draw(next);
    }
    if (again) {
      again = false;
      void load();
      return;
    }
    timer = setTimeout(load, overview ? pollDelay(overview) : RETRY_MS);
  }

  const refresh = () => {
    clearTimeout(settle);
    settle = setTimeout(load, EVENT_SETTLE_MS);
  };

  const offs = [subscribe("event", refresh), subscribe("reset", refresh)];
  void load();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(settle);
    for (const off of offs) off();
  };
}
