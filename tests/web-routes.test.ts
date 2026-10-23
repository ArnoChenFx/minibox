import { describe, expect, test } from "bun:test";

import { boxHash, movedBoxHash, resolveRoute, tabHash, terminalHash } from "../web/js/lib/routes.js";

/** The page an address finally opens, once its redirects are followed. `address` is where the person ends up. */
function landing(path: string) {
  let address = path;
  for (let hop = 0; hop < 2; hop += 1) {
    const hit = resolveRoute(address);
    if (!hit) return null;
    if (!("redirect" in hit)) return { address, page: hit.page, nav: hit.nav, args: hit.args };
    address = hit.redirect;
  }
  throw new Error(`${path} keeps redirecting`);
}

const pathOf = (hash: string) => hash.slice(1);

describe("pages without tabs", () => {
  test("each one opens its own page in its own navigation entry", () => {
    expect(landing("/overview")).toMatchObject({ page: "overview", nav: "overview" });
    expect(landing("/boxes")).toMatchObject({ page: "boxes", nav: "boxes" });
    expect(landing("/settings")).toMatchObject({ page: "settings", nav: "settings" });
    expect(landing("/about")).toMatchObject({ page: "about", nav: "about" });
  });

  test("a settings address passes the category it names, so each category keeps its own address", () => {
    expect(landing("/settings")?.args).toEqual([undefined]);
    expect(landing("/settings/secrets")).toMatchObject({ page: "settings", nav: "settings", args: ["secrets"] });
    expect(landing("/settings/tokens")?.args).toEqual(["tokens"]);
    expect(landing("/settingsx")).toBeNull();
  });

  test("the Recycle bin opens from Storage, so Storage stays highlighted", () => {
    expect(landing("/trash")).toMatchObject({ page: "trash", nav: "storage" });
  });

  test("a box address passes the box and the tab it names to the box page", () => {
    expect(landing("/boxes/bx_1")?.args).toEqual(["bx_1", undefined, undefined]);
    expect(landing("/boxes/bx_1/terminal")).toMatchObject({ page: "boxDetail", nav: "boxes" });
    expect(landing("/boxes/bx_1/terminal")?.args).toEqual(["bx_1", "terminal", undefined]);
  });

  test("the box's six tabs each open their own address", () => {
    for (const tab of ["overview", "terminal", "files", "ports", "activity", "settings"]) {
      expect(landing(`/boxes/bx_1/${tab}`)?.args, tab).toEqual(["bx_1", tab, undefined]);
    }
  });

  test("the settings tab passes the section its address names, and no section when the address names none", () => {
    expect(landing("/boxes/bx_1/settings")?.args).toEqual(["bx_1", "settings", undefined]);
    expect(landing("/boxes/bx_1/settings/security")?.args).toEqual(["bx_1", "settings", "security"]);
  });

  test("a box address with more segments than a tab and a section opens nothing", () => {
    expect(landing("/boxes/bx_1/settings/security/extra")).toBeNull();
  });

  test("an address with no page opens nothing", () => {
    expect(landing("/nowhere")).toBeNull();
    expect(landing("/volumesx")).toBeNull();
    expect(landing("/templatesx")).toBeNull();
    expect(landing("/snapshotsx")).toBeNull();
  });

  test("the empty address opens the overview", () => {
    expect(landing("")).toMatchObject({ page: "overview", nav: "overview" });
  });
});

describe("the Activity entry", () => {
  test("opens the overview with its recent-activity card in focus, and highlights Activity", () => {
    expect(landing("/activity")).toMatchObject({ page: "overview", nav: "activity", args: ["activity"] });
  });
});

