import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import { type RuntimeEvent, type Runtime } from "../runtime";
import { labelFilter, call, type Engine } from "./engine";

interface EngineEvent {
  Type: string;
  Action: string;
  Actor: { ID: string; Attributes?: Record<string, string> };
  time: number;
  timeNano?: number;
}

/**
 * Docker sends one JSON object per line. Destroying the stream alone does not end a pending readline iterator,
 * so the interface is closed explicitly; both are needed to release the socket on abort or early exit.
 */
async function* readEvents(stream: Readable, signal?: AbortSignal): AsyncGenerator<RuntimeEvent> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const stop = () => {
    lines.close();
    stream.destroy();
  };
  if (signal?.aborted) stop();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line) as EngineEvent;
      yield {
        type: ev.Type,
        action: ev.Action,
        id: ev.Actor.ID,
        attributes: ev.Actor.Attributes ?? {},
        time: new Date(ev.time * 1000).toISOString(),
        timeNano: ev.timeNano ?? ev.time * 1_000_000_000,
      };
    }
  } finally {
    signal?.removeEventListener("abort", stop);
    stop();
  }
}

type EventMethods = Pick<Runtime, "events">;

export function eventMethods(engine: Engine): EventMethods {
  const { docker } = engine;

  return {
    async *events(filter, signal) {
      const filters: Record<string, string[]> = {};
      if (filter.labels) filters.label = labelFilter(filter.labels);
      if (filter.types) filters.type = filter.types;
      const options: { filters?: Record<string, string[]>; since?: number } = {};
      if (Object.keys(filters).length > 0) options.filters = filters;
      if (filter.since !== undefined) options.since = filter.since;
      const stream = (await call(() => docker.getEvents(options))) as Readable;
      yield* readEvents(stream, signal);
    },
  };
}
