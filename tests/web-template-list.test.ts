import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";
import {
  forkAction,
  isUnbuilt,
  needsSync,
  syncSizeMb,
  templateBadge,
  templateCards,
  templateDetailRows,
  templateSearchFields,
  withOfficialCards,
} from "../web/js/lib/template-list.js";

const MB = 1024 * 1024;
const BASE = "minibox-template:base";

function copy(hostId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "sha256:python",
    hostId,
    ref: "minibox-template:python",
    tags: ["latest"],
    name: "python",
    description: "Python 3",
    source: null,
    sourceId: null,
    createdBy: null,
    createdAt: "2026-10-20T00:00:00.000Z",
    size: 300 * MB,
    buildKind: "dockerfile" as const,
    ...overrides,
  };
}

describe("template cards", () => {
  test("a template on two hosts is one card that lists both holders, in the order the server gave", () => {
    const cards = templateCards([
      copy("local"),
      copy("lab"),
      copy("local", { ref: "minibox-template:base", name: "base", buildKind: undefined }),
    ]);
    expect(cards.map((card) => card.ref)).toEqual(["minibox-template:python", "minibox-template:base"]);
    expect(cards[0]?.holders).toEqual(["local", "lab"]);
    expect(cards[1]?.holders).toEqual(["local"]);
  });

  test("the card keeps the details of its first copy, so a copy does not replace them", () => {
    const [card] = templateCards([copy("local"), copy("lab", { description: "other" })]);
    expect(card?.description).toBe("Python 3");
    expect(card?.hostId).toBe("local");
  });

  test("the rows the cards are made from are not changed", () => {
    const rows = [copy("local"), copy("lab")];
    templateCards(rows);
    expect(rows[0]).not.toHaveProperty("holders");
  });

  test("no rows make no cards", () => {
    expect(templateCards([])).toEqual([]);
  });
});

describe("the detail rows a template card shows", () => {
  test("a template with both a command and ports shows a row for each", () => {
    expect(templateDetailRows({ postCreate: ["/bin/sh", "-c", "npm install"], forwardPorts: [3000, 8080] })).toEqual([
      { key: "tp.postCreate", text: "npm install" },
      { key: "tp.ports", text: "3000, 8080" },
    ]);
  });

  test("a string command shows by itself, without the sh -c run it becomes", () => {
    expect(templateDetailRows({ postCreate: ["/bin/sh", "-c", "npm install"] })).toEqual([
      { key: "tp.postCreate", text: "npm install" },
    ]);
    expect(templateDetailRows({ postCreate: ["npm", "install"] })).toEqual([
      { key: "tp.postCreate", text: "npm install" },
    ]);
  });

  test("a template with only one of the two shows only its row", () => {
    expect(templateDetailRows({ postCreate: ["/bin/sh", "-c", "npm install"] })).toEqual([
      { key: "tp.postCreate", text: "npm install" },
    ]);
    expect(templateDetailRows({ forwardPorts: [5432] })).toEqual([{ key: "tp.ports", text: "5432" }]);
  });

  test("a template with neither shows no row at all, and no placeholder", () => {
    expect(templateDetailRows({})).toEqual([]);
    expect(templateDetailRows({ forwardPorts: [] })).toEqual([]);
    expect(templateDetailRows({ postCreate: [], forwardPorts: [] })).toEqual([]);
  });
});

describe("copying a template to a host before a box is created there", () => {
  test("a host that lacks the template needs a copy, and a host that holds it does not", () => {
    const [card] = templateCards([copy("local")]);
    expect(needsSync(card, "lab")).toBe(true);
    expect(needsSync(card, "local")).toBe(false);
  });

  test("no card means nothing to copy", () => {
    expect(needsSync(undefined, "lab")).toBe(false);
  });

  test("the notice gives the size in whole megabytes, and never less than one", () => {
    const [card] = templateCards([copy("local", { size: 300 * MB })]);
    expect(card && syncSizeMb(card)).toBe(300);
    expect(syncSizeMb({ size: 1.5 * MB })).toBe(2);
    expect(syncSizeMb({ size: 1000 })).toBe(1);
  });

  test("a template no host holds is never copied, because there is no host to copy from", () => {
    const [card] = withOfficialCards([], OFFICIAL.slice(0, 1));
    expect(needsSync(card, "lab")).toBe(false);
  });
});

