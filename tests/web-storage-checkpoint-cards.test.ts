import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";

const WEB = join(ROOT, "web");
const TABLES = join(WEB, "css", "app", "tables.css");
const STORAGE = join(WEB, "js", "components", "storage-checkpoints.js");

const tables = readFileSync(TABLES, "utf8");
const storage = readFileSync(STORAGE, "utf8");

/** The body of the `@media (max-width: 640px)` block that mentions `needle`, braces matched. */
function phoneBlock(needle: string): string {
  const starts = [...tables.matchAll(/@media \(max-width: 640px\) \{/g)].map((match) => match.index ?? 0);
  for (const at of starts) {
    let depth = 0;
    for (let index = tables.indexOf("{", at); index < tables.length; index += 1) {
      if (tables[index] === "{") depth += 1;
      else if (tables[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          const block = tables.slice(at, index + 1);
          if (block.includes(needle)) return block;
          break;
        }
      }
    }
  }
  throw new Error(`no 640px block mentions ${needle}`);
}

/** One rule's body from `css`, or "" when the selector is not there. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped} \\{([^}]*)\\}`))?.[1] ?? "";
}

const phone = phoneBlock(".table.sck-table");
/** Everything in tables.css outside a `max-width` block, so the desktop rules can be read on their own. */
const desktop = tables.replace(/@media \(max-width: \d+px\) \{[\s\S]*?\n\}\n/g, "");

/** The row markup `rowHtml` builds, with its template literals filled in, so a cell's class list can be read. */
const rowSource = storage.slice(storage.indexOf("function rowHtml("), storage.indexOf("function groupHeadHtml("));

describe("the storage checkpoints table on a phone", () => {
  test("the card rules live in a 640px block of tables.css, and the table stops scrolling", () => {
    expect(phone.startsWith("@media (max-width: 640px) {")).toBe(true);
    // The table's desktop min-width is what made it scroll sideways; on a phone the row is the card.
    expect(rule(desktop, ".table.sck-table")).toContain("min-width: 820px;");
    expect(rule(phone, ".table.sck-table")).toContain("min-width: 0;");
    expect(rule(phone, ".table.sck-table,\n  .table.sck-table tbody")).toContain("display: block;");
    expect(rule(phone, ".table.sck-table tr")).toContain("display: grid;");
  });

  test("the header row is gone, since each field names itself or reads as what it is", () => {
    expect(rule(phone, ".table.sck-table colgroup,\n  .table.sck-table thead")).toContain("display: none;");
    // The label, the time, the size and the kinds carry their own meaning; only the contents take a label.
    expect(rule(phone, ".table.sck-table td[data-label]::before")).toContain("content: attr(data-label);");
    expect(storage).toContain('data-label="${esc(t("ck.colContents"))}"');
    expect(storage).not.toContain('data-label="${esc(t("ck.colTaken"))}"');
    expect(storage).not.toContain('data-label="${esc(t("ck.colLabel"))}"');
  });

  test("each cell takes its place from a named grid area, so no column is left to overflow", () => {
    const row = rule(phone, ".table.sck-table tr");
    const areas = row.match(/grid-template-areas:\s*([^;]+);/)?.[1] ?? "";
    expect(areas).not.toBe("");
    const placed: [string, string][] = [
      ["sck-label", "label"],
      ["sck-kind-cell", "kind"],
      ["sck-time", "time"],
      ["sck-size", "size"],
      ["sck-contents", "contents"],
      ["sck-actions", "actions"],
    ];
    for (const [cls, area] of placed) {
      expect([cls, areas.includes(area)]).toEqual([cls, true]);
      expect([cls, rule(phone, `.table.sck-table .${cls}`).includes(`grid-area: ${area};`)]).toEqual([cls, true]);
    }
    // Every area the grid lays out is claimed by a cell, so none is left empty.
    const laid = new Set(areas.match(/"[^"]+"/g)?.flatMap((line) => line.replace(/"/g, "").trim().split(/\s+/)) ?? []);
    expect([...laid].toSorted()).toEqual(placed.map(([, area]) => area).toSorted());
  });

  test("the first and last cells drop the card's 18px padding, which the card-table rule would otherwise keep", () => {
    // The general card-table rule is more specific than a plain `.table.sck-table td`, so it is beaten head-on.
    expect(desktop).toContain(".card > .table-wrap > .table tr:not(.group-row) > :is(th, td):first-child");
    expect(phone).toContain(
      "  .card > .table-wrap > .table.sck-table tr:not(.group-row) > td:is(:first-child, :last-child) {\n    padding-left: 0;\n    padding-right: 0;\n  }",
    );
    expect(rule(phone, ".card > .table-wrap > .table.sck-table tr > td:is(:first-child, :last-child)")).toContain(
      "padding: 0;",
    );
  });

  test("a field with nothing in it is left out, so a card is not a column of dashes", () => {
    expect(rule(phone, ".table.sck-table td.sck-empty")).toContain("display: none;");
    expect(storage).toContain('const contentsClass = contents === "—" ? "sck-contents sck-empty" : "sck-contents";');
    expect(storage).toContain('<td class="${contentsClass}"');
  });

  test("a group header, the show-all button and an empty state keep a row of their own", () => {
    expect(rule(phone, ".table.sck-table tr.group-row,\n  .table.sck-table tr.toggle-row")).toContain(
      "display: block;",
    );
    expect(rule(phone, ".table.sck-table tr > td[colspan]")).toContain("grid-column: 1 / -1;");
    expect(rule(phone, ".table.sck-table tr.toggle-row > td")).toContain("padding: 6px 18px;");
    // The group header's own button still fills the row, which spans every column.
    expect(rowSource).not.toContain("group-row");
    expect(storage).toContain('<tr class="group-row sck-group" data-group=');
  });
});

describe("the storage checkpoints table above 640px", () => {
  test("the desktop rows are still a table, with the six columns it had", () => {
    // No card layout leaks out of the phone block.
    expect(desktop).not.toContain("grid-template-areas");
    expect(rule(desktop, ".table.sck-table :is(th, td)")).toContain("padding-left: 12px;");
    expect(rule(desktop, ".table.sck-table td")).toContain("padding-top: 9px;");
    const head = storage.slice(storage.indexOf('<table class="table sck-table">'), storage.indexOf("</thead>"));
    expect([...head.matchAll(/<th[\s>]/g)].length).toBe(6);
    for (const width of ["sck-c-time", "sck-c-kind", "sck-c-contents", "sck-c-size", "sck-c-actions"] as const) {
      expect([width, rule(desktop, `.${width}`).includes("width:")]).toEqual([width, true]);
    }
  });

  test("the row keeps its six cells in the order the columns are in, and the desktop styles name them", () => {
    const cells = [...rowSource.matchAll(/<td class="([^"]*)"/g)].map((match) => match[1]);
    expect(cells.length).toBe(6);
    expect(cells[0]).toContain("sck-time");
    expect(cells[1]).toContain("sck-label");
    expect(cells[2]).toContain("sck-kind-cell");
    // The contents cell picks its class from whether it has anything to show, so the empty marker can hide it.
    expect(cells[3]).toBe("${contentsClass}");
    expect(cells[4]).toContain("sck-size");
    expect(cells[5]).toContain("sck-actions");
  });
});

describe("the storage checkpoints table's contents label", () => {
  test("both languages name the column, so the phone card has a word for it", () => {
    expect(en["ck.colContents"]).toBe("Contents");
    expect(zh["ck.colContents"]).toBe("内容");
  });
});
