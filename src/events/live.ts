import type { AppTopics } from "../app";
import type { LinkState } from "../host/live";
import type { HostRegistry } from "../host/registry";
import type { Bus } from "../lib/bus";
import type { Box } from "../services/boxes";
import type { LiveSource } from "./stream";

/** The state every host had when a stream started. A host whose sampler is not current lists no boxes. */
export interface SyncFrame {
  hosts: { hostId: string; state: LinkState; boxes: Box[] }[];
}

/** One frame of live state. The event name is the kind, so a client dispatches on it without reading the data. */
export function liveFrame(kind: string, data: unknown): string {
  return `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * The live state of the app as its bus carries it. A stream subscribes to the box, sample, link and host frames, and to
 * the status changes of tasks, which are the only task frames that carry no output. `sync` reads each host's cache in
 * the same synchronous step that subscribes, so no frame can fall between the state and the first frame after it.
 */
export function liveSource(bus: Bus<AppTopics>, hosts: HostRegistry): LiveSource {
  return {
    sync: () =>
      liveFrame("sync", {
        hosts: hosts.list().map((host) => ({
          hostId: host.host.id,
          state: host.sampler.ready() ? "live" : "down",
          boxes: host.sampler.boxes({ withStats: true }),
        })),
      } satisfies SyncFrame),
    subscribe(send) {
      const unsubscribes = [
        bus.subscribe("box", (frame) => send(liveFrame("box", frame))),
        bus.subscribe("sample", (frame) => send(liveFrame("sample", frame))),
        bus.subscribe("link", (frame) => send(liveFrame("link", frame))),
        bus.subscribe("host", (frame) => send(liveFrame("host", frame))),
        bus.subscribe("task", (frame) => {
          if (frame.kind === "status") send(liveFrame("task", frame));
        }),
      ];
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
  };
}
