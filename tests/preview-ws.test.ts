import { describe, expect, test } from "bun:test";

import type { ServerWebSocket } from "bun";

import { type PreviewSocketData, type PreviewSocketLife, watchPreviewSocket } from "../src/preview/ws";

interface Close {
  code: number;
  reason: string;
}

function socketWith(data: Partial<PreviewSocketData>): { ws: ServerWebSocket<PreviewSocketData>; closes: Close[] } {
  const closes: Close[] = [];
  const socket = {
    data: { kind: "preview", boxId: "bx_test0001", ...data } as PreviewSocketData,
    close(code: number, reason: string) {
      closes.push({ code, reason });
    },
  };
  return { ws: socket as unknown as ServerWebSocket<PreviewSocketData>, closes };
}

/** A clock and timers that only move when the test advances them, and sign-ins the test can end. */
function fakeClock(start: number) {
  let now = start;
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const ended = new Set<string>();
  const life: PreviewSocketLife = {
    now: () => now,
    schedule: (fn, ms) => {
      const timer = { at: now + ms, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    watch: (sessionId, listener) => {
      if (ended.has(sessionId)) {
        listener();
        return () => {};
      }
      const set = listeners.get(sessionId) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(sessionId, set);
      return () => {
        set.delete(listener);
      };
    },
  };
  return {
    life,
    advance(ms: number) {
      now += ms;
      for (const timer of timers) {
        if (timer.cancelled || timer.at > now) continue;
        timer.cancelled = true;
        timer.fn();
      }
    },
    endSignIn(sessionId: string) {
      ended.add(sessionId);
      const set = listeners.get(sessionId);
      listeners.delete(sessionId);
      for (const listener of set ?? []) listener();
    },
    pendingTimers: () => timers.filter((timer) => !timer.cancelled).length,
  };
}

describe("watchPreviewSocket", () => {
  test("a socket with no sign-in attached is not watched and stays open", () => {
    const { ws, closes } = socketWith({});
    const clock = fakeClock(1_000);
    expect(watchPreviewSocket(ws, clock.life)).toBe(true);
    clock.advance(10 * 60 * 60 * 1000);
    expect(closes).toEqual([]);
    expect(clock.pendingTimers()).toBe(0);
  });

  test("a socket closes when its grant runs out, while its sign-in is still live", () => {
    const { ws, closes } = socketWith({ sessionId: "s1", expiresAt: 1_000 + 60_000 });
    const clock = fakeClock(1_000);
    expect(watchPreviewSocket(ws, clock.life)).toBe(true);
    clock.advance(59_999);
    expect(closes).toEqual([]);
    clock.advance(1);
    expect(closes).toEqual([{ code: 1008, reason: "preview expired" }]);
  });

  test("a grant that has already run out closes the socket at once", () => {
    const { ws, closes } = socketWith({ sessionId: "s1", expiresAt: 500 });
    const clock = fakeClock(1_000);
    expect(watchPreviewSocket(ws, clock.life)).toBe(true);
    clock.advance(0);
    expect(closes).toEqual([{ code: 1008, reason: "preview expired" }]);
  });

  test("ending the sign-in closes the socket with 1008, and the grant timer no longer applies", () => {
    const { ws, closes } = socketWith({ sessionId: "s1", expiresAt: 1_000 + 60_000 });
    const clock = fakeClock(1_000);
    expect(watchPreviewSocket(ws, clock.life)).toBe(true);
    clock.endSignIn("s1");
    expect(closes).toEqual([{ code: 1008, reason: "session ended" }]);
    ws.data.endWatch?.();
    clock.advance(60_000);
    expect(closes).toHaveLength(1);
  });

  test("a sign-in that has already ended refuses the socket, and schedules nothing", () => {
    const { ws, closes } = socketWith({ sessionId: "gone", expiresAt: 1_000 + 60_000 });
    const clock = fakeClock(1_000);
    clock.endSignIn("gone");
    expect(watchPreviewSocket(ws, clock.life)).toBe(false);
    expect(closes).toEqual([{ code: 1008, reason: "session ended" }]);
    expect(clock.pendingTimers()).toBe(0);
  });

  test("stopping the watch cancels both the grant timer and the sign-in listener", () => {
    const { ws, closes } = socketWith({ sessionId: "s1", expiresAt: 1_000 + 60_000 });
    const clock = fakeClock(1_000);
    expect(watchPreviewSocket(ws, clock.life)).toBe(true);
    ws.data.endWatch?.();
    expect(clock.pendingTimers()).toBe(0);
    clock.endSignIn("s1");
    clock.advance(60_000);
    expect(closes).toEqual([]);
  });

  test("a socket with a sign-in but no grant expiry closes only when the sign-in ends", () => {
    const { ws, closes } = socketWith({ sessionId: "s1" });
    const clock = fakeClock(1_000);
    expect(watchPreviewSocket(ws, clock.life)).toBe(true);
    clock.advance(365 * 24 * 60 * 60 * 1000);
    expect(closes).toEqual([]);
    clock.endSignIn("s1");
    expect(closes).toEqual([{ code: 1008, reason: "session ended" }]);
  });
});
