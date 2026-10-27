import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";

/**
 * A narrow phone: the page never scrolls sideways, and the two bars that used to run past a 320px window keep their
 * buttons on it. The browser test next to this one measures the same pages; these tests read the stylesheet, so a rule
 * that stops matching fails without a browser.
 */
const WEB = join(ROOT, "web");
const RESPONSIVE = readFileSync(join(WEB, "css", "app", "responsive-fixes.css"), "utf8");
const LAYOUT = readFileSync(join(WEB, "css", "app", "layout.css"), "utf8");

/** The body of a rule, braces matched. Throws when the selector is not there. */
function block(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  let depth = 0;
  for (let index = css.indexOf("{", at); index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return indentless(css.slice(at, index + 1));
    }
  }
  throw new Error(`unbalanced rule for ${selector}`);
}

/** The same text with every line's indentation removed, so a rule reads the same wherever it is nested. */
const indentless = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .join("\n");

/** The body of the narrowest `@media (max-width: Npx)` block that mentions `needle`, braces matched. */
function mediaBlock(css: string, width: number, needle: string): string {
  const starts = [...css.matchAll(new RegExp(`@media \\(max-width: ${width}px\\) \\{`, "g"))].map(
    (match) => match.index ?? 0,
  );
  for (const at of starts) {
    let depth = 0;
    for (let index = css.indexOf("{", at); index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          const body = indentless(css.slice(at, index + 1));
          if (body.includes(needle)) return body;
          break;
        }
      }
    }
  }
  throw new Error(`no @media (max-width: ${width}px) block mentions ${needle}`);
}

/** The body of a `@media (min-width: Npx)` block that mentions `needle`, braces matched. */
function mediaBlockFrom(css: string, from: number, needle: string): string {
  const starts = [...css.matchAll(new RegExp(`@media \\(min-width: ${from}px\\) \\{`, "g"))].map(
    (match) => match.index ?? 0,
  );
  for (const at of starts) {
    let depth = 0;
    for (let index = css.indexOf("{", at); index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          const body = indentless(css.slice(at, index + 1));
          if (body.includes(needle)) return body;
          break;
        }
      }
    }
  }
  throw new Error(`no @media (min-width: ${from}px) block mentions ${needle}`);
}

/** The body of a `@media (min-width: Apx) and (max-width: Bpx)` block that mentions `needle`, braces matched. */
function mediaBlockBetween(css: string, from: number, to: number, needle: string): string {
  const starts = [
    ...css.matchAll(new RegExp(`@media \\(min-width: ${from}px\\) and \\(max-width: ${to}px\\) \\{`, "g")),
  ].map((match) => match.index ?? 0);
  for (const at of starts) {
    let depth = 0;
    for (let index = css.indexOf("{", at); index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          const body = indentless(css.slice(at, index + 1));
          if (body.includes(needle)) return body;
          break;
        }
      }
    }
  }
  throw new Error(`no @media (min-width: ${from}px) and (max-width: ${to}px) block mentions ${needle}`);
}

describe("a narrow phone's top bar", () => {
  test("the trail takes what the icons leave, and ends in an ellipsis instead of pushing them off", () => {
    const phone = mediaBlock(RESPONSIVE, 900, ".topbar .crumbs {");
    // The trail can shrink, and its parts clip rather than overflow the bar.
    expect(block(phone, ".topbar .crumbs")).toContain("min-width: 0;");
    expect(block(phone, ".topbar .crumbs")).toContain("overflow: hidden;");
    const parts = block(phone, ".topbar .crumbs > *");
    expect(parts).toContain("min-width: 0;");
    expect(parts).toContain("text-overflow: ellipsis;");
    expect(parts).toContain("white-space: nowrap;");
    // The separators keep their width, so a clipped trail still reads as one.
    expect(block(phone, ".topbar .crumbs > .sep")).toContain("flex: 0 0 auto;");
  });

  test("the trail is allowed to shrink by being flexed, not by being hidden from the box model", () => {
    // `min-width: 0` on the trail is what lets a long box name shrink; without it the flex item keeps its content width.
    const wide = block(LAYOUT, ".topbar .crumbs");
    expect(wide).toContain("display: flex;");
    expect(mediaBlock(RESPONSIVE, 900, ".topbar .crumbs {")).toContain("min-width: 0;");
  });
});

describe("the single-column grids on a phone", () => {
  test("a phone's one-column grid shrinks with the window instead of taking its contents' width", () => {
    const phone = mediaBlock(RESPONSIVE, 900, ".grid-2,");
    // A bare `1fr` is floored at min-content, so one long box name would push the page sideways.
    for (const selector of [".grid-4,", ".grid-3,", ".grid-2,", ".grid-fit"]) {
      expect(phone).toContain(selector);
    }
    expect(block(phone, ".grid-4,\n.grid-3,\n.grid-2,\n.grid-fit")).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(phone).not.toMatch(/\.grid-[234][\s\S]*?grid-template-columns: 1fr;/);
    expect(block(phone, ".kv-cols")).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(block(phone, ".segmented")).toContain("grid-template-columns: repeat(2, minmax(0, 1fr));");
  });
});

