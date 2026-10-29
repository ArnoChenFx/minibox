import type { AppTopics } from "../app";
import type { BoxFrame, LinkState } from "../host/live";
import type { HostRegistry } from "../host/registry";
import type { Bus } from "../lib/bus";
import { OWNER, type Principal } from "../operations/types";
import { liveBox } from "../services/box-view";
import type { Box } from "../services/boxes";
import type { TaskView } from "../tasks/types";
import { allBoxViews, boxVisible, hostAllowed, taskVisible, viewOfBox } from "../tokens/model";
import type { LiveSource } from "./stream";

/** The state every host had when a stream started. A host whose sampler is not current lists no boxes. */
interface SyncFrame {
  hosts: { hostId: string; state: LinkState; boxes: Box[] }[];
}

/** One frame of live state. The event name is the kind, so a client dispatches on it without reading the data. */
function liveFrame(kind: string, data: unknown): string {
  return `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Who a live stream is for. A token sees its boxes and their samples, and its tasks' status. The owner sees everything. */
export interface LiveViewer {
  readonly principal: Principal;
  /** The task's record, for the owner-scoped check of a status frame. A token without it sees no status frames. */
  readonly task?: (taskId: string) => TaskView | undefined;
}

/**
 * The live state of the app as its bus carries it, limited to what `viewer` may see. A stream subscribes to the box,
 * sample, link and host frames, and to the status changes of tasks, which are the only task frames that carry no
 * output. `sync` reads each host's cache in the same synchronous step that subscribes, so no frame can fall between
 * the state and the first frame after it. A subscription also has every host's sampler sample at the live interval
 * until the subscription ends. Sample and host frames are keyed by host, so a slow subscriber keeps only the latest.
 *
 * For a token, a box is visible when `boxVisible` says so for its host. The boxes a stream has sent are remembered, so
 * a sample of a box it never showed is dropped, and a box that stops being visible is removed from the client. Host and
 * link frames are the owner's alone, and a task status frame is sent only when `taskVisible` allows it.
 */
export function liveSource(
  bus: Bus<AppTopics>,
  hosts: HostRegistry,
  viewer: LiveViewer = { principal: OWNER },
): LiveSource {
  const { principal } = viewer;
  const owner = principal.type === "owner";
  const shown = new Set<string>();
  const seesHost = (hostId: string): boolean =>
    owner || (principal.type === "token" && hostAllowed(principal.grants.hosts, hostId));
  const seesBox = (box: Box, hostId: string): boolean => owner || boxVisible(principal, viewOfBox(box, hostId));

  return {
    sync: () => {
      shown.clear();
      return liveFrame("sync", {
        hosts: hosts
          .list()
          .filter((host) => seesHost(host.host.id))
          .map((host) => {
            const boxes = host.sampler
              .boxes({ withStats: true })
              .filter((box) => seesBox(box, host.host.id))
              .map(liveBox);
            for (const box of boxes) shown.add(box.boxId);
            return {
              hostId: host.host.id,
              state: host.sampler.ready() ? "live" : "down",
              boxes,
            };
          }),
      } satisfies SyncFrame);
    },
    subscribe(send) {
      const watches = hosts.list().map((host) => host.sampler.watch());
      const onBox = (frame: BoxFrame) => {
        if (owner) return send(liveFrame("box", frame));
        if (frame.op === "remove") {
          if (shown.delete(frame.boxId)) send(liveFrame("box", frame));
          return;
        }
        if (seesBox(frame.box, frame.hostId)) {
          shown.add(frame.boxId);
          return send(liveFrame("box", frame));
        }
        if (shown.delete(frame.boxId)) {
          send(
            liveFrame("box", {
              hostId: frame.hostId,
              op: "remove",
              boxId: frame.boxId,
              containerId: frame.containerId,
            }),
          );
        }
      };
      const unsubscribes = [
        bus.subscribe("box", onBox),
        bus.subscribe("sample", (frame) => {
          if (owner) return send(liveFrame("sample", frame), `sample:${frame.hostId}`);
          const boxes = frame.boxes.filter((box) => shown.has(box.boxId));
          if (boxes.length === 0) return;
          send(liveFrame("sample", { ...frame, boxes }), `sample:${frame.hostId}`);
        }),
        bus.subscribe("link", (frame) => {
          if (owner) send(liveFrame("link", frame));
        }),
        bus.subscribe("host", (frame) => {
          if (owner) send(liveFrame("host", frame), `host:${frame.hostId}`);
        }),
        bus.subscribe("task", (frame) => {
          if (frame.kind !== "status") return;
          if (owner) return send(liveFrame("task", frame));
          if (principal.type !== "token" || !viewer.task) return;
          const task = viewer.task(frame.taskId);
          if (task && taskVisible(principal, task, allBoxViews(hosts.list()))) send(liveFrame("task", frame));
        }),
      ];
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
        for (const release of watches) release();
      };
    },
  };
}
