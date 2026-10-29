import { z } from "zod";

import type { StoredEvent } from "../events/store";
import { badRequest, conflict, notFound } from "../lib/errors";
import { type MessageKey, msg } from "../lib/messages";
import { accept, type Checked, reject } from "../lib/validation";
import type { Notifications } from "../notify/service";
import type { NotifyStore } from "../notify/store";
import {
  BOX_FILTER_MAX,
  CHANNEL_ID_RE,
  CHANNEL_LIMIT,
  CHANNEL_TYPES,
  type ChannelType,
  NOTICE_KIND_NAMES,
  type NoticeKind,
  type StoredChannel,
} from "../notify/types";
import { defineOperation } from "./define";
import { checkLimit, EVENT_LIMIT } from "./events";
import type { OperationContext } from "./types";
import { field } from "./validation";

/** Notification channels are the owner's alone: no token holds this scope, so an agent never reads or changes one. */
const NOTIFY_SCOPE = "notify:manage";
const NTFY_SERVER = "https://ntfy.sh";
const NAME_MAX = 64;
const BOX_LABEL_MAX = 128;
const URL_MAX = 2048;
const SECRET_MIN = 8;
const SECRET_MAX = 512;
const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CHAT_RE = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
const CONTROL = /\p{Cc}/u;

