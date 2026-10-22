import { createHmac } from "node:crypto";

import { type Notice, NOTICE_KINDS, type StoredChannel } from "./types";

export interface Outgoing {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface Envelope {
  /** The delivery's id, sent so a receiver can tell a retry from a new notice. */
  readonly id: string;
  readonly version: string;
  /** Seconds since the epoch, covered by the webhook signature. */
  readonly timestamp: number;
  readonly telegramBase: string;
}

/** Whether a channel is sent a notice: it is enabled, subscribes to the kind, and the box filter, if any, matches. */
export function subscribes(channel: StoredChannel, notice: Notice): boolean {
  if (!channel.enabled) return false;
  if (!(channel.events as readonly string[]).includes(notice.kind)) return false;
  if (channel.boxes.length === 0 || notice.box === undefined) return true;
  const { name, ids } = notice.box;
  return channel.boxes.some((selector) => selector === name || ids.includes(selector));
}

/**
 * The HTTP request that delivers a notice on a channel. The secret is the webhook signing key, the ntfy access token or
 * the Telegram bot token, and it is never copied into the body of a webhook.
 */
export function outgoingFor(
  channel: StoredChannel,
  secret: string | null,
  notice: Notice,
  envelope: Envelope,
): Outgoing {
  const text = notice.body ? `${notice.title}\n${notice.body}` : notice.title;
  const common = { "user-agent": `MiniBox/${envelope.version}`, "x-minibox-delivery": envelope.id };
  switch (channel.type) {
    case "webhook":
      return webhookRequest(channel.url ?? "", secret, notice, envelope, common);
    case "ntfy": {
      const headers: Record<string, string> = {
        ...common,
        "content-type": "text/plain; charset=utf-8",
        title: asciiLine(notice.title),
        priority: String(NOTICE_KINDS[notice.kind as keyof typeof NOTICE_KINDS]?.priority ?? 3),
      };
      const tag = NOTICE_KINDS[notice.kind as keyof typeof NOTICE_KINDS]?.tag;
      if (tag) headers.tags = tag;
      if (secret) headers.authorization = `Bearer ${secret}`;
      return { url: `${(channel.server ?? "").replace(/\/+$/, "")}/${channel.topic ?? ""}`, headers, body: text };
    }
    case "telegram": {
      if (!secret) throw new Error("the Telegram channel has no bot token");
      const body = JSON.stringify({ chat_id: channel.chatId, text, disable_web_page_preview: true });
      return {
        url: `${envelope.telegramBase}/bot${secret}/sendMessage`,
        headers: { ...common, "content-type": "application/json" },
        body,
      };
    }
  }
}

function webhookRequest(
  url: string,
  secret: string | null,
  notice: Notice,
  envelope: Envelope,
  common: Record<string, string>,
): Outgoing {
  const body = JSON.stringify({
    id: envelope.id,
    kind: notice.kind,
    title: notice.title,
    body: notice.body ?? null,
    box: notice.box?.name ?? null,
    host: notice.host ?? null,
    at: new Date(notice.at).toISOString(),
  });
  const headers: Record<string, string> = {
    ...common,
    "content-type": "application/json",
    "x-minibox-event": notice.kind,
    "x-minibox-timestamp": String(envelope.timestamp),
  };
  if (secret) headers["x-minibox-signature"] = `sha256=${signature(secret, envelope.timestamp, body)}`;
  return { url, headers, body };
}

/** HMAC-SHA256 over `timestamp.body`. A receiver recomputes it, and rejects a timestamp too far from its clock. */
export function signature(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** HTTP header values are read as Latin-1, so a title is reduced to printable ASCII. The body keeps its text. */
function asciiLine(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, "?");
}