describe("a box's terminal session", () => {
  test("the address names the session the terminal opens", () => {
    expect(landing("/boxes/bx_1/terminal/work")).toMatchObject({ page: "boxDetail", nav: "boxes" });
    expect(landing("/boxes/bx_1/terminal/work")?.args).toEqual(["bx_1", "terminal", "work"]);
  });

  test("a session name reaches the page decoded", () => {
    expect(landing("/boxes/bx_1/terminal/my%20session")?.args).toEqual(["bx_1", "terminal", "my session"]);
  });

  test("the terminal's address without a session keeps its two segments", () => {
    expect(landing("/boxes/bx_1/terminal")?.args).toEqual(["bx_1", "terminal"]);
  });

  test("a session named on any other tab is dropped, and that tab's address opens", () => {
    expect(landing("/boxes/bx_1/files/work")).toMatchObject({
      address: "/boxes/bx_1/files",
      args: ["bx_1", "files", undefined],
    });
  });

  test("an address with more segments than a session opens no page", () => {
    expect(landing("/boxes/bx_1/terminal/work/extra")).toBeNull();
  });

  test("terminalHash round trips the box and the session, including names that need encoding", () => {
    for (const [boxId, session] of [
      ["bx_1", "work"],
      ["bx one", "a/b"],
    ] as const) {
      expect(landing(pathOf(terminalHash(boxId, session)))?.args).toEqual([boxId, "terminal", session]);
    }
  });

  test("terminalHash without a session addresses the terminal tab itself", () => {
    expect(terminalHash("bx_1")).toBe("#/boxes/bx_1/terminal");
    expect(landing(pathOf(terminalHash("bx_1")))?.args).toEqual(["bx_1", "terminal"]);
  });
});

describe("the Storage and Library sections", () => {
  test("each section opens its first tab when the address names none", () => {
    expect(landing("/storage")).toMatchObject({ address: "/storage/volumes", page: "storage", args: ["volumes", ""] });
    expect(landing("/library")).toMatchObject({
      address: "/library/templates",
      page: "library",
      args: ["templates", ""],
    });
  });

  test("every tab opens with its name in the address and its section highlighted", () => {
    expect(landing("/storage/volumes")).toMatchObject({ page: "storage", nav: "storage", args: ["volumes", ""] });
    expect(landing("/storage/checkpoints")).toMatchObject({
      page: "storage",
      nav: "storage",
      args: ["checkpoints", ""],
    });
    expect(landing("/library/templates")).toMatchObject({ page: "library", nav: "library", args: ["templates", ""] });
    expect(landing("/library/tools")).toMatchObject({ page: "library", nav: "library", args: ["tools", ""] });
  });

  test("the Checkpoints and Tool catalog tabs take the box they work on", () => {
    expect(landing("/storage/checkpoints/bx_1")?.args).toEqual(["checkpoints", "bx_1"]);
    expect(landing("/library/tools/bx_1")?.args).toEqual(["tools", "bx_1"]);
  });

  test("a tab that does not exist opens the section's first tab", () => {
    expect(landing("/storage/nope")?.address).toBe("/storage/volumes");
    expect(landing("/library/nope/bx_1")?.address).toBe("/library/templates");
  });

  test("a tab that takes no box drops the box from the address", () => {
    expect(landing("/storage/volumes/bx_1")?.address).toBe("/storage/volumes");
  });

  test("the template named in the address reaches the page decoded", () => {
    expect(landing("/library/templates/python%20ml")?.args).toEqual(["templates", "python ml"]);
  });

  test("an address that cannot be decoded reaches the page as it was typed", () => {
    expect(landing("/library/tools/%E0%A4%A")?.args).toEqual(["tools", "%E0%A4%A"]);
    expect(landing("/boxes/%E0%A4%A")?.args).toEqual(["%E0%A4%A", undefined]);
  });
});

describe("addresses that moved", () => {
  test("Volumes is now the Volumes tab of Storage", () => {
    expect(landing("/volumes")).toMatchObject({ address: "/storage/volumes", page: "storage" });
  });

  test("Templates is now the Templates tab of Library, and a template keeps its focus", () => {
    expect(landing("/templates")).toMatchObject({ address: "/library/templates", page: "library" });
    expect(landing("/templates/python-ml")).toMatchObject({
      address: "/library/templates/python-ml",
      args: ["templates", "python-ml"],
    });
  });

  test("the old Snapshots address opens the Templates tab, which lists the snapshots that remain", () => {
    expect(landing("/snapshots")).toMatchObject({ address: "/library/templates", page: "library" });
  });

  test("a box tab that became a settings section opens that section, so old links keep working", () => {
    expect(landing("/boxes/bx_1/resources")).toMatchObject({
      address: "/boxes/bx_1/settings/resources",
      page: "boxDetail",
      args: ["bx_1", "settings", "resources"],
    });
    expect(landing("/boxes/bx_1/tools")).toMatchObject({
      address: "/boxes/bx_1/settings/tools",
      args: ["bx_1", "settings", "tools"],
    });
    expect(landing("/boxes/bx_1/checkpoints")).toMatchObject({
      address: "/boxes/bx_1/settings/checkpoints",
      args: ["bx_1", "settings", "checkpoints"],
    });
    expect(landing("/boxes/bx_1/snapshots")).toMatchObject({
      address: "/boxes/bx_1/settings/checkpoints",
      args: ["bx_1", "settings", "checkpoints"],
    });
  });

  test("the box's logs tab opens its activity tab", () => {
    expect(landing("/boxes/bx_1/logs")).toMatchObject({
      address: "/boxes/bx_1/activity",
      args: ["bx_1", "activity", undefined],
    });
  });

  test("each moved address redirects to an address that opens without another redirect", () => {
    for (const path of [
      "/volumes",
      "/templates",
      "/templates/python-ml",
      "/snapshots",
      "/boxes/bx_1/resources",
      "/boxes/bx_1/tools",
      "/boxes/bx_1/checkpoints",
      "/boxes/bx_1/snapshots",
      "/boxes/bx_1/logs",
    ]) {
      const hit = resolveRoute(path);
      expect(hit && "redirect" in hit, path).toBe(true);
      const target = hit && "redirect" in hit ? resolveRoute(hit.redirect) : null;
      expect(target && "redirect" in target, `${path} lands in one hop`).toBe(false);
    }
  });
});