describe("the label a template card shows", () => {
  test("the base template is built-in, an official template is official, and everything else is custom", () => {
    expect(templateBadge({ ref: BASE }, BASE)).toBe("tp.builtin");
    expect(templateBadge({ ref: "minibox-template:node", buildKind: "official" }, BASE)).toBe("tp.official");
    expect(templateBadge({ ref: "minibox-template:tool", buildKind: "dockerfile" }, BASE)).toBe("tp.custom");
    // A template the host does not hold has no build kind, and is still custom when it is not the base or an official one.
    expect(templateBadge({ ref: "minibox-template:gold" }, BASE)).toBe("tp.custom");
  });

  test("a fork of an official template is custom, because its source is its own copy of the Dockerfile", () => {
    // The API reports the fork as built from a Dockerfile, as a read of its old recipe does too.
    expect(templateBadge({ ref: "minibox-template:node-copy", buildKind: "dockerfile" }, BASE)).toBe("tp.custom");
  });
});

describe("the fork action a card offers", () => {
  test("a built card, official or not, offers the fork", () => {
    const [node] = withOfficialCards(builtNode(), OFFICIAL);
    expect(node && forkAction(node)).toEqual({ enabled: true, reason: null });
    const [tool] = templateCards([copy("local", { ref: "minibox-template:tool", name: "tool" })]);
    expect(tool && forkAction(tool)).toEqual({ enabled: true, reason: null });
  });

  test("a card no host holds shows the button off, with the reason the dictionaries both carry", () => {
    const [, python] = withOfficialCards(builtNode(), OFFICIAL);
    expect(python && forkAction(python)).toEqual({ enabled: false, reason: "tp.forkUnbuilt" });
    expect(en["tp.forkUnbuilt"]).toContain("Build it first");
    expect(zh["tp.forkUnbuilt"]).toContain("请先构建");
    expect(zh["tp.forkUnbuilt"]).not.toBe(en["tp.forkUnbuilt"]);
  });

  test("the page draws the button from the action, so the off one is disabled and carries the reason", () => {
    const page = readFileSync(join(ROOT, "web", "js", "pages", "templates.js"), "utf8");
    expect(page).toContain("forkAction(tp)");
    expect(page).toMatch(/disabled title="\$\{esc\(t\(fork\.reason\)\)\}"/);
  });
});

const OFFICIAL = [
  { name: "node", ref: "minibox-template:node", description: "Node.js 26", base: "node:26-bookworm-slim" },
  { name: "python", ref: "minibox-template:python", description: "Python 3.14", base: "python:3.14-slim-bookworm" },
];

const builtNode = () =>
  templateCards([copy("local", { ref: "minibox-template:node", name: "node", buildKind: "official" })]);

describe("official templates no host holds yet", () => {
  test("a built official template is one card with its holders, and an unbuilt one follows in catalog order", () => {
    const cards = withOfficialCards(builtNode(), OFFICIAL);
    expect(cards.map((card) => card.ref)).toEqual(["minibox-template:node", "minibox-template:python"]);
    expect(cards[0]?.holders).toEqual(["local"]);
  });

  test("an unbuilt one has no holder and no size, and is unbuilt", () => {
    const [, python] = withOfficialCards(builtNode(), OFFICIAL);
    expect(python && isUnbuilt(python)).toBe(true);
    expect(python?.holders).toEqual([]);
    expect(python?.size).toBeNull();
    expect(python?.buildKind).toBe("official");
  });

  test("a built template is not unbuilt, and a host without it needs a copy", () => {
    const [node] = withOfficialCards(builtNode(), OFFICIAL);
    expect(isUnbuilt(node)).toBe(false);
    expect(needsSync(node, "lab")).toBe(true);
  });

  test("with nothing built, every official template is an unbuilt card", () => {
    expect(withOfficialCards([], OFFICIAL).map((card) => isUnbuilt(card))).toEqual([true, true]);
  });

  test("an unbuilt card can be searched by its name and description like any other", () => {
    const [, python] = withOfficialCards([], OFFICIAL);
    expect(python && templateSearchFields(python, "")).toContain("Python 3.14");
    expect(() => python && templateSearchFields(python, "Official")).not.toThrow();
  });

  test("the rows the official catalog is read from are not changed", () => {
    const catalog = OFFICIAL.map((template) => ({ ...template }));
    withOfficialCards(builtNode(), catalog);
    expect(catalog).toEqual(OFFICIAL);
  });
});
