import { describe, expect, test } from "bun:test";

import { OPERATIONS } from "../src/operations/registry";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";
import { CATEGORIES, eventsQuery, PAGE_SIZE } from "../web/js/lib/activity-log.js";

/** Families recorded by services rather than by a registered operation: container events, egress, terminals. */
const SERVICE_FAMILIES = ["container", "egress", "ssh", "terminal"];

const params = (filters: Record<string, unknown>, cursor?: number) =>
  Object.fromEntries(new URL(eventsQuery(filters, cursor), "http://x").searchParams);

describe("the activity log page", () => {
  test("with no filter set it reads one page and leaves out routine reads", () => {
    expect(params({})).toEqual({ limit: String(PAGE_SIZE), reads: "failed" });
  });

  test("each filter that is set reaches the query, a category as its op family, and the cursor moves the page", () => {
    expect(params({ box: "bx_1", category: "exec", status: "error", principal: "tok_1", reads: true }, 1234)).toEqual({
      limit: String(PAGE_SIZE),
      box: "bx_1",
      op: "exec.*",
      status: "error",
      principal: "tok_1",
      cursor: "1234",
    });
  });

  test("every category names a family that is recorded, and has a label in both languages", () => {
    const families = new Set([...OPERATIONS.map((operation) => operation.name.split(".")[0]), ...SERVICE_FAMILIES]);
    for (const category of CATEGORIES) {
      expect(families.has(category), category).toBe(true);
      expect(en[`actv.cat.${category}`], category).toBeString();
      expect(zh[`actv.cat.${category}`], category).toBeString();
    }
  });
});
