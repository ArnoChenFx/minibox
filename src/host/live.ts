import type { Box } from "../services/boxes";
import type { HostMetrics, HostSample } from "./metrics";

/**
 * `live` while the host's sampler is subscribed to the engine's events and its cache is current.
 * `down` while it is reconnecting, and before its first listing.
 */
export type LinkState = "live" | "down";

/** One resource sample of a running box. `t` is epoch milliseconds. */
export interface StatSample {
  t: number;
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  memPercent: number;
}

export interface BoxSample extends Omit<StatSample, "t"> {
  boxId: string;
}

/** A box's view changed, or the box is gone from the host. `containerId` is the container the frame is about. */
export type BoxFrame =
  | { hostId: string; op: "upsert"; boxId: string; containerId: string; box: Box }
  | { hostId: string; op: "remove"; boxId: string; containerId: string };

export interface SampleFrame {
  hostId: string;
  t: number;
  boxes: BoxSample[];
}

export interface LinkFrame {
  hostId: string;
  state: LinkState;
  error: string | null;
  at: string;
}

type LiveHostMetrics = Omit<HostMetrics, "history">;

interface HostFrame {
  hostId: string;
  metrics: LiveHostMetrics;
  sample: HostSample | null;
}

/** A type alias, not an interface: the bus constrains its topics to a record type, which an interface does not satisfy. */
export type LiveTopics = {
  box: BoxFrame;
  sample: SampleFrame;
  link: LinkFrame;
  host: HostFrame;
};

type LiveTopic = keyof LiveTopics;

/** Where a host's sampler and monitor publish. The application's bus is one. */
export interface LiveSink {
  publish<K extends LiveTopic>(topic: K, payload: LiveTopics[K]): void;
}

/** A sink that drops every frame. Hosts built without a bus, such as in tests, use it. */
export const NO_LIVE: LiveSink = { publish: () => {} };
