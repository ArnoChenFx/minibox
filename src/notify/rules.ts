import type { StoredEvent } from "../events/store";
import { mebibytes } from "../volumes/limits";
import { type Notice, type NoticeBox, type NoticeKind } from "./types";

type Fields = Readonly<Record<string, unknown>>;

function fieldsOf(value: unknown): Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : {};
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boxOf(event: StoredEvent): NoticeBox | undefined {
  const target = event.target;
  if (target?.kind !== "box") return undefined;
  const ids = [textOf(fieldsOf(event.detail).boxId), target.id].filter((id): id is string => id !== undefined);
  return { name: target.name, ids: [...new Set(ids)] };
}

function commandFailed(detail: Fields): boolean {
  if (detail.timedOut === true) return true;
  return typeof detail.exitCode === "number" && detail.exitCode !== 0;
}

/** A failed checkpoint is one the engine or the repository refused, so only a server-side error counts. */
function checkpointFailed(event: StoredEvent): boolean {
  return event.status === "error" && (event.error?.status ?? 0) >= 500;
}

function notice(kind: NoticeKind, event: StoredEvent, title: string, box?: NoticeBox, body?: string): Notice {
  return { kind, title, body, box, at: event.ts };
}

/** A volume notice is sent once per volume within the dedup window, so one volume does not hide another's. */
function volumeNotice(event: StoredEvent, kind: NoticeKind, title: string, body?: string): Notice | null {
  const target = event.target;
  if (target?.kind !== "volume") return null;
  return { kind, title, body, at: event.ts, dedupKey: `${kind}:${target.id ?? target.name}` };
}

function hostDiskNotice(event: StoredEvent): Notice | null {
  const target = event.target;
  if (target?.kind !== "host") return null;
  return {
    kind: "host.disk_low",
    title: `Host disk is low: ${target.name}`,
    body: hostDiskBody(fieldsOf(event.detail)),
    host: target.name,
    at: event.ts,
    dedupKey: `host.disk_low:${target.id ?? target.name}`,
  };
}

function megabytes(bytes: unknown): string {
  return typeof bytes === "number" ? `${mebibytes(bytes)} MB` : "an unknown amount";
}

function usageHighBody(detail: Fields): string {
  return `Using ${megabytes(detail.bytes)} against a soft limit of ${megabytes(detail.softBytes)}. A soft limit is best effort, not a quota.`;
}

function usageLimitBody(detail: Fields): string {
  const reason = `Reason: over the hard limit of ${megabytes(detail.hardBytes)}, with ${megabytes(detail.bytes)} used. Action: ${textOf(detail.action) ?? "warn"}.`;
  const boxes = Array.isArray(detail.boxes)
    ? detail.boxes.map((box) => textOf(fieldsOf(box).name)).filter((name): name is string => name !== undefined)
    : [];
  return boxes.length > 0 ? `${reason} Stopped: ${boxes.join(", ")}.` : reason;
}

function hostDiskBody(detail: Fields): string {
  const free = typeof detail.freePercent === "number" ? `${detail.freePercent}% free` : "Little free space";
  return `${free}, below the minimum of ${String(detail.minFreePercent ?? "")}%. New volumes and checkpoints are refused until space is freed.`;
}

/**
 * The notice an event calls for, or null when the event is not one that notifies. Events the notifier itself writes,
 * such as a delivery record, are never matched, so a notification cannot start another one.
 */
export function noticeOfEvent(event: StoredEvent): Notice | null {
  const box = boxOf(event);
  const name = box?.name ?? "a box";
  const volumeName = event.target?.kind === "volume" ? event.target.name : "a volume";
  const detail = fieldsOf(event.detail);
  switch (event.op) {
    case "container.oom":
      return box ? notice("box.oom", event, `Box ran out of memory: ${name}`, box) : null;
    case "volume.usage_high":
      return volumeNotice(
        event,
        "volume.usage_high",
        `Volume over its soft limit: ${volumeName}`,
        usageHighBody(detail),
      );
    case "volume.usage_limit":
      return volumeNotice(
        event,
        "volume.usage_limit",
        `Volume over its hard limit: ${volumeName}`,
        usageLimitBody(detail),
      );
    case "host.disk_low":
      return hostDiskNotice(event);
    case "exec.finish": {
      if (!commandFailed(detail)) return null;
      const title = detail.timedOut === true ? `Command timed out in ${name}` : `Command failed in ${name}`;
      const body = typeof detail.exitCode === "number" ? `Exit code ${detail.exitCode}.` : undefined;
      return notice("exec.failed", event, title, box, body);
    }
    case "checkpoint.scheduled":
    case "checkpoint.create":
      if (!checkpointFailed(event)) return null;
      return notice("checkpoint.failed", event, `Checkpoint failed for ${name}`, box, textOf(detail.error));
    case "box.ttl_soon":
      return box
        ? notice("box.ttl_soon", event, `Box TTL ends soon: ${name}`, box, deadline("Stops at", detail))
        : null;
    case "box.idle_soon":
      return box
        ? notice("box.idle_soon", event, `Box will sleep when idle: ${name}`, box, deadline("Sleeps at", detail))
        : null;
    case "session.takeover":
      return box
        ? notice("session.takeover", event, `Terminal session taken over in ${name}`, box, sessionLine(detail))
        : null;
    default:
      return null;
  }
}

function deadline(label: string, detail: Fields): string | undefined {
  const at = textOf(detail.deadline);
  return at === undefined ? undefined : `${label} ${at}.`;
}

function sessionLine(detail: Fields): string | undefined {
  const session = textOf(detail.session);
  return session === undefined ? undefined : `Session ${session}.`;
}
