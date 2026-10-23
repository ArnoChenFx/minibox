import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { type Envelope, outgoingFor, signature, subscribes } from "../src/notify/channels";
import type { Notice, StoredChannel } from "../src/notify/types";

const AT = Date.UTC(2026, 9, 22, 10, 0, 0);

function channelOf(patch: Partial<StoredChannel> = {}): StoredChannel {
  return {
    id: "ops",
    type: "webhook",
    name: "Ops",
    enabled: true,
    events: ["box.oom", "exec.failed"],
    boxes: [],
    url: "https://hooks.example.com/minibox",
    server: null,
    topic: null,
    chatId: null,
    createdAt: "2026-10-22T09:00:00.000Z",
    updatedAt: "2026-10-22T09:00:00.000Z",
    ...patch,
  };
}

const oom: Notice = {
  kind: "box.oom",
  title: "Box ran out of memory: alpha",
  box: { name: "alpha", ids: ["bx_alpha", "cid-alpha"] },
  at: AT,
};

const hostDown: Notice = { kind: "host.offline", title: "Host h1 is offline", host: "h1", at: AT };

const envelope: Envelope = {
  id: "01JDELIVERY0000000000000A",
  version: "0.5.0",
  timestamp: 1_790_000_000,
  telegramBase: "https://api.telegram.org",
};

describe("which channels take a notice", () => {
  test("a disabled channel takes nothing, and a channel takes only the kinds it lists", () => {
    expect(subscribes(channelOf({ enabled: false }), oom)).toBe(false);
    expect(subscribes(channelOf({ events: ["exec.failed"] }), oom)).toBe(false);
    expect(subscribes(channelOf(), oom)).toBe(true);
  });

  test("an empty box filter takes every box, and a filter takes the boxes it names by name or by id", () => {
    expect(subscribes(channelOf({ boxes: [] }), oom)).toBe(true);
    expect(subscribes(channelOf({ boxes: ["alpha"] }), oom)).toBe(true);
    expect(subscribes(channelOf({ boxes: ["cid-alpha"] }), oom)).toBe(true);
    expect(subscribes(channelOf({ boxes: ["beta", "bx_other"] }), oom)).toBe(false);
  });

  test("a box filter never holds back a host notice, which is about no box", () => {
    expect(subscribes(channelOf({ events: ["host.offline"], boxes: ["alpha"] }), hostDown)).toBe(true);
  });
});

describe("webhook requests", () => {
  test("the body is the notice as JSON, and the headers name the event, the delivery and the time", () => {
    const request = outgoingFor(channelOf(), "signing-key-value", oom, envelope);
    expect(request.url).toBe("https://hooks.example.com/minibox");
    expect(JSON.parse(request.body)).toEqual({
      id: "01JDELIVERY0000000000000A",
      kind: "box.oom",
      title: "Box ran out of memory: alpha",
      body: null,
      box: "alpha",
      host: null,
      at: new Date(AT).toISOString(),
    });
    expect(request.headers).toMatchObject({
      "content-type": "application/json",
      "user-agent": "MiniBox/0.5.0",
      "x-minibox-event": "box.oom",
      "x-minibox-delivery": "01JDELIVERY0000000000000A",
      "x-minibox-timestamp": "1790000000",
    });
  });

  test("the signature is HMAC-SHA256 over the timestamp and the body, and the secret is not in the body", () => {
    const secret = "signing-key-value";
    const request = outgoingFor(channelOf(), secret, oom, envelope);
    const expected = createHmac("sha256", secret).update(`1790000000.${request.body}`).digest("hex");
    expect(request.headers["x-minibox-signature"]).toBe(`sha256=${expected}`);
    expect(request.body).not.toContain(secret);
    const otherHeaders = Object.entries(request.headers)
      .filter(([name]) => name !== "x-minibox-signature")
      .map(([, value]) => value)
      .join("\n");
    expect(otherHeaders).not.toContain(secret);
  });

  test("a webhook without a secret is sent unsigned", () => {
    const request = outgoingFor(channelOf(), null, oom, envelope);
    expect(request.headers).not.toHaveProperty("x-minibox-signature");
  });

  test("a changed timestamp or body changes the signature, so a replayed body cannot be re-timed", () => {
    const base = signature("k", 100, "{}");
    expect(signature("k", 101, "{}")).not.toBe(base);
    expect(signature("k", 100, "{ }")).not.toBe(base);
    expect(signature("other", 100, "{}")).not.toBe(base);
  });

  test("a notice with a body carries it in the JSON, and a missing body is null", () => {
    const withBody = outgoingFor(channelOf(), null, { ...oom, body: "Exit code 3." }, envelope);
    expect(JSON.parse(withBody.body).body).toBe("Exit code 3.");
    expect(JSON.parse(outgoingFor(channelOf(), null, oom, envelope).body).body).toBeNull();
  });
});

describe("ntfy requests", () => {
  const ntfy = channelOf({
    type: "ntfy",
    url: null,
    server: "https://ntfy.example.com/",
    topic: "alerts",
    events: ["box.oom"],
  });

  test("the topic is posted to on the server, with a trailing slash on the server removed", () => {
    expect(outgoingFor(ntfy, null, oom, envelope).url).toBe("https://ntfy.example.com/alerts");
  });

  test("the text is the title and the body, and the priority and tag follow the kind", () => {
    const request = outgoingFor(ntfy, null, { ...oom, body: "Exit code 137." }, envelope);
    expect(request.body).toBe("Box ran out of memory: alpha\nExit code 137.");
    expect(request.headers.priority).toBe("4");
    expect(request.headers.tags).toBe("warning");
    expect(request.headers["content-type"]).toBe("text/plain; charset=utf-8");
  });

  test("a title with characters outside printable ASCII is reduced to ASCII in the header", () => {
    const request = outgoingFor(ntfy, null, { ...oom, title: "Box café — out of memory" }, envelope);
    expect(request.headers.title).toBe("Box caf? ? out of memory");
    expect(request.body).toBe("Box café — out of memory");
  });

  test("the access token goes in a bearer header, and only when one is stored", () => {
    expect(outgoingFor(ntfy, "tk_live_0123456789", oom, envelope).headers.authorization).toBe(
      "Bearer tk_live_0123456789",
    );
    expect(outgoingFor(ntfy, null, oom, envelope).headers).not.toHaveProperty("authorization");
  });
});

describe("Telegram requests", () => {
  const telegram = channelOf({
    type: "telegram",
    url: null,
    chatId: "-1001234567890",
    events: ["box.oom"],
  });

  test("the bot token is the path segment of the sendMessage call, and the chat id is the body", () => {
    const token = "123456:ABC-def_ghi";
    const request = outgoingFor(telegram, token, oom, envelope);
    expect(request.url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    expect(JSON.parse(request.body)).toEqual({
      chat_id: "-1001234567890",
      text: "Box ran out of memory: alpha",
      disable_web_page_preview: true,
    });
  });

  test("a Telegram channel with no bot token cannot form a request", () => {
    expect(() => outgoingFor(telegram, null, oom, envelope)).toThrow("the Telegram channel has no bot token");
  });
});
