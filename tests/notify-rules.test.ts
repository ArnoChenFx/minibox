import { describe, expect, test } from "bun:test";

import type { StoredEvent } from "../src/events/store";
import { noticeOfEvent } from "../src/notify/rules";

const TS = Date.UTC(2026, 9, 22, 10, 0, 0);

/** A stored event with the fields a rule reads. Everything else is the shape every stored event has. */
function eventOf(patch: Partial<StoredEvent> & Pick<StoredEvent, "op">): StoredEvent {
  return {
    id: "01JNOTIFY0000000000000000A",
    ts: TS,
    durationMs: 0,
    status: "ok",
    kind: "write",
    principal: { type: "system", id: "system", name: "system" },
    source: "system",
    hostId: "local",
    summary: "",
    seq: 1,
    tier: "activity",
    count: 1,
    ...patch,
  };
}

const alpha = { kind: "box" as const, id: "cid-alpha", name: "alpha" };

describe("notices an event calls for", () => {
  test("an out-of-memory box is a box.oom notice that names the box by name and by both of its ids", () => {
    const notice = noticeOfEvent(
      eventOf({ op: "container.oom", target: alpha, detail: { boxId: "bx_alpha" }, status: "error" }),
    );
    expect(notice).toEqual({
      kind: "box.oom",
      title: "Box ran out of memory: alpha",
      body: undefined,
      box: { name: "alpha", ids: ["bx_alpha", "cid-alpha"] },
      at: TS,
    });
  });

  test("an out-of-memory event with no box is not a notice", () => {
    expect(noticeOfEvent(eventOf({ op: "container.oom", detail: {} }))).toBeNull();
  });

  test("a command that exits non-zero is exec.failed with its exit code, and a timed-out one says so", () => {
    const failed = noticeOfEvent(
      eventOf({ op: "exec.finish", target: alpha, detail: { exitCode: 3, timedOut: false, execId: "ex1" } }),
    );
    expect(failed).toMatchObject({
      kind: "exec.failed",
      title: "Command failed in alpha",
      body: "Exit code 3.",
    });

    const timedOut = noticeOfEvent(
      eventOf({ op: "exec.finish", target: alpha, detail: { exitCode: 137, timedOut: true } }),
    );
    expect(timedOut).toMatchObject({
      kind: "exec.failed",
      title: "Command timed out in alpha",
      body: "Exit code 137.",
    });
  });

  test("a command that succeeds, or that was killed with no exit code, is not an exec.failed notice on its own", () => {
    expect(noticeOfEvent(eventOf({ op: "exec.finish", target: alpha, detail: { exitCode: 0 } }))).toBeNull();
    expect(
      noticeOfEvent(eventOf({ op: "exec.finish", target: alpha, detail: { exitCode: null, timedOut: false } })),
    ).toBeNull();
  });

  test("a failed checkpoint notifies only when the server failed, so a refused request does not", () => {
    const serverFailed = noticeOfEvent(
      eventOf({
        op: "checkpoint.scheduled",
        target: alpha,
        status: "error",
        detail: { error: "restic exited 1" },
        error: { code: "scheduled_failed", status: 500 },
      }),
    );
    expect(serverFailed).toMatchObject({
      kind: "checkpoint.failed",
      title: "Checkpoint failed for alpha",
      body: "restic exited 1",
    });

    const refused = eventOf({
      op: "checkpoint.create",
      target: alpha,
      status: "error",
      error: { code: "conflict", status: 409 },
    });
    expect(noticeOfEvent(refused)).toBeNull();
    expect(noticeOfEvent(eventOf({ op: "checkpoint.create", target: alpha, status: "ok" }))).toBeNull();
  });

  test("a TTL or idle warning says when the box stops or sleeps", () => {
    const deadline = "2026-10-22T10:04:00.000Z";
    expect(
      noticeOfEvent(eventOf({ op: "box.ttl_soon", target: alpha, detail: { boxId: "bx_alpha", deadline } })),
    ).toEqual({
      kind: "box.ttl_soon",
      title: "Box TTL ends soon: alpha",
      body: `Stops at ${deadline}.`,
      box: { name: "alpha", ids: ["bx_alpha", "cid-alpha"] },
      at: TS,
    });
    expect(
      noticeOfEvent(eventOf({ op: "box.idle_soon", target: alpha, detail: { boxId: "bx_alpha", deadline } })),
    ).toMatchObject({
      kind: "box.idle_soon",
      title: "Box will sleep when idle: alpha",
      body: `Sleeps at ${deadline}.`,
    });
  });

  test("a terminal takeover names the session", () => {
    const notice = noticeOfEvent(
      eventOf({ op: "session.takeover", target: alpha, detail: { boxId: "bx_alpha", session: "agent-7" } }),
    );
    expect(notice).toMatchObject({
      kind: "session.takeover",
      title: "Terminal session taken over in alpha",
      body: "Session agent-7.",
    });
  });

  test("an id that appears twice on an event is listed once", () => {
    const notice = noticeOfEvent(eventOf({ op: "container.oom", target: alpha, detail: { boxId: "cid-alpha" } }));
    expect(notice?.box).toEqual({ name: "alpha", ids: ["cid-alpha"] });
  });

  test("the notifier's own delivery records and everyday events raise no notice", () => {
    expect(noticeOfEvent(eventOf({ op: "notify.deliver", status: "error", target: alpha, detail: {} }))).toBeNull();
    expect(noticeOfEvent(eventOf({ op: "box.ttl_expire", target: alpha, detail: { boxId: "bx_alpha" } }))).toBeNull();
    expect(noticeOfEvent(eventOf({ op: "exec.start", target: alpha, detail: { exitCode: 9 } }))).toBeNull();
    expect(noticeOfEvent(eventOf({ op: "box.create", target: alpha }))).toBeNull();
  });
});
