import { scopedFilter } from "../events/scope";
import { eventStream } from "../events/stream";
import { AppError } from "../lib/errors";
import { msg } from "../lib/messages";
import { eventFilterInput, filterOf, parseSequence } from "../operations/events";
import { parseInput } from "../operations/validation";
import { OWNER } from "./operations";
import { type Route, route } from "./router";

const STREAM_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  "x-accel-buffering": "no",
};

/** The sequence number a reconnecting client sends back in `Last-Event-ID`. A first connection sends none. */
function lastEventIdOf(req: Request): number | undefined {
  const value = req.headers.get("last-event-id")?.trim();
  if (!value) return undefined;
  const id = parseSequence(value);
  if (id === undefined) {
    throw new AppError(400, "validation_failed", msg("last_event_id_invalid"), { field: "Last-Event-ID" });
  }
  return id;
}

/**
 * Stays outside the operation registry: a stream is not a JSON request and response, so the OpenAPI document has no
 * schema for it. It still goes through the same authentication and origin checks as every other `/api/` route.
 */
export const eventRoutes: Route[] = [
  route("GET", "/api/events/stream", ({ app, req, url, server, caller }) => {
    const filter = scopedFilter(filterOf(parseInput(eventFilterInput, Object.fromEntries(url.searchParams))), OWNER);
    const lastId = lastEventIdOf(req);
    server.timeout(req, 0);
    // A browser that signs out or is revoked must stop receiving events now, not at its next reconnect.
    const sessionEnded = new AbortController();
    const unwatch = caller?.sessionId ? app.sessions.watch(caller.sessionId, () => sessionEnded.abort()) : undefined;
    const stream = eventStream({
      store: app.events,
      subscribe: (listener) => app.bus.subscribe("event", listener),
      filter,
      lastId,
      signal: AbortSignal.any([req.signal, sessionEnded.signal]),
      onEnd: unwatch,
    });
    return new Response(stream, { headers: STREAM_HEADERS });
  }),
];
