import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OUTPUT_HEAD_TAIL_BYTES, OutputStore, headAndTail } from "../src/events/outputs";
import { createRedactor, REDACTED } from "../src/events/redact";
import { RetentionJob } from "../src/events/retention";
import { EventStore } from "../src/events/store";
import type { EventInput } from "../src/events/types";
import { silenceLogs } from "./support/app";

const SECRET = "access-key-0123456789-secret";
const NOW = 1_750_000_000_000;
const DAY = 86_400_000;

describe("headAndTail", () => {
  test("text within the limit is returned unchanged", () => {
    expect(headAndTail("short output")).toBe("short output");
    expect(headAndTail("x".repeat(OUTPUT_HEAD_TAIL_BYTES * 2))).toHaveLength(OUTPUT_HEAD_TAIL_BYTES * 2);
  });

  test("longer text keeps the first and last 64 KB with a note for what was dropped", () => {
    const text = `${"a".repeat(OUTPUT_HEAD_TAIL_BYTES)}MIDDLE${"z".repeat(OUTPUT_HEAD_TAIL_BYTES)}`;
    const out = headAndTail(text);
    expect(out.startsWith("a".repeat(OUTPUT_HEAD_TAIL_BYTES))).toBe(true);
    expect(out.endsWith("z".repeat(OUTPUT_HEAD_TAIL_BYTES))).toBe(true);
    expect(out).not.toContain("MIDDLE");
    expect(out).toContain("bytes omitted");
    expect(out.length).toBeLessThan(OUTPUT_HEAD_TAIL_BYTES * 2 + 100);
  });
});

describe("OutputStore", () => {
  let dir: string;
  let outputDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "minibox-outputs-"));
    outputDir = join(dir, "exec");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const store = () => new OutputStore(outputDir, createRedactor({ knownSecrets: [SECRET] }));

  test("a record is written with credentials redacted and referenced by its name", () => {
    const ref = store().save("01EXEC", { stdout: `token ${SECRET}\n`, stderr: "ok" });
    expect(ref).toBe("exec/01EXEC");
    const text = readFileSync(join(outputDir, "01EXEC.json"), "utf8");
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toEqual({ stdout: `token ${REDACTED}\n`, stderr: "ok" });
  });

  test("a name that is not a plain identifier is refused, so nothing is written outside the directory", () => {
    expect(() => store().save("../escape", { stdout: "", stderr: "" })).toThrow("not a plain identifier");
    expect(() => store().save("a/b", { stdout: "", stderr: "" })).toThrow("not a plain identifier");
  });

  test("records older than the window are removed", () => {
    const outputs = store();
    for (const name of ["old", "fresh"]) outputs.save(name, { stdout: "x", stderr: "" });
    utimesSync(join(outputDir, "old.json"), new Date(NOW - 10 * DAY), new Date(NOW - 10 * DAY));
    utimesSync(join(outputDir, "fresh.json"), new Date(NOW - DAY), new Date(NOW - DAY));
    expect(outputs.prune(NOW, 7 * DAY, 10 ** 9)).toBe(1);
    expect(readdirSync(outputDir)).toEqual(["fresh.json"]);
  });

  test("the total size is capped by removing the oldest records first", () => {
    const outputs = store();
    const size = (name: string) => readFileSync(join(outputDir, `${name}.json`)).length;
    for (const name of ["first", "second", "third"]) outputs.save(name, { stdout: "x".repeat(1000), stderr: "" });
    utimesSync(join(outputDir, "first.json"), new Date(NOW - 3_000), new Date(NOW - 3_000));
    utimesSync(join(outputDir, "second.json"), new Date(NOW - 2_000), new Date(NOW - 2_000));
    utimesSync(join(outputDir, "third.json"), new Date(NOW - 1_000), new Date(NOW - 1_000));
    const cap = size("second") + size("third");
    expect(outputs.prune(NOW, 7 * DAY, cap)).toBe(1);
    expect(readdirSync(outputDir).toSorted()).toEqual(["second.json", "third.json"]);
  });

  test("pruning a directory that does not exist yet removes nothing", () => {
    expect(store().prune(NOW, DAY, 0)).toBe(0);
  });
});

const eventAt = (ts: number, kind: EventInput["kind"] = "write"): EventInput => ({
  id: `01EVENT${ts}${kind}`,
  ts,
  durationMs: 1,
  status: "ok",
  op: kind === "read" ? "box.get" : "box.create",
  kind,
  principal: { type: "owner", id: "owner", name: "owner" },
  source: "rest",
  hostId: "local",
  summary: "event",
});

describe("RetentionJob", () => {
  let dir: string;
  let events: EventStore | undefined;
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
    dir = mkdtempSync(join(tmpdir(), "minibox-retention-"));
  });
  afterEach(() => {
    events?.close();
    events = undefined;
    restoreLogs();
    rmSync(dir, { recursive: true, force: true });
  });

  test("one run applies the windows of each tier and the output cap", () => {
    const redactor = createRedactor({ knownSecrets: [SECRET] });
    events = new EventStore(":memory:", redactor);
    const outputs = new OutputStore(join(dir, "exec"), redactor);
    events.append(eventAt(NOW - 400 * DAY));
    events.append(eventAt(NOW - 40 * DAY, "read"));
    events.append(eventAt(NOW - 100 * DAY));
    outputs.save("a", { stdout: "x", stderr: "" });
    utimesSync(join(dir, "exec", "a.json"), new Date(NOW - 30 * DAY), new Date(NOW - 30 * DAY));

    const job = new RetentionJob(
      events,
      outputs,
      { auditDays: 365, activityDays: 30, outputDays: 7, outputMaxBytes: 10 ** 9 },
      60_000,
    );
    expect(job.run(NOW)).toEqual({ events: 2, outputs: 1 });
    expect(events.list({}, { limit: 10 }).events).toHaveLength(1);
  });

  test("start() prunes at once and stop() ends the timer", () => {
    const redactor = createRedactor();
    events = new EventStore(":memory:", redactor);
    events.append(eventAt(Date.now() - 400 * DAY));
    const job = new RetentionJob(
      events,
      new OutputStore(join(dir, "exec"), redactor),
      { auditDays: 365, activityDays: 30, outputDays: 7, outputMaxBytes: 10 ** 9 },
      60_000,
    );
    job.start();
    expect(events.list({}, { limit: 10 }).events).toEqual([]);
    job.stop();
    job.stop();
  });

  test("a failing prune is logged and does not stop the process", () => {
    const redactor = createRedactor();
    const closed = new EventStore(":memory:", redactor);
    closed.close();
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    try {
      const job = new RetentionJob(
        closed,
        new OutputStore(join(dir, "exec"), redactor),
        { auditDays: 365, activityDays: 30, outputDays: 7, outputMaxBytes: 10 ** 9 },
        60_000,
      );
      expect(() => job.start()).not.toThrow();
      job.stop();
    } finally {
      spy.mockRestore();
    }
    expect(errors.map((line) => JSON.parse(line) as { msg: string }).map((line) => line.msg)).toEqual([
      "retention.failed",
    ]);
  });
});
