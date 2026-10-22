import { describe, expect, test } from "bun:test";

import {
  bytesOfGb,
  fillPercent,
  levelClass,
  levelLabelKey,
  limitDraft,
  limitsBody,
  trendValues,
  usageSummary,
  type VolumeLimitsView,
  type VolumeUsageView,
} from "../web/js/lib/volume-usage.js";

const MB = 1024 * 1024;
const GIB = 1024 ** 3;

const volume = (patch: Partial<VolumeUsageView> = {}): VolumeUsageView => ({
  bytes: null,
  limits: { softBytes: null, hardBytes: null, action: "warn" },
  usage: { scope: "volume", level: "unknown", history: [], lastError: null },
  ...patch,
});

describe("a volume's usage figures in the console", () => {
  test("the limit a figure is read against is the hard one when set, else the soft one, else none", () => {
    const both = volume({
      bytes: 3 * MB,
      limits: { softBytes: 2 * MB, hardBytes: 4 * MB, action: "warn" },
      usage: { scope: "volume", level: "soft", history: [], lastError: null },
    });
    expect(usageSummary(both)).toEqual({
      bytes: 3 * MB,
      limit: { kind: "hard", bytes: 4 * MB },
      scale: 4 * MB,
      level: "soft",
      history: [],
      shared: false,
    });
    expect(
      usageSummary(volume({ bytes: 3 * MB, limits: { softBytes: 2 * MB, hardBytes: null, action: "warn" } })).limit,
    ).toEqual({
      kind: "soft",
      bytes: 2 * MB,
    });
    expect(usageSummary(volume({ bytes: 3 * MB })).limit).toBeNull();
  });

  test("a volume never sampled has no figure and an unknown level, and an NFS volume's figure is marked as the share's", () => {
    expect(usageSummary(volume())).toMatchObject({ bytes: null, level: "unknown", history: [], shared: false });
    const shared = volume({ bytes: 7 * MB, usage: { scope: "share", level: "ok", history: [], lastError: null } });
    expect(usageSummary(shared)).toMatchObject({ bytes: 7 * MB, shared: true });
  });

  test("the bar fills to the limit and stops at the top, and there is no bar without a figure or a limit", () => {
    expect(fillPercent(MB, 4 * MB)).toBe(25);
    expect(fillPercent(9 * MB, 4 * MB)).toBe(100);
    expect(fillPercent(MB, null)).toBeNull();
    expect(fillPercent(null, 4 * MB)).toBeNull();
  });

  test("the trend is drawn against the limit, or against its own largest point when there is no limit", () => {
    const points = [
      { at: "2026-10-22T10:00:00.000Z", bytes: MB },
      { at: "2026-10-22T10:10:00.000Z", bytes: 2 * MB },
    ];
    expect(trendValues(points, 4 * MB)).toEqual([25, 50]);
    expect(trendValues(points, null)).toEqual([50, 100]);
    expect(trendValues([{ at: "2026-10-22T10:00:00.000Z", bytes: 0 }], null)).toEqual([0]);
  });

  test("the bar's colour and the badge follow the level, and an ok or unknown volume has neither", () => {
    expect([levelClass("hard"), levelClass("soft"), levelClass("ok"), levelClass("unknown")]).toEqual([
      "crit",
      "warn",
      "",
      "",
    ]);
    expect([levelLabelKey("hard"), levelLabelKey("soft"), levelLabelKey("ok"), levelLabelKey("unknown")]).toEqual([
      "vol.overHard",
      "vol.overSoft",
      null,
      null,
    ]);
  });
});

describe("a limits form", () => {
  test("a limit typed in GB is bytes, an empty field is no limit, and anything else is refused", () => {
    expect(bytesOfGb("2")).toEqual({ ok: true, bytes: 2 * GIB });
    expect(bytesOfGb("0.5")).toEqual({ ok: true, bytes: GIB / 2 });
    expect(bytesOfGb("")).toEqual({ ok: true, bytes: null });
    expect(bytesOfGb("   ")).toEqual({ ok: true, bytes: null });
    for (const text of ["0", "-1", "abc", "1e400"]) {
      expect(bytesOfGb(text)).toEqual({ ok: false, key: "vol.limitInvalid" });
    }
  });

  test("the form becomes a limits request, and a soft limit above the hard one is refused before it is sent", () => {
    expect(limitsBody({ soft: "2", hard: "", action: "stop" })).toEqual({
      body: { softBytes: 2 * GIB, hardBytes: null, action: "stop" },
    });
    expect(limitsBody({ soft: "", hard: "1", action: "anything" })).toEqual({
      body: { softBytes: null, hardBytes: GIB, action: "warn" },
    });
    expect(limitsBody({ soft: "4", hard: "2", action: "warn" })).toEqual({ error: "vol.limitOrder" });
    expect(limitsBody({ soft: "x", hard: "", action: "warn" })).toEqual({ error: "vol.limitInvalid" });
  });

  test("a stored limit opens in GB, and saving the form unchanged sends the same bytes back", () => {
    const stored: VolumeLimitsView = { softBytes: 3 * MB, hardBytes: null, action: "stop" };
    const draft = limitDraft(stored);
    expect(draft).toEqual({ soft: String(3 / 1024), hard: "", action: "stop" });
    expect(limitsBody(draft)).toEqual({ body: { softBytes: 3 * MB, hardBytes: null, action: "stop" } });
    expect(limitDraft(undefined)).toEqual({ soft: "", hard: "", action: "warn" });
  });
});
