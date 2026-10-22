import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { notifyPath } from "../src/data-dir";
import { NotifyFileError, NotifyStore } from "../src/notify/store";
import type { StoredChannel } from "../src/notify/types";
import { SecretStore } from "../src/secrets/store";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mbx-notify-store-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function channelOf(patch: Partial<StoredChannel> = {}): StoredChannel {
  return {
    id: "ops",
    type: "webhook",
    name: "Ops",
    enabled: true,
    events: ["box.oom"],
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

/** A store over the data directory. The returned list collects every secret the store hands to the redactor. */
function openStore(): { store: NotifyStore; handed: string[] } {
  const handed: string[] = [];
  const store = new NotifyStore(dataDir, {
    secrets: new SecretStore(dataDir, "notify"),
    onSecret: (value) => handed.push(value),
  });
  return { store, handed };
}

const writeNotifyFile = (text: string) => writeFileSync(notifyPath(dataDir), text);

describe("the notification channel store", () => {
  test("a data directory with no notify file has no channels, and loading does not create one", () => {
    const { store } = openStore();
    store.load();
    expect(store.list()).toEqual([]);
    expect(existsSync(notifyPath(dataDir))).toBe(false);
  });

  test("a saved channel is written without its secret, and the file is readable by its owner only", () => {
    const { store } = openStore();
    store.save(channelOf());
    store.setSecret("ops", "hook-signing-key-1");

    const text = readFileSync(notifyPath(dataDir), "utf8");
    expect(JSON.parse(text)).toMatchObject({ version: 1, channels: [{ id: "ops", name: "Ops" }] });
    expect(text).not.toContain("hook-signing-key-1");
    expect(statSync(notifyPath(dataDir)).mode & 0o777).toBe(0o600);
  });

  test("channels and their secrets survive a restart, and each stored secret is handed to the redactor on load", () => {
    const first = openStore();
    first.store.save(channelOf());
    first.store.setSecret("ops", "hook-signing-key-1");

    const second = openStore();
    second.store.load();
    expect(second.store.list()).toEqual([channelOf()]);
    expect(second.store.hasSecret("ops")).toBe(true);
    expect(second.store.secret("ops")).toBe("hook-signing-key-1");
    expect(second.handed).toEqual(["hook-signing-key-1"]);
  });

  test("removing a channel removes its secret too, and reports whether there was a channel to remove", () => {
    const { store } = openStore();
    store.save(channelOf());
    store.setSecret("ops", "hook-signing-key-1");

    expect(store.remove("ops")).toBe(true);
    expect(store.get("ops")).toBeUndefined();
    expect(store.hasSecret("ops")).toBe(false);
    expect(store.secret("ops")).toBeNull();
    expect(JSON.parse(readFileSync(notifyPath(dataDir), "utf8")).channels).toEqual([]);
    expect(store.remove("ops")).toBe(false);
  });

  test("the list is in creation order, whatever order the channels were saved in", () => {
    const { store } = openStore();
    store.save(channelOf({ id: "later", createdAt: "2026-10-22T11:00:00.000Z" }));
    store.save(channelOf({ id: "first", createdAt: "2026-10-22T08:00:00.000Z" }));
    expect(store.list().map((channel) => channel.id)).toEqual(["first", "later"]);
  });

  test("a file in the wrong format stops the load, and the error names the file", () => {
    writeNotifyFile(JSON.stringify({ version: 2, channels: [] }));
    const { store } = openStore();
    expect(() => store.load()).toThrow(NotifyFileError);
    expect(() => store.load()).toThrow(`${notifyPath(dataDir)} does not match the notification format`);
  });

  test("a field the format does not define stops the load, so a typo is not silently dropped", () => {
    writeNotifyFile(JSON.stringify({ version: 1, channels: [{ ...channelOf(), secretValue: "x" }] }));
    expect(() => openStore().store.load()).toThrow("does not match the notification format");
  });

  test("a file that is not JSON stops the load", () => {
    writeNotifyFile("{not json");
    expect(() => openStore().store.load()).toThrow("is not valid JSON");
  });

  test("two entries with one id stop the load", () => {
    writeNotifyFile(JSON.stringify({ version: 1, channels: [channelOf(), channelOf()] }));
    expect(() => openStore().store.load()).toThrow("lists channel ops more than once");
  });

  test("a webhook URL is kept under secrets/notify, never in the notify file, and comes back after a restart", () => {
    const url = "https://hooks.slack.example/services/T000/B000/token-in-path";
    const first = openStore();
    first.store.save(channelOf({ url }));

    const text = readFileSync(notifyPath(dataDir), "utf8");
    expect(text).not.toContain("token-in-path");
    expect(JSON.parse(text).channels[0].url).toBeNull();
    const file = join(dataDir, "secrets", "notify", "ops.url");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const second = openStore();
    second.store.load();
    expect(second.store.get("ops")?.url).toBe(url);

    second.store.save(channelOf({ type: "ntfy", url: null, topic: "alerts" }));
    expect(existsSync(file)).toBe(false);
  });

  test("a URL written into the notify file by hand is moved under secrets/notify on load", () => {
    writeNotifyFile(JSON.stringify({ version: 1, channels: [channelOf({ url: "https://hooks.example.com/x?k=v1" })] }));
    const { store } = openStore();
    store.load();
    expect(store.get("ops")?.url).toBe("https://hooks.example.com/x?k=v1");
    expect(readFileSync(notifyPath(dataDir), "utf8")).not.toContain("k=v1");
    expect(existsSync(join(dataDir, "secrets", "notify", "ops.url"))).toBe(true);
  });

  test("removing a webhook channel removes its stored URL", () => {
    const { store } = openStore();
    store.save(channelOf());
    store.remove("ops");
    expect(existsSync(join(dataDir, "secrets", "notify", "ops.url"))).toBe(false);
  });

  test("a channel saved without a secret reads as having none, and the secret directory need not exist", () => {
    const { store } = openStore();
    store.save(channelOf());
    expect(store.hasSecret("ops")).toBe(false);
    expect(store.secret("ops")).toBeNull();
  });
});
