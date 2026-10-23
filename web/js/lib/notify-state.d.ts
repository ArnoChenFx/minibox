export declare const NOTICE_KINDS: readonly [
  "box.oom",
  "exec.failed",
  "checkpoint.failed",
  "box.ttl_soon",
  "box.idle_soon",
  "session.takeover",
  "agent.question",
  "host.offline",
  "volume.usage_high",
  "volume.usage_limit",
  "host.disk_low",
];

export declare const CHANNEL_TYPES: readonly ["webhook", "ntfy", "telegram"];

export declare const TYPE_FIELDS: Readonly<Record<string, readonly string[]>>;

export declare const CHANNEL_ID_RE: RegExp;

export interface ChannelForm {
  type: string;
  name: string;
  enabled?: boolean;
  events?: readonly string[];
  boxes?: string | null;
  url?: string | null;
  server?: string | null;
  topic?: string | null;
  chatId?: string | null;
  secret?: string | null;
  clearSecret?: boolean;
}

export interface ChannelBody {
  type: string;
  name: string;
  enabled: boolean;
  events: string[];
  boxes: string[];
  url?: string;
  server?: string;
  topic?: string;
  chatId?: string;
  secret?: string | null;
}

export interface Failure {
  key: string;
  params: Record<string, number>;
}

export declare function parseBoxes(text: string | null | undefined): string[];
export declare function channelBody(form: ChannelForm): ChannelBody;
export declare function failureOf(code: string | null | undefined): Failure | null;
