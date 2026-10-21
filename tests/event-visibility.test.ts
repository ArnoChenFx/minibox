import { describe, expect, test } from "bun:test";

import { createRedactor } from "../src/events/redact";
import { visibilityOf } from "../src/events/scope";
import { EventStore, type EventVisibility, matchesFilter } from "../src/events/store";
import type { EventInput } from "../src/events/types";
import { ulid } from "../src/events/ulid";
import { type BoxView, compileToken, type TokenGrants } from "../src/tokens/model";

const SINCE = Date.parse("2026-10-01T00:00:00.000Z");
const BEFORE = SINCE - 60_000;
const AFTER = SINCE + 60_000;
const AGENT = "tok_agent";

const visible: EventVisibility = {
  principalId: AGENT,
  boxes: { ids: ["c-new"], names: [{ name: "web", since: SINCE }] },
  hosts: ["local"],
};

function eventOf(overrides: Partial<EventInput>): EventInput {
  return {
    id: ulid(),
    ts: BEFORE,
    durationMs: 1,
    status: "ok",
    op: "box.action",
    kind: "write",
    principal: { type: "owner", id: "owner", name: "owner" },
    source: "rest",
    hostId: "local",
    summary: "box action",
    ...overrides,
  };
}

const EVENTS: EventInput[] = [
  eventOf({ summary: "earlier web", ts: BEFORE, target: { kind: "box", id: "c-old", name: "web" } }),
  eventOf({ summary: "web after rebuild", ts: AFTER, target: { kind: "box", id: "c-old", name: "web" } }),
  eventOf({ summary: "granted by id", ts: BEFORE, target: { kind: "box", id: "c-new", name: "renamed" } }),
  eventOf({ summary: "other box", ts: AFTER, target: { kind: "box", id: "c-other", name: "api" } }),
  eventOf({
    summary: "own event",
    principal: { type: "token", id: AGENT, name: "agent" },
    ts: AFTER,
    target: { kind: "box", id: "c-other", name: "api" },
  }),
  eventOf({ summary: "volume named web", ts: AFTER, target: { kind: "volume", id: "vol_1", name: "web" } }),
  eventOf({ summary: "no target", ts: AFTER, target: undefined }),
  eventOf({ summary: "other host", hostId: "remote", ts: AFTER, target: { kind: "box", id: "c-new", name: "web" } }),
];

const EXPECTED = ["granted by id", "own event", "web after rebuild"];

describe("event visibility for a token", () => {
  test("the stored query and the live matcher show a token the same events", () => {
    const store = new EventStore(":memory:", createRedactor());
    try {
      for (const event of EVENTS) store.append(event);
      const stored = store.list({ visible }, { limit: 100 }).events.map((event) => event.summary);
      const live = store
        .list({}, { limit: 100 })
        .events.filter((event) => matchesFilter(event, { visible }))
        .map((event) => event.summary);

      expect(stored.toSorted()).toEqual(EXPECTED);
      expect(live.toSorted()).toEqual(EXPECTED);
    } finally {
      store.close();
    }
  });

  test("a box grants its events by name only from its creation time", () => {
    const grants: TokenGrants = compileToken({ name: "agent", preset: "operator" });
    const principal = { type: "token", id: AGENT, name: "agent", grants };
    const dated: BoxView = {
      boxId: "bx_1",
      containerId: "c-1",
      name: "web",
      createdBy: AGENT,
      labels: {},
      hostId: "local",
      createdAt: new Date(SINCE).toISOString(),
    };
    const undated: BoxView = { ...dated, createdAt: undefined };

    expect(visibilityOf(principal, [dated]).visible?.boxes).toEqual({
      ids: ["bx_1", "c-1"],
      names: [{ name: "web", since: SINCE }],
    });
    expect(visibilityOf(principal, [undated]).visible?.boxes).toEqual({ ids: ["bx_1", "c-1"], names: [] });
  });
});
