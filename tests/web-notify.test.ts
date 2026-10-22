import { describe, expect, test } from "bun:test";

import {
  NOTICE_KIND_NAMES,
  CHANNEL_ID_RE as SERVER_CHANNEL_ID_RE,
  CHANNEL_TYPES as SERVER_TYPES,
} from "../src/notify/types";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";
import {
  CHANNEL_ID_RE,
  CHANNEL_TYPES,
  channelBody,
  failureOf,
  NOTICE_KINDS,
  parseBoxes,
  TYPE_FIELDS,
} from "../web/js/lib/notify-state.js";

const DELIVERY_FAILURES = [
  "timeout",
  "network",
  "dns_failed",
  "blocked_address",
  "bad_url",
  "queue_full",
  "unexpected",
];

describe("notify console and server agree", () => {
  test("the notices and channel types are the server's, in its order", () => {
    expect([...NOTICE_KINDS]).toEqual([...NOTICE_KIND_NAMES]);
    expect([...CHANNEL_TYPES]).toEqual([...SERVER_TYPES]);
  });

  test("the channel id rule is the server's", () => {
    expect(CHANNEL_ID_RE.source).toBe(SERVER_CHANNEL_ID_RE.source);
  });

  test("every channel type names the settings it keeps", () => {
    expect(Object.keys(TYPE_FIELDS).toSorted()).toEqual([...CHANNEL_TYPES].toSorted());
  });
});

describe("box filter", () => {
  test("names and ids typed by line or by comma become one list, trimmed and without repeats", () => {
    expect(parseBoxes(" alpha ,beta\ngamma\n\n alpha,, \n")).toEqual(["alpha", "beta", "gamma"]);
  });

  test("an empty or missing filter is an empty list, which means every box", () => {
    expect(parseBoxes("")).toEqual([]);
    expect(parseBoxes(undefined)).toEqual([]);
    expect(parseBoxes(null)).toEqual([]);
  });
});

describe("channel body", () => {
  const base = { name: "  Ops  ", events: ["box.oom", "host.offline"], boxes: "", enabled: true };

  test("a webhook sends its own settings only, and a blank secret field sends no secret", () => {
    const body = channelBody({
      ...base,
      type: "webhook",
      url: " https://hooks.example.com/minibox ",
      server: "https://ntfy.example.com",
      topic: "stale",
      chatId: "1",
      secret: "",
    });
    expect(body).toEqual({
      type: "webhook",
      name: "Ops",
      enabled: true,
      events: ["box.oom", "host.offline"],
      boxes: [],
      url: "https://hooks.example.com/minibox",
    });
    expect("secret" in body).toBe(false);
  });

  test("a typed secret is sent, and a cleared one is sent as null even when the field still holds text", () => {
    expect(channelBody({ ...base, type: "ntfy", topic: "alerts", secret: "tk_example_token" }).secret).toBe(
      "tk_example_token",
    );
    expect(
      channelBody({ ...base, type: "ntfy", topic: "alerts", secret: "tk_example", clearSecret: true }).secret,
    ).toBe(null);
  });

  test("an ntfy channel with no server sends none, so the server's default applies", () => {
    const body = channelBody({ ...base, type: "ntfy", server: " ", topic: "minibox-alerts" });
    expect(body).toEqual({
      type: "ntfy",
      name: "Ops",
      enabled: true,
      events: ["box.oom", "host.offline"],
      boxes: [],
      topic: "minibox-alerts",
    });
  });

  test("a telegram channel sends its chat and the box filter, and no URL", () => {
    const body = channelBody({
      ...base,
      type: "telegram",
      chatId: "-1001234567890",
      boxes: "dev\nci",
      secret: "123:abc",
    });
    expect(body).toEqual({
      type: "telegram",
      name: "Ops",
      enabled: true,
      events: ["box.oom", "host.offline"],
      boxes: ["dev", "ci"],
      chatId: "-1001234567890",
      secret: "123:abc",
    });
  });

  test("a paused channel is sent as disabled, and a form that leaves enabled out keeps it on", () => {
    expect(channelBody({ ...base, type: "webhook", url: "https://h.example.com/x", enabled: false }).enabled).toBe(
      false,
    );
    expect(
      channelBody({ type: "webhook", name: "Ops", events: ["box.oom"], url: "https://h.example.com/x" }).enabled,
    ).toBe(true);
  });
});

