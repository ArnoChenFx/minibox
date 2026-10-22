# Notifications

MiniBox can tell you about a problem without you watching the console. It sends a short message to a **webhook**, an **ntfy** topic or a **Telegram** chat when a box runs out of memory, a command fails, a box is about to stop or sleep, a terminal session is taken over, or a host goes offline.

Only the owner sets up notifications, in **Settings**, under **Notifications**. A failed send never stops the action that caused it.

## What is sent

| Notice | Sent when |
|---|---|
| `box.oom` | A box ran out of memory and stopped. |
| `exec.failed` | A command in a box exited with a non-zero code, or timed out. |
| `checkpoint.failed` | A checkpoint failed on the server, whether it was scheduled or taken by hand. A refusal, such as a full repository, does not send one. |
| `box.ttl_soon` | A box's TTL ends within 5 minutes, so the box will stop. |
| `box.idle_soon` | A box will sleep for being idle within 5 minutes. |
| `session.takeover` | A person took over an agent's terminal session. |
| `host.offline` | A host that was online stopped answering. A host that is already down when MiniBox starts does not send one. |

Volume usage alerts and questions from agents are not sent yet.

## Set up a channel

1. Open **Settings**, find **Notifications** and choose **Add channel**.
2. Enter a **Name** and an **Id**. The id uses lowercase letters, digits and hyphens, starts with a letter, and cannot be changed later.
3. Choose the **Type**, Webhook, ntfy or Telegram, and fill in its fields. See [Channel types](#channel-types).
4. Choose the **Notices to send**. A new channel gets all of them.
5. Optionally limit the channel to some **Boxes**, by name or id, separated by commas or new lines. Leave it blank for every box. Host notices always reach the channel.
6. Choose **Save channel**, then **Send test** in the channel's row. The result appears on the screen at once.

A channel with **Send to this channel** turned off keeps its settings and sends nothing.

## Channel types

### Webhook

MiniBox sends each notice as an HTTP `POST` with a JSON body to the URL you give, over `http` or `https`:

```json
{
  "id": "01J…",
  "kind": "box.oom",
  "title": "Box ran out of memory: demo",
  "body": null,
  "box": "demo",
  "host": null,
  "at": "2026-10-22T08:15:00.000Z"
}
```

Each request also carries these headers:

| Header | Value |
|---|---|
| `x-minibox-event` | The notice kind, such as `box.oom` |
| `x-minibox-timestamp` | When the notice was sent, in Unix seconds |
| `x-minibox-delivery` | The delivery id. A retry keeps the same id, so a receiver can drop duplicates. |
| `user-agent` | `MiniBox/<version>` |

When the channel has a **signing secret**, each request also carries `x-minibox-signature: sha256=<hex>`. The hex value is the HMAC-SHA256 of the timestamp, a dot and the raw body, keyed with the secret. To check it, recompute the value from the body exactly as it arrived, compare in constant time, and reject a timestamp that is far from your clock so an old request cannot be replayed:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
const expected = `sha256=${digest}`;
const valid = expected.length === received.length && timingSafeEqual(Buffer.from(expected), Buffer.from(received));
```

### ntfy

MiniBox posts the notice to `<server>/<topic>`. The **ntfy server** defaults to `https://ntfy.sh`. The text is the title, then a new line and the body. The title is sent in a header, which allows only printable ASCII, so other characters appear as `?`. Each notice has a priority: 4 for `box.oom`, `checkpoint.failed` and `host.offline`, and 3 for the others. It also has a tag that matches the notice, such as `warning` or `zzz`.

Anyone who knows the topic can read it, so choose a name that is hard to guess. If the topic needs a token, give it as the **Access token**. MiniBox sends it as `Authorization: Bearer`.

### Telegram

Create a bot with @BotFather and give its token as the **Bot token**. Give the **Chat id**: a number such as `-1001234567890` for a group or channel, or a channel name such as `@alerts`. The bot must be a member of the chat. MiniBox calls the Bot API `sendMessage` method, and turns link previews off.

## Delivery

- **Non-blocking.** A notice is queued and sent in the background, so the action that caused it does not wait. Up to 4 sends run at once, and up to 256 notices can wait. Beyond that, a notice is recorded as failed with `queue_full`.
- **Timeout.** Each attempt gives up after 10 seconds, including the name lookup.
- **Retries.** A send is tried up to 3 times, with a wait of 1 second and then 2 seconds between tries. Only timeouts, network and DNS failures, and HTTP `429` and `5xx` answers are retried. Other answers, such as `404`, fail at once. Redirects are not followed, so a `3xx` answer is a failure.
- **Repeats.** The same notice about the same box or host is not sent again on the same channel for 5 minutes.
- **Queued notices are not saved.** A restart drops the notices that were not sent yet.

## Delivery history

The Notifications card lists the 20 latest attempts: when, channel, notice, result and attempts. A failed attempt shows its reason:

| Reason | Meaning |
|---|---|
| `timeout` | No answer within 10 seconds |
| `network` | The connection failed |
| `dns_failed` | The host name did not resolve |
| `blocked_address` | The address is not public. See [Private addresses](#private-addresses). |
| `bad_url` | The address is not valid |
| `http_<status>` | The channel answered with that HTTP status |
| `queue_full` | Too many notices were waiting to be sent |
| `unexpected` | An unexpected error. The server log records the channel and the error type. |

Every attempt is also recorded in the event log as `notify.deliver`, so it is kept for the audit retention period, 365 days by default. The record holds the channel, the notice, the attempts, the HTTP status and the reason. It never holds a secret or a URL.

## Private addresses

By default MiniBox sends only to public addresses. It refuses loopback, private network, link-local, shared and reserved addresses, so a channel cannot reach services on your machine or your local network. To send to a self-hosted ntfy server or to a webhook on your network, set `NOTIFY_ALLOW_PRIVATE=true`. The setting applies to every channel. See [Configuration](../reference/configuration.md#notifications).

## Limits and privacy

- A server holds up to 32 channels.
- A notice's title is at most 200 characters, and its body at most 500.
- A notice carries no command output and no secret value. Known secrets are removed from its text before it is sent.
- A channel's signing secret, ntfy token or bot token is stored in `DATA_DIR/secrets/notify/<channel id>`, with mode 600. It is never shown again after you save it.
- A channel's other settings are stored in `DATA_DIR/notify.json`, also with mode 600. That includes the webhook URL, the ntfy server and topic, and the Telegram chat id. Some chat services put a token in the webhook URL. Such a URL is kept in that file, so keep the data directory private. See [Data directory](../admin/data-directory.md).
- Only the owner can see or change channels. Agent tokens cannot.

## Manage channels through the API

Channels can also be listed, changed, tested and deleted through the [REST API](../reference/api.md#notify) and the [MCP tools](../reference/mcp.md#meta), such as `list_notify_channels` and `set_notify_channel`. The CLI has no notification commands yet.
