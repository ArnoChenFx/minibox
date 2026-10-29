import { describe, expect, test } from "bun:test";

import {
  headerState,
  keepSelectable,
  previewOutcome,
  tallyRows,
  toggleAll,
  toggleOne,
  unselectableReason,
} from "../web/js/lib/volume-select.js";

const volume = (id: string, extra: { sharedTools?: boolean; mounts?: unknown[] } = {}) => ({
  id,
  sharedTools: extra.sharedTools ?? false,
  mounts: extra.mounts ?? [],
});

describe("which volumes a batch can select", () => {
  test("the shared tools volume and a volume a box mounts cannot be selected", () => {
    expect(unselectableReason(volume("tools", { sharedTools: true }))).toBe("tools");
    expect(unselectableReason(volume("mounted", { mounts: [{ boxName: "alpha" }] }))).toBe("mounted");
    expect(unselectableReason(volume("plain"))).toBeNull();
  });

  test("a spare tools volume, which the server does not mark as shared, can be selected", () => {
    const spare = { id: "spare", role: "tools", sharedTools: false, mounts: [] };
    expect(unselectableReason(spare)).toBeNull();
    expect([...toggleOne(new Set(), spare, true)]).toEqual(["spare"]);
    expect([...toggleAll(new Set(), [spare, volume("shared", { sharedTools: true })])]).toEqual(["spare"]);
  });

  test("the tools volume is reported as tools even when a box also mounts it", () => {
    expect(unselectableReason(volume("both", { sharedTools: true, mounts: [{}] }))).toBe("tools");
  });
});

describe("the header checkbox", () => {
  const matches = [volume("a"), volume("b", { sharedTools: true }), volume("c", { mounts: [{}] }), volume("d")];

  test("selects every selectable match, and no volume that cannot be selected", () => {
    expect([...toggleAll(new Set(), matches)]).toEqual(["a", "d"]);
  });

  test("clears the selectable matches once they are all selected", () => {
    expect([...toggleAll(new Set(["a", "d"]), matches)]).toEqual([]);
  });

  test("selects the rest of the matches when only some are selected", () => {
    expect([...toggleAll(new Set(["a", "x"]), matches)].toSorted()).toEqual(["a", "d", "x"]);
  });

  test("a volume outside the matches stays selected when the matches are cleared", () => {
    expect([...toggleAll(new Set(["a", "d", "x"]), matches)]).toEqual(["x"]);
  });

  test("shows unchecked, mixed or checked, and is disabled when no match can be selected", () => {
    const pickable = [volume("a"), volume("b")];
    expect(headerState(new Set(), pickable)).toEqual({ disabled: false, checked: false, indeterminate: false });
    expect(headerState(new Set(["a"]), pickable)).toEqual({ disabled: false, checked: false, indeterminate: true });
    expect(headerState(new Set(["a", "b"]), pickable)).toEqual({
      disabled: false,
      checked: true,
      indeterminate: false,
    });
    expect(headerState(new Set(), [volume("t", { sharedTools: true })])).toEqual({
      disabled: true,
      checked: false,
      indeterminate: false,
    });
    expect(headerState(new Set(), [])).toEqual({ disabled: true, checked: false, indeterminate: false });
  });
});

describe("a row's checkbox", () => {
  test("adds a selectable volume, and removes it when unchecked", () => {
    const selected = toggleOne(new Set(), volume("a"), true);
    expect([...selected]).toEqual(["a"]);
    expect([...toggleOne(selected, volume("a"), false)]).toEqual([]);
  });

  test("never adds a volume that cannot be selected", () => {
    expect([...toggleOne(new Set(), volume("tools", { sharedTools: true }), true)]).toEqual([]);
    expect([...toggleOne(new Set(), volume("mounted", { mounts: [{}] }), true)]).toEqual([]);
  });
});

describe("the selection after the list reloads", () => {
  test("keeps only the volumes that still exist and can still be selected", () => {
    const reloaded = [volume("a"), volume("b", { mounts: [{}] })];
    expect([...keepSelectable(new Set(["a", "b", "gone"]), reloaded)]).toEqual(["a"]);
  });
});

describe("the tally of a batch delete or a prune", () => {
  test("counts each outcome, and leaves out the candidates a dry run lists", () => {
    const rows = [
      { status: "removed" },
      { status: "refused" },
      { status: "failed" },
      { status: "removed" },
      { status: "candidate" },
    ];
    expect(tallyRows(rows)).toEqual({ removed: 2, refused: 1, failed: 1 });
  });
});

describe("what a batch delete does with a row of its preview", () => {
  test("a blocked row removes nothing and keeps nothing", () => {
    expect(previewOutcome({ blocked: "in_use", trash: true }, false)).toEqual({
      removes: false,
      keepsCopy: false,
      blocked: "in_use",
    });
  });

  test("a row keeps a copy in the recycle bin unless the delete skips it", () => {
    expect(previewOutcome({ blocked: null, trash: true }, false)).toEqual({
      removes: true,
      keepsCopy: true,
      blocked: null,
    });
    expect(previewOutcome({ blocked: null, trash: true }, true)).toEqual({
      removes: true,
      keepsCopy: false,
      blocked: null,
    });
  });

  test("a volume that keeps no copy, such as a cache volume, is removed without one", () => {
    expect(previewOutcome({ blocked: null, trash: false }, false)).toEqual({
      removes: true,
      keepsCopy: false,
      blocked: null,
    });
  });
});
