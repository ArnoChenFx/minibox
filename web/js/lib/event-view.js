import { ACTION_ICON, readableAction } from "./activity.js";
import { esc } from "./dom.js";
import { bytes } from "./format.js";
import { has, t } from "./i18n.js";

const COMMAND_MAX = 160;

/** An operation's name: the event label, else the recent-activity label, else its words (`tool.custom_put` → "Tool custom put"). */
export function opLabel(op) {
  if (has(`ev.${op}`)) return t(`ev.${op}`);
  if (has(`act.${op}`)) return t(`act.${op}`);
  return readableAction(op);
}

export function iconOf(op) {
  if (op.startsWith("exec.")) return "zap";
  if (op.startsWith("container.")) return "box";
  if (op.startsWith("session.") || op.startsWith("terminal.")) return "terminal";
  if (op.startsWith("egress.")) return "shield";
  return ACTION_ICON[op] ?? "activity";
}

/** A read that succeeded, such as polling a session list, is not history. Failed or refused reads still show. */
export const isRoutine = (event) => event.kind === "read" && event.status === "ok";

export const isFailed = (event) => event.status === "error" || event.status === "denied";

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function commandOf(detail) {
  const text = typeof detail.cmd === "string" ? detail.cmd : Array.isArray(detail.argv) ? detail.argv.join(" ") : "";
  return clip(text, COMMAND_MAX);
}

/** A one-line reading of what an event did, taken from its fields. Nothing here is free text from the event. */
export function describe(event) {
  const d = event.detail ?? {};
  if (event.op === "exec.finish") {
    const parts = [t("ev.exit", { code: d.exitCode ?? "—" })];
    if (typeof d.durationMs === "number") parts.push(t("ev.duration", { s: (d.durationMs / 1000).toFixed(1) }));
    return parts.join(" · ");
  }
  if (event.op === "session.send") return t("ev.send", { n: d.keys ?? 0, bytes: bytes(d.bytes ?? 0) });
  if (event.op === "terminal.close") {
    return t("ev.io", { in: bytes(d.bytesIn ?? 0), out: bytes(d.bytesOut ?? 0) });
  }
  if (event.op === "self.status") return [d.state, d.note].filter((part) => typeof part === "string").join(" · ");
  if (event.op === "self.ask" && typeof d.message === "string") return clip(d.message, COMMAND_MAX);
  if (event.op.startsWith("exec.")) return commandOf(d);
  if (event.op.startsWith("egress.")) return typeof d.host === "string" ? `${d.host}:${d.port ?? ""}` : "";
  if (typeof d.session === "string") return d.session;
  return "";
}

/** The outcome as a badge. `ok` is drawn only when `showOk` asks for it, as a log's result column does. */
export function statusBadge(event, { showOk = false } = {}) {
  if (event.status === "ok") {
    return showOk ? `<span class="badge badge-success">${esc(t("ev.status.ok"))}</span>` : "";
  }
  const variant = isFailed(event) ? "badge-danger" : event.status === "started" ? "badge-warning" : "";
  return `<span class="badge ${variant}">${esc(t(`ev.status.${event.status}`))}</span>`;
}

export const countTag = (event) => (event.count > 1 ? `<span class="tag">×${event.count}</span>` : "");

export function detailsJson(event) {
  if (event.detail === undefined) return "";
  return `<details class="event-json"><summary>${esc(t("ev.details"))}</summary><pre>${esc(JSON.stringify(event.detail, null, 2))}</pre></details>`;
}