describe("a row of choices on a phone", () => {
  test("three or four options keep their count and shrink, instead of running past the window", () => {
    const phone = mediaBlock(RESPONSIVE, 900, ".segmented.segmented-3 {");
    // A bare `1fr` is floored at min-content, so the longest hint of a three-option row pushed the page sideways.
    expect(block(phone, ".segmented.segmented-3")).toContain("grid-template-columns: repeat(3, minmax(0, 1fr));");
    expect(block(phone, ".segmented.segmented-4")).toContain("grid-template-columns: repeat(4, minmax(0, 1fr));");
    expect(block(phone, ".segmented")).toContain("grid-template-columns: repeat(2, minmax(0, 1fr));");
  });
});

describe("a create row's volume name in the Customize dialog", () => {
  test("the volume name and the pool share the first line, and the path, mode and button the second", () => {
    // Five cells in one line do not fit the dialog: measured at 1280px, adding the storage pool took the volume name to
    // 80px and it read one letter per line. So the volume control and the pool control take the first line together, and
    // the path, the mode and the remove button the second — at every width above the phone, not only on a narrow one.
    const modal = readFileSync(join(WEB, "css", "app", "modal.css"), "utf8");
    const wide = mediaBlockFrom(modal, 561, "#cbMountRows .rebuild-mount {");
    expect(block(wide, "#cbMountRows .rebuild-mount")).toContain(
      '"volume volume volume pool"\n"path   path   mode   remove";',
    );
    expect(block(wide, "#cbMountRows .rebuild-mount > [data-volume] + .dropdown-trigger")).toContain(
      "grid-area: volume;",
    );
    // The dropdown component keeps the native select out of the flow and draws a trigger beside it, so each control's
    // area goes on the trigger that follows it.
    expect(block(wide, "#cbMountRows .rebuild-mount > [data-mode] + .dropdown-trigger")).toContain("grid-area: mode;");
    expect(block(wide, "#cbMountRows .rebuild-mount > [data-pool] + .dropdown-trigger")).toContain("grid-area: pool;");
    // A row that mounts a volume that exists has no pool control, so its volume takes the whole first line instead of
    // leaving a gap where the control would be.
    expect(block(wide, "#cbMountRows .rebuild-mount:not(:has([data-pool]))")).toContain(
      '"volume volume volume volume"\n"path   path   mode   remove";',
    );
  });

  test("a rebuild row keeps its one-line columns, because it types its volume in a plain input", () => {
    const modal = readFileSync(join(WEB, "css", "app", "modal.css"), "utf8");
    expect(block(modal, ".rebuild-mount")).toContain(
      "grid-template-columns: minmax(0, 1.8fr) minmax(0, 1fr) 132px auto;",
    );
  });

  test("between the phone and the desktop the row takes three lines rather than squeezing the path", () => {
    // At 561px the dialog is 513px wide: the path, mode, pool and button on one line leave the path under the ~140px
    // `/home/dev/.cache` needs. So the path and mode take the second line and the pool and button the third.
    const stacked = mediaBlockBetween(RESPONSIVE, 561, 700, "#cbMountRows .rebuild-mount {");
    expect(block(stacked, "#cbMountRows .rebuild-mount")).toContain(
      "grid-template-columns: minmax(0, 1fr) minmax(96px, 140px);",
    );
    expect(block(stacked, "#cbMountRows .rebuild-mount")).toContain('"volume pool"');
    expect(block(stacked, "#cbMountRows .rebuild-mount")).toContain('"path   mode"');
    expect(block(stacked, "#cbMountRows .rebuild-mount")).toContain('"remove remove"');
    // The path column keeps a 140px floor on the desktop grid, so a path never truncates where there is room for it.
    const modal = readFileSync(join(WEB, "css", "app", "modal.css"), "utf8");
    const wide = mediaBlockFrom(modal, 561, "#cbMountRows .rebuild-mount {");
    expect(block(wide, "#cbMountRows .rebuild-mount")).toContain(
      "grid-template-columns: minmax(140px, 1fr) 132px minmax(96px, 140px) auto;",
    );
    expect(block(wide, "#cbMountRows .rebuild-mount")).not.toContain("overflow-x");
  });
});

describe("a box's title bar on a phone", () => {
  test("every button keeps its text as the accessible name while its label is hidden", () => {
    const phone = mediaBlock(RESPONSIVE, 560, ".detail-head .page-actions > .btn:not(:first-child)");
    const icons = block(phone, ".detail-head .page-actions > .btn:not(:first-child)");
    expect(icons).toContain("width: 34px;");
    expect(icons).toContain("font-size: 0;");
    // Wrapped rather than squeezed: a longer translation falls onto a second line instead of off the window.
    expect(block(phone, ".detail-head .page-actions")).toContain("flex-wrap: wrap;");
  });

  test("the labelled first button becomes an icon below 353px, where seven labelled-or-icon buttons no longer fit", () => {
    const narrow = mediaBlock(RESPONSIVE, 352, ".detail-head .page-actions > .btn:first-child");
    const first = block(narrow, ".detail-head .page-actions > .btn:first-child");
    expect(first).toContain("width: 34px;");
    expect(first).toContain("padding: 0;");
    expect(first).toContain("font-size: 0;");
    expect(first).toContain("gap: 0;");
    // Seven 34px buttons and the six 6px gaps between them fit the 288px a 320px page leaves.
    expect(7 * 34 + 6 * 6).toBeLessThanOrEqual(288);
  });
});
