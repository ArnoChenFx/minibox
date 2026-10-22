import { notifyPath, readSecretFile, SECRET_FILE_MODE, writeFileAtomic } from "../data-dir";
import type { SecretStore } from "../secrets/store";
import { NotifyFileSchema, type StoredChannel } from "./types";

/** The file cannot be used as it is. The message names the file so the operator can fix or remove it. */
export class NotifyFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotifyFileError";
  }
}

export interface NotifyStoreOptions {
  /** Holds the channel secrets, one per channel id, under `secrets/notify`. */
  readonly secrets: SecretStore;
  /** Called with every secret value, so the redactor keeps it out of events and logs. */
  readonly onSecret: (value: string) => void;
}

/**
 * The secret name that holds a webhook channel's URL. A channel id has no dot, so it never meets a channel's own secret.
 */
const urlSecret = (id: string) => `${id}.url`;

/**
 * Notification channels: `DATA_DIR/notify.json` holds their settings and never a secret, and each secret is a file under
 * `secrets/notify`, the same format as the host secrets. A webhook URL is kept there too, because Slack, Discord and
 * similar hooks carry their token in the URL. The file is read once at startup and kept in memory, so a notice is
 * matched without I/O.
 */
export class NotifyStore {
  private readonly channels = new Map<string, StoredChannel>();

  constructor(
    private readonly dataDir: string,
    private readonly options: NotifyStoreOptions,
  ) {}

  /** Reads the channels. A file that exists but does not match the format is an error, never an empty list. */
  load(): void {
    const path = notifyPath(this.dataDir);
    const text = readSecretFile(path);
    if (text === null) return;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new NotifyFileError(`${path} is not valid JSON (${String(e)}). Fix or remove it.`);
    }
    const parsed = NotifyFileSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? issue.path.join(".") : "the file";
      throw new NotifyFileError(`${path} does not match the notification format at ${where}. Fix or remove it.`);
    }
    let inline = false;
    for (const channel of parsed.data.channels) {
      if (this.channels.has(channel.id)) {
        throw new NotifyFileError(`${path} lists channel ${channel.id} more than once. Fix or remove it.`);
      }
      // A URL written into the file by hand is moved under secrets/notify on the next write.
      const stored = this.options.secrets.value(urlSecret(channel.id));
      if (channel.url !== null) {
        inline = true;
        if (channel.type === "webhook" && stored === null) {
          this.options.secrets.set(urlSecret(channel.id), channel.url, new Date().toISOString());
        }
      }
      const url = channel.type === "webhook" ? (stored ?? channel.url) : null;
      this.channels.set(channel.id, { ...channel, url } as StoredChannel);
      const secret = this.secret(channel.id);
      if (secret !== null) this.options.onSecret(secret);
    }
    if (inline) this.write();
  }

  list(): StoredChannel[] {
    return [...this.channels.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): StoredChannel | undefined {
    return this.channels.get(id);
  }

  /**
   * Adds or replaces a channel's settings and writes the file. A webhook URL goes under `secrets/notify`, never into the
   * file. The channel's secret is changed separately.
   */
  save(channel: StoredChannel): void {
    if (channel.url !== null) {
      this.options.secrets.set(urlSecret(channel.id), channel.url, new Date().toISOString());
    } else {
      this.options.secrets.remove(urlSecret(channel.id));
    }
    this.channels.set(channel.id, channel);
    this.write();
  }

  /** Removes a channel's settings and its secret. Returns false when there was no such channel. */
  remove(id: string): boolean {
    if (!this.channels.delete(id)) return false;
    this.options.secrets.remove(id);
    this.options.secrets.remove(urlSecret(id));
    this.write();
    return true;
  }

  hasSecret(id: string): boolean {
    return this.options.secrets.meta(id) !== null;
  }

  /** The channel's secret, or null when it has none. Only a send reads it. */
  secret(id: string): string | null {
    return this.options.secrets.value(id);
  }

  setSecret(id: string, value: string): void {
    this.options.secrets.set(id, value, new Date().toISOString());
    this.options.onSecret(value);
  }

  /** Removes the channel's secret. Returns false when it had none. */
  removeSecret(id: string): boolean {
    return this.options.secrets.remove(id);
  }

  private write(): void {
    const body = { version: 1, channels: this.list().map((channel) => ({ ...channel, url: null })) };
    writeFileAtomic(notifyPath(this.dataDir), `${JSON.stringify(body, null, 2)}\n`, SECRET_FILE_MODE);
  }
}
