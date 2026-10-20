import { describe, expect, test } from "bun:test";

import { parseDotenv } from "../src/config";
import { demuxLogs } from "../src/docker/logs";
import { snapshotTag } from "../src/docker/snapshots";
import { cpuPercent, parseCpuMax, parseMeminfo, parseProcStat } from "../src/host/procfs";
import { AppError, toAppError } from "../src/lib/errors";
import { compilePath, matchRoute, route } from "../src/routes/router";
import { safeJoin } from "../src/static";
import { parseControl } from "../src/ws/terminal";

describe("procfs", () => {
  test("cpu percent from /proc/stat deltas", () => {
    const a = parseProcStat("cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3 4");
    const b = parseProcStat("cpu  150 0 150 900 0 0 0 0 0 0\n");
    expect(a).toEqual({ idle: 800, total: 1000 });
    if (!a || !b) throw new Error("parse failed");
    expect(cpuPercent(a, b)).toBe(50);
    expect(cpuPercent(b, b)).toBe(0);
    expect(parseProcStat("nothing")).toBeNull();
  });
  test("meminfo", () => {
    const m = parseMeminfo("MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 400 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB");
    expect(m?.total).toBe(1000 * 1024);
    expect(m?.used).toBe(600 * 1024);
  });
  test("cpu.max", () => {
    expect(parseCpuMax("200000 100000")).toBe(2);
    expect(parseCpuMax("max 100000")).toBeNull();
  });
});

describe("router", () => {
  const routes = [route("GET", "/api/boxes/:id/logs", () => new Response("ok"))];
  test("matches and decodes params", () => {
    const m = matchRoute(routes, "GET", "/api/boxes/minibox-snap%3Aa/logs");
    expect(m).not.toBeNull();
    expect(m !== null && m !== "method_not_allowed" && m.params.id).toBe("minibox-snap:a");
  });
  test("method not allowed vs not found", () => {
    expect(matchRoute(routes, "POST", "/api/boxes/x/logs")).toBe("method_not_allowed");
    expect(matchRoute(routes, "GET", "/api/nope")).toBeNull();
    expect(compilePath("/a.b/:x").pattern.test("/aXb/1")).toBe(false);
  });
});

describe("misc", () => {
  test("parseDotenv", () => {
    expect(parseDotenv("# c\nA=1\nB = \"two\"\n\nbad\nC='x=y'")).toEqual({ A: "1", B: "two", C: "x=y" });
  });
  test("demuxLogs strips stream headers", () => {
    const payload = Buffer.from("hello\n");
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(payload.length, 4);
    expect(demuxLogs(Buffer.concat([header, payload, header, payload]))).toBe("hello\nhello\n");
    expect(demuxLogs(Buffer.from("plain"))).toBe("plain");
  });
  test("snapshotTag", () => {
    expect(snapshotTag("minibox", "demo", new Date("2026-10-20T15:04:05Z"))).toEqual({
      repo: "minibox-snap",
      tag: "demo-20261020-150405",
    });
  });
  test("toAppError maps docker errors", () => {
    expect(toAppError({ statusCode: 404, json: { message: "no such" } }).status).toBe(404);
    expect(toAppError({ code: "ECONNREFUSED" }).code).toBe("docker_unavailable");
    expect(toAppError(new AppError(422, "insufficient_capacity", "x")).status).toBe(422);
    expect(toAppError(new Error("boom")).status).toBe(500);
  });
  test("safeJoin prevents traversal", () => {
    expect(safeJoin("/srv/web", "/css/app.css")).toBe("/srv/web/css/app.css");
    expect(safeJoin("/srv/web", "/../etc/passwd")).toBe("/srv/web/etc/passwd");
    expect(safeJoin("/srv/web", "/%2e%2e/%2e%2e/etc")).toBe("/srv/web/etc");
    expect(safeJoin("/srv/web", "/%00")).toBeNull();
  });
  test("terminal control frames", () => {
    expect(parseControl('{"type":"resize","cols":80,"rows":24}')).toEqual({ type: "resize", cols: 80, rows: 24 });
    expect(parseControl('{"type":"resize","cols":"x"}')).toBeNull();
    expect(parseControl("ls -la\r")).toBeNull();
  });
});
