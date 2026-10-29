/**
 * What the overview's watch lists show, where their actions lead, and how often the page reads again. Pure, and it
 * imports nothing that needs the browser, so a test loads it without the storage the dictionaries and the API client
 * use.
 */

import { boxHash } from "./routes.js";

const RUNNING_MS = 3000;
const ACTIVE_MS = 10_000;
const IDLE_MS = 15_000;

/** The dictionary key that names each kind of attention item. */
export const ATTENTION_LABEL = Object.freeze({
  "box.oom": "ov.attn.oom",
  "box.checkpoint_failed": "ov.attn.checkpoint_failed",
  "box.drift": "ov.attn.drift",
  "box.rollback_pending": "ov.attn.rollback_pending",
  "volume.over_limit": "ov.attn.over_limit",
  "pool.unreachable": "ov.attn.pool_unreachable",
  "host.offline": "ov.attn.host_offline",
  "host.disk_low": "ov.attn.disk_low",
  "host.cpu_overcommit": "ov.attn.cpu_overcommit",
  "host.memory_overcommit": "ov.attn.memory_overcommit",
  "host.forward_blocked": "ov.attn.forward_blocked",
});

/**
 * Whether an item has a fix MiniBox can apply itself, once the owner confirms it. A blocked uplink is only repairable
 * when a chain fell off its end: a `DROP` the host's own rules make is a decision, and a reading that left a rule
 * unread is not a verdict, so neither gets a button.
 */
export const canRepair = (item) => item.kind === "host.forward_blocked" && item.params.cause === "policy";

/** The page of the storage or host an item names. Box conditions open the box's tab that shows them instead. */
const PAGE_OF = Object.freeze({
  "volume.over_limit": "#/storage/volumes",
  "pool.unreachable": "#/storage/volumes",
  "host.offline": "#/settings/hosts",
  "host.disk_low": "#/settings/hosts",
  "host.cpu_overcommit": "#/settings/hosts",
  "host.memory_overcommit": "#/settings/hosts",
  "host.forward_blocked": "#/settings/hosts",
});

/** The box tab, and the settings section on the settings tab, that shows each box condition. */
const TAB_OF = Object.freeze({
  "box.oom": ["activity"],
  "box.checkpoint_failed": ["settings", "checkpoints"],
  "box.rollback_pending": ["settings", "checkpoints"],
  "box.drift": ["settings", "resources"],
});

/** Where an attention item leads: the page of the storage or host it names, or the box's tab that shows the condition. */
export function attentionHref(item) {
  if (PAGE_OF[item.kind]) return PAGE_OF[item.kind];
  if (!item.box) return "#/boxes";
  const [tab = "overview", section] = TAB_OF[item.kind] ?? [];
  return boxHash(item.box.id, tab, section);
}

/**
 * The dictionary key and parameters that word an attention item, or null for a kind this console does not know. `bytes`
 * formats the byte counts of a volume or of a host's booked memory, and `cpus` formats its CPU cores.
 */
export function attentionText(item, { bytes = String, cpus = String } = {}) {
  const p = item.params;
  switch (item.kind) {
    case "box.oom":
      return { key: "ov.text.oom", params: {} };
    case "box.checkpoint_failed":
      return p.detail
        ? { key: "ov.text.checkpoint_failed_detail", params: { detail: p.detail } }
        : { key: "ov.text.checkpoint_failed", params: {} };
    case "box.drift":
      return { key: "ov.text.drift", params: { fields: p.fields } };
    case "box.rollback_pending":
      return { key: "ov.text.rollback_pending", params: { checkpoint: p.checkpoint } };
    case "volume.over_limit":
      return {
        key: p.action === "stop" ? "ov.text.over_limit_stop" : "ov.text.over_limit_warn",
        params: { used: bytes(p.used), limit: bytes(p.limit) },
      };
    case "pool.unreachable":
      return p.detail
        ? { key: "ov.text.pool_unreachable_detail", params: { detail: p.detail } }
        : { key: "ov.text.pool_unreachable", params: {} };
    case "host.offline":
      return { key: "ov.text.host_offline", params: {} };
    case "host.disk_low":
      return { key: "ov.text.disk_low", params: { free: p.free, min: p.min } };
    case "host.cpu_overcommit":
      return { key: "ov.text.cpu_overcommit", params: { booked: cpus(p.booked), limit: cpus(p.limit) } };
    case "host.memory_overcommit":
      return { key: "ov.text.memory_overcommit", params: { booked: bytes(p.booked), limit: bytes(p.limit) } };
    case "host.forward_blocked": {
      // The row says which kind of drop it is, because only one of the four comes with a button.
      const key =
        {
          policy: "ov.text.forward_blocked",
          rule: "ov.text.forward_blocked_rule",
          unreachable: "ov.text.forward_blocked_unreachable",
        }[p.cause] ?? "ov.text.forward_blocked_unclear";
      return { key, params: { count: p.count, boxes: p.boxes, bridge: p.bridge } };
    }
    default:
      return null;
  }
}

/** How long the page waits before it reads again: sooner while a command runs, since its output changes as it goes. */
export function pollDelay(overview) {
  if (overview.inProgress.some((row) => row.command?.running)) return RUNNING_MS;
  return overview.inProgress.length > 0 ? ACTIVE_MS : IDLE_MS;
}

/** The in-progress row of each box, by box id. A box has one row, so the lookup is exact. */
export function activityByBox(inProgress) {
  return new Map(inProgress.map((row) => [row.box.id, row]));
}

/** The items on one host, or every item when `host` is empty. */
export function scopeToHost(items, host, hostOf) {
  return host ? items.filter((item) => hostOf(item) === host) : items;
}
