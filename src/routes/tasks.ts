import { AppError } from "../lib/errors";
import { msg } from "../lib/messages";
import { parseSequence } from "../operations/events";
import { taskStream } from "../tasks/stream";
import { TASK_ID_RE } from "../tasks/types";
import { type Route, route } from "./router";

const STREAM_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  "x-accel-buffering": "no",
};

/**
 * The cursor a reconnecting client already has. `Last-Event-ID` wins over `after`, because a browser's EventSource
 * cannot set the header on its first request and sends `after` instead.
 */
function cursorOf(req: Request, url: URL): number | undefined {
  const header = req.headers.get("last-event-id")?.trim();
  const query = url.searchParams.get("after")?.trim();
  const raw = header || query || "";
  if (!raw) return undefined;
  if (raw === "0") return 0;
  const cursor = parseSequence(raw);
  if (cursor === undefined) {
    throw new AppError(400, "validation_failed", msg("last_event_id_invalid"), {
      field: header ? "Last-Event-ID" : "after",
    });
  }
  return cursor;
}

/**
 * Stays outside the operation registry: a stream is not a JSON request and response. It uses the same authentication
 * and origin checks as every other `/api/` route, and the same bus topic the executor publishes task progress on.
 * `server.timeout(req, 0)` disables Bun's idle timer, which is not extended by heartbeats.
 */
export const taskRoutes: Route[] = [
  route("GET", "/api/tasks/:id/events", ({ app, req, url, params, server, caller }) => {
    if (!TASK_ID_RE.test(params.id ?? "")) {
      throw new AppError(400, "validation_failed", msg("task_id_invalid"), { field: "id" });
    }
    const task = app.tasks.get(params.id ?? "", { output: false });
    if (!task) throw new AppError(404, "not_found", msg("task_not_found"));
    const after = cursorOf(req, url);
    const release = app.streams.acquire();
    server.timeout(req, 0);
    // A browser that signs out or is revoked must stop receiving progress now, not at its next reconnect.
    const sessionEnded = new AbortController();
    const unwatch = caller?.sessionId ? app.sessions.watch(caller.sessionId, () => sessionEnded.abort()) : undefined;
    const stream = taskStream({
      taskId: task.id,
      store: app.tasks,
      subscribe: (listener) => app.bus.subscribe("task", listener),
      after,
      signal: AbortSignal.any([req.signal, sessionEnded.signal]),
      onEnd: () => {
        unwatch?.();
        release();
      },
    });
    return new Response(stream, { headers: STREAM_HEADERS });
  }),
];
