import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";

const WEB = join(ROOT, "web");
const TABLES = join(WEB, "css", "app", "tables.css");
const VOLUMES = join(WEB, "js", "pages", "volumes.js");

const tables = readFileSync(TABLES, "utf8");
const volumes = readFileSync(VOLUMES, "utf8");

/** The body of the last `@media (max-width: 640px)` block that mentions `needle`, braces matched. */
function phoneBlock(needle: string): string {
  const starts = [...tables.matchAll(/@media \(max-width: 640px\) \{/g)].map((match) => match.index ?? 0);
  const at = starts.find((index) => {
    const end = index + tables.slice(index).indexOf("\n}\n");
    return tables.slice(index, end).includes(needle);
  });
  if (at === undefined) throw new Error(`no 640px block mentions ${needle}`);
  let depth = 0;
  for (let index = tables.indexOf("{", at); index < tables.length; index += 1) {
    if (tables[index] === "{") depth += 1;
    else if (tables[index] === "}") {
      depth -= 1;
      if (depth === 0) return tables.slice(at, index + 1);
    }
  }
  throw new Error("unbalanced braces");
}

/** One rule's body from `css`, or "" when the selector is not there. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped} \\{([^}]*)\\}`))?.[1] ?? "";
}

const phone = phoneBlock(".table.vol-table");

describe("the volumes table on a phone", () => {
  test("the card rules live in the 640px block of tables.css, beside the checkpoint cards", () => {
    expect(phone.startsWith("@media (max-width: 640px) {")).toBe(true);
    // The table stops scrolling: no fixed min-width, and the row is the card.
    expect(rule(phone, ".table.vol-table")).toContain("min-width: 0;");
    expect(rule(phone, ".table.vol-table,\n  .table.vol-table tbody")).toContain("display: block;");
    expect(rule(phone, ".table.vol-table tr")).toContain("display: grid;");
    expect(rule(phone, ".table.vol-table tr")).toContain("grid-template-areas:");
  });

  test("each cell takes its place from a named grid area, so no column is left to overflow", () => {
    const row = rule(phone, ".table.vol-table tr");
    const areas = row.match(/grid-template-areas:\s*([^;]+);/)?.[1] ?? "";
    expect(areas).not.toBe("");
    const placed: [string, string][] = [
      ["select-cell", "select"],
      ["vol-name", "name"],
      ["vol-status-cell", "status"],
      ["vol-usage", "usage"],
      ["vol-mounts", "mounts"],
      ["vol-owner", "owner"],
      ["vol-pool", "pool"],
      ["vol-latest-cell", "latest"],
      ["vol-actions", "actions"],
    ];
    for (const [cls, area] of placed) {
      // The area is one the grid lays out, and the cell is put in it.
      expect([cls, areas.includes(area)]).toEqual([cls, true]);
      expect([cls, rule(phone, `.table.vol-table .${cls}`).includes(`grid-area: ${area};`)]).toEqual([cls, true]);
    }
    // Every area the grid lays out is claimed by a cell, so none is left empty.
    const laid = new Set(areas.match(/"[^"]+"/g)?.flatMap((line) => line.replace(/"/g, "").trim().split(/\s+/)) ?? []);
    expect([...laid].toSorted()).toEqual(placed.map(([, area]) => area).toSorted());
  });

  test("the column headers are gone but the select-all box stays, so rows can still be picked and deleted", () => {
    expect(rule(phone, ".table.vol-table thead th")).toContain("display: none;");
    const selectAll = rule(phone, ".table.vol-table thead th.select-cell");
    expect(selectAll).toContain("display: flex;");
    // The box names itself, as the header row it used to sit in no longer does.
    expect(phone).toContain(".table.vol-table thead th.select-cell::after {\n    content: attr(data-label);");
    expect(volumes).toMatch(/<th class="select-cell" data-label="\$\{esc\(t\("vol\.selectAllShort"\)\)\}"/);
  });

  test("a field names itself from data-label, because the header that named it is hidden", () => {
    expect(rule(phone, ".table.vol-table td[data-label]::before")).toContain("content: attr(data-label);");
    // Every field but the name, the status and the actions has a header of its own to carry over.
    for (const [cls, key] of [
      ["vol-usage", "vol.colSize"],
      ["vol-mounts", "vol.colMounts"],
      ["vol-owner", "vol.colOwnership"],
      ["vol-pool", "vol.colPool"],
      ["vol-latest-cell", "vol.colLatest"],
    ] as const) {
      expect([cls, volumes.includes(`class="${cls}`) && volumes.includes(`data-label="\${esc(t("${key}"))}"`)]).toEqual([
        cls,
        true,
      ]);
    }
  });

  test("a field with nothing in it is left out, so a card is not a column of dashes", () => {
    expect(rule(phone, ".table.vol-table td.vol-empty")).toContain("display: none;");
    // A volume that mounts nowhere, and one with no checkpoint, carry the marker.
    expect(volumes).toContain('class="vol-mounts${empty(!volume.mounts.length)}"');
    expect(volumes).toContain('class="vol-latest-cell${empty(!checkpoint)}"');
  });

  test("a group header, the show-all button and an empty state keep a row of their own", () => {
    expect(rule(phone, ".table.vol-table tr.group-row,\n  .table.vol-table tr.toggle-row")).toContain("display: block;");
    expect(rule(phone, ".table.vol-table tr > td[colspan]")).toContain("grid-column: 1 / -1;");
  });

  test("while the list loads, a skeleton row is one line instead of nine empty cells", () => {
    expect(phone).toContain(".table.vol-table tr:not(:has(.vol-name)) > td:not([colspan]) {\n    display: none;");
  });

  test("the accent of a volume over its limit moves from the first cell to the card", () => {
    expect(phone).toContain(
      "  .table.vol-table tr.volume-over-soft,\n  .table.vol-table tr.volume-over-hard {\n    box-shadow: inset 3px 0 0 var(--warning);\n  }",
    );
    expect(phone).toContain(
      "  .table.vol-table tr.volume-over-hard {\n    box-shadow: inset 3px 0 0 var(--danger);\n  }",
    );
    expect(rule(phone, ".table.vol-table tr.volume-over-hard > td:first-child")).toContain("box-shadow: none;");
  });
});

describe("the volumes table above 640px", () => {
  /** Everything in tables.css outside a `max-width` block, so the desktop rules can be read on their own. */
  const desktop = tables.replace(/@media \(max-width: \d+px\) \{[\s\S]*?\n\}\n/g, "");

  test("the desktop rows are still a table, with every column it had", () => {
    // No card layout leaks out of the phone block.
    expect(desktop).not.toContain("grid-template-areas");
    expect(rule(desktop, ".table.vol-table :is(th, td)")).toContain("white-space: nowrap;");
    expect(rule(desktop, ".table td.vol-name")).toContain("max-width: 200px;");
    expect(rule(desktop, ".table td.vol-mounts")).toContain("max-width: 150px;");
    expect(rule(desktop, ".table td.vol-pool")).toContain("max-width: 130px;");
    expect(rule(desktop, ".table td.vol-latest-cell")).toContain("max-width: 110px;");
  });

  test("the row keeps its nine cells, the checkbox first and the actions last", () => {
    const row = volumes.slice(volumes.indexOf("function volumeRow("), volumes.indexOf("function groupRow("));
    const cells = [...row.matchAll(/<td class="([^"]*)"/g)].map((match) => match[1]);
    expect(cells.length).toBe(9);
    expect(cells[0]).toBe("select-cell");
    expect(cells[1]).toContain("vol-name");
    expect(cells[8]).toContain("vol-actions");
  });
});

describe("the select-all label on a phone", () => {
  test("both languages name the header box in a word, beside the long name the box's aria-label keeps", () => {
    for (const [lang, dictionary] of [
      ["en", en],
      ["zh-CN", zh],
    ] as const) {
      const short = dictionary["vol.selectAllShort"] ?? "";
      expect([lang, short.length > 0]).toEqual([lang, true]);
      expect([lang, short.includes("{")]).toEqual([lang, false]);
      expect([lang, dictionary["vol.selectAll"]!.length > short.length]).toEqual([lang, true]);
    }
    expect(en["vol.selectAllShort"]).toBe("Select all");
    expect(zh["vol.selectAllShort"]).toBe("全选");
  });
});
