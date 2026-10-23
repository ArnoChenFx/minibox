import { z } from "zod";

/**
 * The notices MiniBox sends on its own. A channel subscribes to some of them by kind. A feature that raises its own
 * notices (volume usage, an agent's question) adds its kind here, and then channels can subscribe to it.
 */
export const NOTICE_KINDS = {
  "box.oom": { summary: "A box ran out of memory and stopped.", priority: 4, tag: "warning" },
  "exec.failed": { summary: "A command in a box failed or timed out.", priority: 3, tag: "x" },
  "checkpoint.failed": { summary: "A checkpoint failed, scheduled or taken by hand.", priority: 4, tag: "warning" },
  "box.ttl_soon": { summary: "A box's TTL is about to end, so it will stop.", priority: 3, tag: "hourglass" },
  "box.idle_soon": { summary: "A box is about to sleep for being idle.", priority: 3, tag: "zzz" },
  "session.takeover": { summary: "A person took over an agent's terminal session.", priority: 3, tag: "eyes" },
  "agent.question": { summary: "A box's agent asked a person a question.", priority: 4, tag: "question" },
  "host.offline": { summary: "A host stopped answering.", priority: 4, tag: "warning" },
  "volume.usage_high": {
    summary: "A volume passed its soft usage limit. The limit is best effort, not a quota.",
    priority: 3,
    tag: "chart_with_upwards_trend",
  },
  "volume.usage_limit": {
    summary: "A volume is over its hard usage limit. Boxes set to stop on it are stopped.",
    priority: 4,
    tag: "warning",
  },
  "host.disk_low": {
    summary: "A host's disk is below its free-space minimum, so it refuses new volumes and checkpoints.",
    priority: 4,
    tag: "warning",
  },
} as const;

export type NoticeKind = keyof typeof NOTICE_KINDS;
export const NOTICE_KIND_NAMES = Object.keys(NOTICE_KINDS) as [NoticeKind, ...NoticeKind[]];

/** The kind of the message a test sends. It is not a subscribable kind, so no channel's filter selects it. */
export const TEST_KIND = "notify.test";

export const CHANNEL_TYPES = ["webhook", "ntfy", "telegram"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const CHANNEL_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const CHANNEL_LIMIT = 32;
export const BOX_FILTER_MAX = 32;

/** A channel as `notify.json` holds it. The secret of a channel is kept apart, under `secrets/notify`. */
export interface StoredChannel {
  readonly id: string;
  readonly type: ChannelType;
  readonly name: string;
  readonly enabled: boolean;
  readonly events: readonly NoticeKind[];
  /** Box names or stable ids. Empty means every box. Notices about a host are never filtered by it. */
  readonly boxes: readonly string[];
  /** The webhook URL. Null for the other types. */
  readonly url: string | null;
  /** The ntfy server, such as https://ntfy.sh. Null for the other types. */
  readonly server: string | null;
  readonly topic: string | null;
  /** The Telegram chat id, such as -1001234567890 or @alerts. Null for the other types. */
  readonly chatId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const StoredChannelSchema = z
  .object({
    id: z.string().regex(CHANNEL_ID_RE),
    type: z.enum(CHANNEL_TYPES),
    name: z.string().min(1).max(64),
    enabled: z.boolean(),
    events: z.array(z.enum(NOTICE_KIND_NAMES)).min(1),
    boxes: z.array(z.string().min(1).max(128)).max(BOX_FILTER_MAX),
    url: z.string().max(2048).nullable(),
    server: z.string().max(2048).nullable(),
    topic: z.string().max(64).nullable(),
    chatId: z.string().max(64).nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

/** `notify.json` as a whole. A file that does not match it stops startup, as `hosts.json` does. */
export const NotifyFileSchema = z.object({ version: z.literal(1), channels: z.array(StoredChannelSchema) }).strict();

/** The box an event is about. `ids` holds every stable id it is known by, so a filter can name the box either way. */
export interface NoticeBox {
  readonly name: string;
  readonly ids: readonly string[];
}

/** One thing to tell a person. Its title and body are plain text: no command output and no secret ever goes in. */
export interface Notice {
  readonly kind: string;
  readonly title: string;
  readonly body?: string;
  readonly box?: NoticeBox;
  readonly host?: string;
  /** Notices with the same key are sent once per channel within the dedup window. Defaults to the kind and its box or host. */
  readonly dedupKey?: string;
  /** Epoch milliseconds at which the thing happened. */
  readonly at: number;
}
