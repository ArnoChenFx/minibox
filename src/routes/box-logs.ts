import { z } from "zod";

import type { App } from "../app";
import type { Caller } from "../auth";
import type { HostCtx } from "../host/registry";
import { logStream } from "../logs/stream";
import { boxLogs, boxTarget } from "../operations/boxes";
import type { Principal } from "../operations/types";
import { parseInput, tail } from "../operations/validation";
import { type Box, hostOfSpecRef, readBox } from "../services/boxes";
import { boxVisible, refusal, viewOfBox } from "../tokens/model";
import { abortWhenEnded, principalOf, type Route, route, scopedAccess } from "./router";

const STREAM_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  "x-accel-buffering": "no",
};

const streamInput = z.object({ tail: tail() });

interface LogRead {
  readonly app: App;
  readonly host: HostCtx;
  readonly caller: Caller | null;
  readonly principal: Principal;
  readonly box: Box;
  readonly tail: number;
}

/** Records a read of a box's log the way the `box.logs` operation records its reads, so a stream open is audited too. */
function noteLogRead({ app, host, caller, principal, box, tail }: LogRead, status: "ok" | "denied"): void {
  app.recordNote(host.host.id, caller?.sessionId ? "ui" : "rest", principal, {
    op: boxLogs.name,
    kind: "read",
    status,
    summary: `${boxLogs.summary}: ${box.name}`,
    target: boxTarget(box),
    detail: { tail },
    ...(status === "denied" ? { error: { code: "forbidden", status: 403 } } : {}),
  });
}

/**
 * Stays outside the operation registry, as the event and task streams do. The scope is the one `box.logs` declares, and
 * the box must be visible to the principal, the same rule the operation applies. An unknown box is 404 and a box the
 * principal may not see is 403, as the operation answers.
 */
export const boxLogRoutes: Route[] = [
  route(
    "GET",
    "/api/boxes/:id/logs/stream",
    async (ctx) => {
      const { app, req, url, params, server, caller } = ctx;
      const host = hostOfSpecRef(app.hosts, params.id ?? "") ?? ctx.host;
      const principal = principalOf(ctx);
      const { tail: lines } = parseInput(streamInput, Object.fromEntries(url.searchParams));
      const box = await readBox(host, params.id ?? "");
      const read = { app, host, caller, principal, box, tail: lines };
      if (!boxVisible(principal, viewOfBox(box, host.host.id))) {
        noteLogRead(read, "denied");
        throw refusal("box_out_of_scope");
      }
      const release = app.streams.acquire();
      noteLogRead(read, "ok");
      server.timeout(req, 0);
      // A browser that signs out or is revoked must stop receiving lines now, not at its next reconnect.
      const ended = new AbortController();
      const stopWatching = abortWhenEnded(app, caller, ended);
      const stream = logStream({
        follows: host.sampler.logs,
        boxId: box.boxId,
        tail: lines,
        signal: AbortSignal.any([req.signal, ended.signal]),
        onEnd: () => {
          stopWatching();
          release();
        },
      });
      return new Response(stream, { headers: STREAM_HEADERS });
    },
    { access: scopedAccess("box:read") },
  ),
];
