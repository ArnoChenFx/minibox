import { describe, expect, test } from "bun:test";
import { AppError } from "../src/lib/errors";
import { errorResponse } from "../src/lib/http";
import { MESSAGES, msg } from "../src/lib/messages";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("i18n dictionaries", () => {
  test("en and zh-CN have the same keys", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });
  test("translations keep the same placeholders", () => {
    for (const [k, v] of Object.entries(en)) expect([k, placeholders(zh[k] ?? "")]).toEqual([k, placeholders(v)]);
  });
  test("every server message key has a UI translation", () => {
    for (const k of Object.keys(MESSAGES)) expect([k, `err.${k}` in en]).toEqual([k, true]);
  });
});

describe("server messages", () => {
  test("msg interpolates params and label names", () => {
    expect(msg("field_required", { label: "boxName" }).text).toBe("Box name is required.");
    expect(msg("box_exists", { name: "dev" }).text).toBe("A box named “dev” already exists.");
  });
  test("error responses carry key and params", async () => {
    const res = errorResponse(new AppError(409, "conflict", msg("box_exists", { name: "dev" })));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({ code: "conflict", key: "box_exists", params: { name: "dev" } });
  });
});