describe("tab addresses", () => {
  test("every tab's address opens that tab", () => {
    for (const [section, tab] of [
      ["storage", "volumes"],
      ["storage", "checkpoints"],
      ["library", "templates"],
      ["library", "tools"],
    ] as const) {
      const hit = landing(pathOf(tabHash(section, tab)));
      expect(hit?.args[0], `${section}/${tab}`).toBe(tab);
      expect(hit?.nav).toBe(section);
    }
  });

  test("the address a tab produces opens the same box or template it was given", () => {
    for (const [section, tab, arg] of [
      ["storage", "checkpoints", "bx_1"],
      ["library", "tools", "bx one/two"],
      ["library", "templates", "python-ml"],
    ] as const) {
      expect(landing(pathOf(tabHash(section, tab, arg)))?.args).toEqual([tab, arg]);
    }
  });

  test("a tab address leaves out the argument when it names no box", () => {
    expect(tabHash("storage", "volumes")).toBe("#/storage/volumes");
    expect(tabHash("library", "tools", "bx one")).toBe("#/library/tools/bx%20one");
  });
});

describe("box tab addresses", () => {
  test("the overview is the box's own address", () => {
    expect(boxHash("bx_1")).toBe("#/boxes/bx_1");
    expect(boxHash("bx_1", "overview")).toBe("#/boxes/bx_1");
  });

  test("each tab and each settings section has an address that opens it", () => {
    expect(boxHash("bx_1", "terminal")).toBe("#/boxes/bx_1/terminal");
    expect(boxHash("bx_1", "settings")).toBe("#/boxes/bx_1/settings");
    expect(boxHash("bx_1", "settings", "env")).toBe("#/boxes/bx_1/settings/env");
    for (const [tab, section] of [
      ["terminal", ""],
      ["settings", "checkpoints"],
    ] as const) {
      expect(landing(pathOf(boxHash("bx_1", tab, section)))?.args).toEqual(["bx_1", tab, section || undefined]);
    }
  });

  test("a section is only part of the address of the settings tab", () => {
    expect(boxHash("bx_1", "terminal", "env")).toBe("#/boxes/bx_1/terminal");
  });

  test("the box id is encoded, and the address opens the same box", () => {
    expect(boxHash("bx one", "files")).toBe("#/boxes/bx%20one/files");
    expect(landing(pathOf(boxHash("bx one", "files")))?.args).toEqual(["bx one", "files", undefined]);
  });

  test("moving to a new id keeps the tab and the section the address names", () => {
    expect(movedBoxHash("#/boxes/old", "old", "new")).toBe("#/boxes/new");
    expect(movedBoxHash("#/boxes/old/terminal", "old", "new")).toBe("#/boxes/new/terminal");
    expect(movedBoxHash("#/boxes/old/settings/env", "old", "new")).toBe("#/boxes/new/settings/env");
  });

  test("an address on another box, or outside the boxes, does not move", () => {
    expect(movedBoxHash("#/boxes/older/terminal", "old", "new")).toBeNull();
    expect(movedBoxHash("#/boxes/other", "old", "new")).toBeNull();
    expect(movedBoxHash("#/overview", "old", "new")).toBeNull();
  });
});
