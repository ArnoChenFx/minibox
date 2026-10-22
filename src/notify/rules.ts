import type { StoredEvent } from "../events/store";
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

/**
 * The notice an event calls for, or null when the event is not one that notifies. Events the notifier itself writes,
 * such as a delivery record, are never matched, so a notification cannot start another one.
 */
export function noticeOfEvent(event: StoredEvent): Notice | null {
  const box = boxOf(event);
  const name = box?.name ?? "a box";
  const detail = fieldsOf(event.detail);
  switch (event.op) {
    case "container.oom":
      return box ? notice("box.oom", event, `Box ran out of memory: ${name}`, box) : null;
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
