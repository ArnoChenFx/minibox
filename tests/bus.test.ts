import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Bus } from "../src/lib/bus";
import { silenceLogs } from "./support/app";

type Topics = { event: { id: number }; tick: number };

describe("Bus", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("delivers each publish to the subscribers of that topic, in subscription order", () => {
    const bus = new Bus<Topics>();
    const seen: string[] = [];
    bus.subscribe("event", (e) => seen.push(`first ${e.id}`));
    bus.subscribe("event", (e) => seen.push(`second ${e.id}`));
    bus.subscribe("tick", (n) => seen.push(`tick ${n}`));
    bus.publish("event", { id: 1 });
    expect(seen).toEqual(["first 1", "second 1"]);
  });

  test("an unsubscribed listener hears nothing more", () => {
    const bus = new Bus<Topics>();
    const seen: number[] = [];
    const off = bus.subscribe("tick", (n) => seen.push(n));
    bus.publish("tick", 1);
    off();
    bus.publish("tick", 2);
    expect(seen).toEqual([1]);
    expect(bus.listenerCount("tick")).toBe(0);
  });

  test("a listener that throws is logged, and the others and the publisher carry on", () => {
    const bus = new Bus<Topics>();
    const seen: number[] = [];
    bus.subscribe("tick", () => {
      throw new Error("boom");
    });
    bus.subscribe("tick", (n) => seen.push(n));
    expect(() => bus.publish("tick", 7)).not.toThrow();
    expect(seen).toEqual([7]);
  });

  test("a listener added during a publish first hears the next one", () => {
    const bus = new Bus<Topics>();
    const seen: string[] = [];
    bus.subscribe("tick", (n) => {
      seen.push(`early ${n}`);
      if (n === 1) bus.subscribe("tick", (m) => seen.push(`late ${m}`));
    });
    bus.publish("tick", 1);
    bus.publish("tick", 2);
    expect(seen).toEqual(["early 1", "early 2", "late 2"]);
  });

  test("publishing to a topic nobody watches is a no-op", () => {
    const bus = new Bus<Topics>();
    expect(() => bus.publish("event", { id: 9 })).not.toThrow();
    expect(bus.listenerCount("event")).toBe(0);
  });
});
