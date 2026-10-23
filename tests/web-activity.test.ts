import { describe, expect, test } from "bun:test";

import { OPERATIONS } from "../src/operations/registry";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";
import { ACTION_ICON, readableAction } from "../web/js/lib/activity.js";
import { icon } from "../web/js/lib/icons.js";

/** Inputs that reach every branch of an activity name: box power actions and background execs name themselves by input. */
const PROBES: Record<string, unknown>[] = [
  {},
  { background: true },
  { action: "start" },
  { action: "stop" },
  { action: "restart" },
];

const recorded = [
  ...new Set(
    OPERATIONS.flatMap((operation) =>
      operation.activity ? PROBES.map((input) => operation.activity?.action(input) ?? "") : [],
    ),
  ),
]
  .filter((action) => action && !action.includes("undefined"))
  .toSorted();

describe("overview recent activity", () => {
  test("the registry scan finds the actions the feed records, so the checks below cannot pass vacuously", () => {
    expect(recorded).toEqual(
      expect.arrayContaining(["box.start", "exec.background", "template.create", "notify.channel.test"]),
    );
  });

  test("every action the server records has an icon the icon set draws", () => {
    const fallback = icon("__none__");
    const missing = recorded.filter((action) => {
      const name = ACTION_ICON[action];
      return !name || icon(name) === fallback;
    });
    expect(missing).toEqual([]);
  });

  test("every action the server records has its own English and Chinese label", () => {
    const missing = recorded.filter((action) => {
      const key = `act.${action}`;
      return !(key in en) || !(key in zh) || en[key] === zh[key];
    });
    expect(missing).toEqual([]);
  });

  test("an action with no label reads as words instead of its raw name", () => {
    expect(readableAction("notify.channel.test")).toBe("Notify channel test");
    expect(readableAction("tool.custom_put")).toBe("Tool custom put");
    expect(readableAction("")).toBe("");
  });
});
