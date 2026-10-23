import { describe, expect, test } from "bun:test";

import { needsSync, syncSizeMb, templateCards } from "../web/js/lib/template-list.js";

const MB = 1024 * 1024;

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
});