describe("failed send reasons", () => {
  test("an HTTP status keeps its number, and a known delivery code keeps its key", () => {
    expect(failureOf("http_503")).toEqual({ key: "st.notifyError.http", params: { status: 503 } });
    expect(failureOf("timeout")).toEqual({ key: "st.notifyError.timeout", params: {} });
  });

  test("a code the card does not know is reported as a generic failure", () => {
    expect(failureOf("something_new")).toEqual({ key: "st.notifyError.other", params: {} });
  });

  test("a send that did not fail has no reason", () => {
    expect(failureOf(null)).toBeNull();
    expect(failureOf(undefined)).toBeNull();
    expect(failureOf("")).toBeNull();
  });
});

describe("notify translations", () => {
  const fixed = [
    "st.notify",
    "st.notifyHelp",
    "st.notifyAdd",
    "st.notifyNone",
    "st.notifyColChannel",
    "st.notifyColDestination",
    "st.notifyColNotices",
    "st.notifyColWhen",
    "st.notifyColNotice",
    "st.notifyColResult",
    "st.notifyColAttempts",
    "st.notifyBoxes",
    "st.notifyPaused",
    "st.notifyTest",
    "st.notifyEdit",
    "st.notifyDelete",
    "st.notifyAllKinds",
    "st.notifyAllBoxes",
    "st.notifyDeliveries",
    "st.notifyDeliveriesHelp",
    "st.notifyDeliveriesNone",
    "st.notifyDeliveryOk",
    "st.notifyDeliveryFailed",
    "st.notifyTestOk",
    "st.notifyTestFailed",
    "st.notifyAddTitle",
    "st.notifyEditTitle",
    "st.notifyDialogHelp",
    "st.notifyName",
    "st.notifyId",
    "st.notifyIdHelp",
    "st.notifyType",
    "st.notifyUrl",
    "st.notifyUrlHelp",
    "st.notifyServer",
    "st.notifyServerHelp",
    "st.notifyTopic",
    "st.notifyTopicHelp",
    "st.notifyChatId",
    "st.notifyChatHelp",
    "st.notifySecretWebhook",
    "st.notifySecretHelpWebhook",
    "st.notifySecretNtfy",
    "st.notifySecretHelpNtfy",
    "st.notifySecretTelegram",
    "st.notifySecretHelpTelegram",
    "st.notifySecretStored",
    "st.notifySecretDropped",
    "st.notifySecretClear",
    "st.notifyEvents",
    "st.notifyEventsRequired",
    "st.notifyBoxesHelp",
    "st.notifyEnabledLabel",
    "st.notifyEnabledHelp",
    "st.notifySave",
    "st.notifySaved",
    "st.notifyDeleteTitle",
    "st.notifyDeleteMessage",
    "st.notifyDeleted",
    "st.notifyDeleteFailed",
  ];
  const dynamic = [
    ...CHANNEL_TYPES.map((type) => `st.notifyType.${type}`),
    ...NOTICE_KINDS.map((kind) => `st.notifyKind.${kind}`),
    "st.notifyKind.notify.test",
    ...[...DELIVERY_FAILURES, "other", "http"].map((code) => `st.notifyError.${code}`),
  ];

  test("every key the notification card reads has a Chinese and an English text", () => {
    const missing = [...fixed, ...dynamic].filter((key) => !(key in en) || !(key in zh));
    expect(missing).toEqual([]);
  });

  test("every failure reason the card can name is a key the dictionaries define", () => {
    const named = [...DELIVERY_FAILURES, "something_new"].map((code) => failureOf(code)?.key ?? "");
    expect(named.filter((key) => !(key in en) || !(key in zh))).toEqual([]);
  });

  test("the HTTP failure keeps its status placeholder in both languages", () => {
    expect(en["st.notifyError.http"]).toContain("{status}");
    expect(zh["st.notifyError.http"]).toContain("{status}");
  });
});