const ChannelSchema = z.object({
  id: z.string(),
  type: z.enum(CHANNEL_TYPES),
  name: z.string(),
  enabled: z.boolean(),
  events: z.array(z.enum(NOTICE_KIND_NAMES)).meta({ description: "The notices this channel is sent." }),
  boxes: z
    .array(z.string())
    .meta({ description: "Box names or ids the channel is limited to. Empty means every box." }),
  url: z.string().nullable().meta({
    description:
      "The webhook URL with its path and query masked, such as https://hooks.example.com/…, because a hook URL can carry a token. The full URL is never returned. Null for the other types.",
  }),
  server: z.string().nullable().meta({ description: "The ntfy server. Null for the other types." }),
  topic: z.string().nullable().meta({ description: "The ntfy topic. Null for the other types." }),
  chatId: z.string().nullable().meta({ description: "The Telegram chat id or channel. Null for the other types." }),
  hasSecret: z.boolean().meta({
    description:
      "Whether a secret is stored: the webhook signing key, the ntfy access token or the Telegram bot token. The value is never returned.",
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type ChannelView = z.output<typeof ChannelSchema>;

const ValueChangeSchema = z
  .enum(["set", "cleared", "kept"])
  .meta({ description: "What happened to the stored secret: set to a new value, cleared, or kept as it was." });

const DeliverySchema = z.object({
  id: z.string().meta({ description: "The delivery id. A webhook receiver gets it as the x-minibox-delivery header." }),
  ts: z.number().int().meta({ description: "When the delivery finished, as epoch milliseconds." }),
  status: z.enum(["ok", "error"]),
  channel: z.string().nullable(),
  type: z.string().nullable(),
  notice: z.string().nullable().meta({ description: "The notice kind that was sent, such as box.oom." }),
  title: z.string().nullable(),
  attempts: z.number().int().nullable(),
  httpStatus: z.number().int().nullable(),
  error: z.string().nullable().meta({ description: "Why the delivery failed, such as timeout or http_500." }),
});

type DeliveryView = z.output<typeof DeliverySchema>;

const TestSchema = z.object({
  ok: z.boolean(),
  status: z
    .number()
    .int()
    .nullable()
    .meta({ description: "The HTTP status the channel answered with, if it answered." }),
  attempts: z.number().int(),
  error: z.string().nullable(),
});

function isNoticeKind(value: unknown): value is NoticeKind {
  return typeof value === "string" && (NOTICE_KIND_NAMES as readonly string[]).includes(value);
}

function isChannelType(value: unknown): value is ChannelType {
  return typeof value === "string" && (CHANNEL_TYPES as readonly string[]).includes(value);
}

function checkChannelId(value: unknown): Checked<string> {
  return typeof value === "string" && CHANNEL_ID_RE.test(value)
    ? accept(value)
    : reject(msg("notify_channel_id_invalid"), "id");
}

function checkType(value: unknown): Checked<ChannelType> {
  return isChannelType(value) ? accept(value) : reject(msg("notify_type_invalid"), "type");
}

function checkName(value: unknown): Checked<string> {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "" || [...text].length > NAME_MAX || CONTROL.test(text)) {
    return reject(msg("notify_name_invalid"), "name");
  }
  return accept(text);
}

function checkEnabled(value: unknown): Checked<boolean> {
  if (value === undefined || value === null) return accept(true);
  return typeof value === "boolean" ? accept(value) : reject(msg("not_boolean", { field: "enabled" }), "enabled");
}

function checkEvents(value: unknown): Checked<NoticeKind[]> {
  if (!Array.isArray(value) || value.length === 0) return reject(msg("notify_events_invalid"), "events");
  const kinds: NoticeKind[] = [];
  for (const item of value) {
    if (!isNoticeKind(item) || kinds.includes(item)) return reject(msg("notify_events_invalid"), "events");
    kinds.push(item);
  }
  return accept(kinds);
}

const invalidBoxes = (): Checked<never> => reject(msg("notify_boxes_invalid", { max: BOX_FILTER_MAX }), "boxes");

function checkBoxes(value: unknown): Checked<string[]> {
  if (value === undefined || value === null) return accept([]);
  if (!Array.isArray(value) || value.length > BOX_FILTER_MAX) return invalidBoxes();
  const boxes: string[] = [];
  for (const item of value) {
    const box = typeof item === "string" ? item.trim() : "";
    if (box === "" || [...box].length > BOX_LABEL_MAX || CONTROL.test(box)) return invalidBoxes();
    if (!boxes.includes(box)) boxes.push(box);
  }
  return accept(boxes);
}

function isHttpUrl(text: string): boolean {
  if (text.length > URL_MAX || /[\p{Cc}\s]/u.test(text)) return false;
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/** An optional text field: blank or null is absent, and a value that is present must pass `valid`. */
function checkOptionalText(
  value: unknown,
  valid: (text: string) => boolean,
  message: MessageKey,
  name: string,
): Checked<string | undefined> {
  if (value === undefined || value === null || value === "") return accept(undefined);
  const text = typeof value === "string" ? value.trim() : "";
  return text !== "" && valid(text) ? accept(text) : reject(msg(message), name);
}

/**
 * The channel's secret: the webhook signing key, the ntfy token or the Telegram bot token. Omitted keeps the stored one,
 * null clears it, and a string replaces it. The value is never copied into an answer or an event.
 */
const invalidSecret = (): Checked<never> => reject(msg("notify_secret_invalid"), "secret");

function checkSecret(value: unknown): Checked<string | null | undefined> {
  if (value === undefined || value === null) return accept(value);
  if (typeof value !== "string") return invalidSecret();
  const length = [...value].length;
  return length < SECRET_MIN || length > SECRET_MAX || CONTROL.test(value) ? invalidSecret() : accept(value);
}

const channelId = () =>
  field(checkChannelId, {
    type: "string",
    minLength: 1,
    maxLength: 32,
    pattern: CHANNEL_ID_RE.source,
    description: "Channel id: lowercase letters, digits and hyphens, starting with a letter.",
  });

const ChannelInput = z.object({
  id: channelId(),
  type: field(checkType, {
    type: "string",
    enum: [...CHANNEL_TYPES],
    description: "webhook posts JSON, ntfy sends to a topic, telegram sends through a bot to a chat.",
  }),
  name: field(checkName, { type: "string", maxLength: NAME_MAX, description: "Name shown in the list." }),
  enabled: field(checkEnabled, {
    type: "boolean",
    description: "Whether the channel sends. A disabled channel keeps its settings. Defaults to true.",
  }).default(true),
  events: field(checkEvents, {
    type: "array",
    minItems: 1,
    uniqueItems: true,
    items: { type: "string", enum: [...NOTICE_KIND_NAMES] },
    description: "The notices to send, at least one. Each is a kind such as box.oom or host.offline.",
  }),
  boxes: field(checkBoxes, {
    type: "array",
    maxItems: BOX_FILTER_MAX,
    items: { type: "string", minLength: 1, maxLength: BOX_LABEL_MAX },
    description:
      "Box names or ids to limit the channel to. Omitted or empty means every box. Host notices are never limited by it.",
  }).optional(),
  url: field((value) => checkOptionalText(value, isHttpUrl, "notify_url_invalid", "url"), {
    type: "string",
    maxLength: URL_MAX,
    description:
      "Webhook URL, http or https, without a user name or password. Used by webhook channels. Stored as a secret and never returned in full; omitted on a change, the stored URL is kept.",
  }).optional(),
  server: field((value) => checkOptionalText(value, isHttpUrl, "notify_server_invalid", "server"), {
    type: "string",
    maxLength: URL_MAX,
    description: `ntfy server, http or https. Omitted, ${NTFY_SERVER} is used. Used by ntfy channels.`,
  }).optional(),
  topic: field((value) => checkOptionalText(value, (text) => TOPIC_RE.test(text), "notify_topic_invalid", "topic"), {
    type: "string",
    maxLength: 64,
    pattern: TOPIC_RE.source,
    description: "ntfy topic: letters, digits, underscores and hyphens. Used by ntfy channels.",
  }).optional(),
  chatId: field((value) => checkOptionalText(value, (text) => CHAT_RE.test(text), "notify_chat_invalid", "chatId"), {
    type: "string",
    maxLength: 64,
    description:
      "Telegram chat id, such as -1001234567890, or a channel name such as @alerts. Used by telegram channels.",
  }).optional(),
  secret: field(checkSecret, {
    type: "string",
    minLength: SECRET_MIN,
    maxLength: SECRET_MAX,
    description:
      "The channel's secret: a webhook signing key, an ntfy access token or a Telegram bot token. Omitted keeps the stored value, null clears it. Never returned.",
  }).optional(),
});

type ChannelInputValue = z.output<typeof ChannelInput>;

const ChannelSetOutput = z.object({
  channel: ChannelSchema,
  created: z.boolean().meta({ description: "True when the channel is new, false when its settings were replaced." }),
  valueChange: ValueChangeSchema,
});

function notifierOf(ctx: OperationContext): Notifications {
  if (!ctx.notify) throw new Error("the notification service is not running");
  return ctx.notify;
}

function requireChannel(ctx: OperationContext, id: string): StoredChannel {
  const channel = notifierOf(ctx).store.get(id);
  if (!channel) throw notFound(msg("notify_channel_not_found", { channel: id }));
  return channel;
}

/** A webhook URL as answers show it: the origin, and an ellipsis where a path or query was. */
function maskedUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    const rest = parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "";
    return rest ? `${parsed.origin}/…` : parsed.origin;
  } catch {
    return "…";
  }
}

function viewOf(store: NotifyStore, channel: StoredChannel): ChannelView {
  return {
    ...channel,
    url: maskedUrl(channel.url),
    events: [...channel.events],
    boxes: [...channel.boxes],
    hasSecret: store.hasSecret(channel.id),
  };
}

/**
 * The settings a channel of this type keeps. Fields that belong to another type are not stored. A webhook write that
 * omits the URL keeps the stored one, since answers never show it in full.
 */
function endpointsOf(
  input: ChannelInputValue,
  existing: StoredChannel | null,
): Pick<StoredChannel, "url" | "server" | "topic" | "chatId"> {
  switch (input.type) {
    case "webhook": {
      const url = input.url ?? (existing?.type === "webhook" ? existing.url : null);
      if (!url) throw badRequest(msg("notify_url_required"), { field: "url" });
      return { url, server: null, topic: null, chatId: null };
    }
    case "ntfy":
      if (!input.topic) throw badRequest(msg("notify_topic_required"), { field: "topic" });
      return { url: null, server: input.server ?? NTFY_SERVER, topic: input.topic, chatId: null };
    case "telegram":
      if (!input.chatId) throw badRequest(msg("notify_chat_required"), { field: "chatId" });
      return { url: null, server: null, topic: null, chatId: input.chatId };
  }
}

/** The audit names the server a channel sends to, never the path or query, which can carry a token. */
function auditedEndpoint(input: ChannelInputValue, existing: StoredChannel | null): string {
  if (input.type === "telegram") return "telegram";
  const address = input.type === "webhook" ? (input.url ?? existing?.url) : (input.server ?? NTFY_SERVER);
  try {
    return new URL(address ?? "").origin;
  } catch {
    return input.type;
  }
}

function saveChannel(
  notify: Notifications,
  input: ChannelInputValue,
  existing: StoredChannel | null,
): { channel: ChannelView; created: boolean; valueChange: "set" | "cleared" | "kept" } {
  const store = notify.store;
  if (existing === null && store.list().length >= CHANNEL_LIMIT) {
    throw conflict(msg("notify_channel_limit", { max: CHANNEL_LIMIT }));
  }
  const endpoints = endpointsOf(input, existing);
  const typeChanged = existing !== null && existing.type !== input.type;
  const keepsStored = input.secret === undefined && existing !== null && !typeChanged && store.hasSecret(input.id);
  if (input.type === "telegram" && typeof input.secret !== "string" && !keepsStored) {
    throw badRequest(msg("notify_secret_required"), { field: "secret" });
  }
  let valueChange: "set" | "cleared" | "kept";
  if (typeof input.secret === "string") {
    store.setSecret(input.id, input.secret);
    valueChange = "set";
  } else if (keepsStored) {
    valueChange = "kept";
  } else {
    valueChange = store.removeSecret(input.id) ? "cleared" : "kept";
  }
  const now = new Date().toISOString();
  const channel: StoredChannel = {
    id: input.id,
    type: input.type,
    name: input.name,
    enabled: input.enabled,
    events: input.events,
    boxes: input.boxes ?? [],
    ...endpoints,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  store.save(channel);
  return { channel: viewOf(store, channel), created: existing === null, valueChange };
}

const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);
const countOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null);

function deliveryOf(event: StoredEvent): DeliveryView {
  const detail =
    typeof event.detail === "object" && event.detail !== null ? (event.detail as Record<string, unknown>) : {};
  return {
    id: textOrNull(detail.delivery) ?? event.id,
    ts: event.ts,
    status: event.status === "ok" ? "ok" : "error",
    channel: textOrNull(detail.channel),
    type: textOrNull(detail.type),
    notice: textOrNull(detail.notice),
    title: textOrNull(detail.title),
    attempts: countOrNull(detail.attempts),
    httpStatus: countOrNull(detail.httpStatus),
    error: textOrNull(detail.error),
  };
}

const notifyChannelList = defineOperation({
  name: "notify.channel.list",
  tag: "notify",
  summary: "List notification channels",
  kind: "read",
  scope: NOTIFY_SCOPE,
  async: false,
  input: z.object({}),
  output: z.object({ channels: z.array(ChannelSchema) }),
  rest: [{ method: "GET", path: "/api/notify/channels" }],
  mcp: {
    toolset: "meta",
    name: "list_notify_channels",
    description:
      "List the notification channels: their type, the notices they take, the box filter and whether a secret is stored. Secret values are never returned. Owner only.",
  },
  run: async (ctx) => {
    const { store } = notifierOf(ctx);
    return { channels: store.list().map((channel) => viewOf(store, channel)) };
  },
});

const notifyChannelSet = defineOperation({
  name: "notify.channel.set",
  tag: "notify",
  summary: "Create or change a notification channel",
  kind: "write",
  scope: NOTIFY_SCOPE,
  async: false,
  conflicts: true,
  input: ChannelInput,
  output: ChannelSetOutput,
  rest: [{ method: "PUT", path: "/api/notify/channels/:id", body: true }],
  mcp: {
    toolset: "meta",
    name: "set_notify_channel",
    description:
      "Create or change a notification channel: a webhook, an ntfy topic or a Telegram chat, the notices it takes and an optional box filter. The secret is stored apart and never returned; omit it to keep it, or send null to clear it. Owner only.",
  },
  resolve: async (ctx, input) => notifierOf(ctx).store.get(input.id) ?? null,
  activity: { action: () => "notify.channel.set", target: (input) => input.id },
  audit: {
    target: ({ id }, _resolved, result) => ({ kind: "notify", id, name: result?.channel.name ?? id }),
    detail: (input, resolved, result) => ({
      id: input.id,
      type: input.type,
      name: input.name,
      enabled: input.enabled,
      events: input.events,
      boxes: input.boxes ?? [],
      endpoint: auditedEndpoint(input, resolved ?? null),
      valueChange: result?.valueChange ?? null,
    }),
  },
  run: async (ctx, input, existing) => saveChannel(notifierOf(ctx), input, existing),
});

const notifyChannelDelete = defineOperation({
  name: "notify.channel.delete",
  tag: "notify",
  summary: "Delete a notification channel",
  kind: "destructive",
  scope: NOTIFY_SCOPE,
  async: false,
  input: z.object({ id: channelId() }),
  output: z.object({ id: z.string() }),
  rest: [{ method: "DELETE", path: "/api/notify/channels/:id" }],
  mcp: {
    toolset: "meta",
    name: "delete_notify_channel",
    description:
      "Delete a notification channel and its stored secret. Its delivery records stay in the event log. Owner only.",
  },
  resolve: async (ctx, input) => requireChannel(ctx, input.id),
  activity: { action: () => "notify.channel.delete", target: (input) => input.id },
  audit: {
    target: ({ id }, resolved) => ({ kind: "notify", id, name: resolved?.name ?? id }),
    detail: ({ id }) => ({ id }),
  },
  run: async (ctx, input) => {
    notifierOf(ctx).store.remove(input.id);
    return { id: input.id };
  },
});

const notifyChannelTest = defineOperation({
  name: "notify.channel.test",
  tag: "notify",
  summary: "Send a test notification",
  kind: "write",
  scope: NOTIFY_SCOPE,
  async: false,
  input: z.object({ id: channelId() }),
  output: TestSchema,
  rest: [{ method: "POST", path: "/api/notify/channels/:id/test" }],
  mcp: {
    toolset: "meta",
    name: "test_notify_channel",
    description:
      "Send one test notice to a channel and report whether the channel accepted it. A single attempt, with no retries. Owner only.",
  },
  resolve: async (ctx, input) => requireChannel(ctx, input.id),
  activity: { action: () => "notify.channel.test", target: (input) => input.id },
  audit: {
    target: ({ id }, resolved) => ({ kind: "notify", id, name: resolved?.name ?? id }),
    detail: ({ id }) => ({ id }),
  },
  run: async (ctx, input) => notifierOf(ctx).test(input.id, ctx.record),
});

const notifyDeliveryList = defineOperation({
  name: "notify.delivery.list",
  tag: "notify",
  summary: "List recent notification deliveries",
  kind: "read",
  scope: NOTIFY_SCOPE,
  async: false,
  input: z.object({
    limit: field(checkLimit, {
      type: "integer",
      minimum: 1,
      maximum: EVENT_LIMIT.max,
      description: `Deliveries to return, newest first, between 1 and ${EVENT_LIMIT.max}. Defaults to ${EVENT_LIMIT.default}.`,
    }).default(EVENT_LIMIT.default),
  }),
  output: z.object({ deliveries: z.array(DeliverySchema) }),
  rest: [{ method: "GET", path: "/api/notify/deliveries", query: ["limit"] }],
  mcp: {
    toolset: "meta",
    name: "list_notify_deliveries",
    description:
      "List the most recent notification deliveries, newest first: the channel, the notice, the attempts and whether each one succeeded. Owner only.",
  },
  run: async (ctx, input) => ({
    deliveries: ctx.events.list({ op: "notify.deliver" }, { limit: input.limit }).events.map(deliveryOf),
  }),
});

export const notifyOperations = [
  notifyChannelList,
  notifyChannelSet,
  notifyChannelDelete,
  notifyChannelTest,
  notifyDeliveryList,
];
