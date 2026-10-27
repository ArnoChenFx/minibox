import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";

const WEB = join(ROOT, "web");
const VOLUMES = join(WEB, "js", "pages", "volumes.js");
const volumes = readFileSync(VOLUMES, "utf8");

/** The pool table's rows, as `draw` builds them, up to the end of the pool card. */
const poolRow = volumes.slice(volumes.indexOf("const poolRows = pools"), volumes.indexOf("const roleFields"));

/** The edit dialog's body, as `poolFormHtml` builds it. */
const dialogBody = volumes.slice(volumes.indexOf("const poolFormHtml"), volumes.indexOf("const readPoolForm"));

describe("the pool row's edit button", () => {
  test("every pool but the local one can be edited, as it can be removed", () => {
    expect(poolRow).toContain('data-action="edit-pool"');
    expect(poolRow).toContain('pool.name === "local"');
    // The button is the same shape as Remove: small, named by its row, and labelled from the dictionary.
    expect(poolRow).toMatch(
      /<button class="btn btn-sm" data-action="edit-pool" data-name="\$\{esc\(pool\.name\)\}">\$\{t\("vol\.editPool"\)\}<\/button>/,
    );
    expect(poolRow).toMatch(
      /<button class="btn btn-sm" data-action="remove-pool" data-name="\$\{esc\(pool\.name\)\}">\$\{t\("vol\.removePool"\)\}<\/button>/,
    );
  });

  test("the action opens the pool's form, and the click handler reaches it", () => {
    expect(volumes).toContain('} else if (action === "edit-pool") {');
    expect(volumes).toContain("await editPool(target.dataset.name);");
    expect(volumes).toContain("const editPool = async (name) => {");
  });
});

describe("the edit dialog's fields", () => {
  test("an NFS pool fills name, server, export and options, as the add dialog asks for them", () => {
    for (const id of ["p-name", "p-server", "p-export", "p-options"] as const) {
      expect([id, dialogBody.includes(`id="${id}"`)]).toEqual([id, true]);
    }
    expect(dialogBody).toContain('pool.backend === "nfs"');
    // The values come from the pool, so the form opens filled in rather than blank.
    expect(dialogBody).toContain("const form = poolForm(pool);");
    expect(dialogBody).toContain('value="${esc(form.server)}"');
    expect(dialogBody).toContain('value="${esc(form.export)}"');
    expect(dialogBody).toContain('value="${esc(form.options)}"');
  });

  test("a path pool fills root and marker", () => {
    expect(dialogBody).toContain('id="p-root"');
    expect(dialogBody).toContain('id="p-marker"');
    expect(dialogBody).toContain('value="${esc(form.root)}"');
    expect(dialogBody).toContain('value="${esc(form.marker)}"');
  });

  test("the default flag is a checkbox the form starts from, and the backend is shown but fixed", () => {
    expect(dialogBody).toContain('id="p-default" ${form.default ? "checked" : ""}');
    expect(dialogBody).toContain('id="p-backend"');
    expect(dialogBody).toContain("readonly");
    expect(dialogBody).toContain('t("vol.backendFixed")');
  });

  test("the form says a rename may be refused, and that existing volumes keep their mount parameters", () => {
    expect(dialogBody).toContain('t("vol.editRenameHelp")');
    expect(dialogBody).toContain('t("vol.editMountsHelp")');
    // A refusal from the server is shown in the dialog, not swallowed.
    expect(dialogBody).toContain('id="p-error"');
    expect(volumes).toContain('dialog.querySelector("#p-error").textContent = text;');
  });
});

describe("saving an edited pool", () => {
  const editPool = volumes.slice(volumes.indexOf("const editPool = async"), volumes.indexOf("const addPool = (pool)"));

  test("the edit goes through the page's own save path, with the same preview and confirmation", () => {
    expect(editPool).toContain("await putPools(body, poolChanges(savedPools, pools))");
    expect(editPool).not.toContain('api("/api/pools"');
    expect(editPool).not.toContain("confirm: true");
    // The add dialogs use the same validation and draft builder, so one rule covers both.
    expect(volumes).toContain("const checked = poolDraft(form, { pools });");
    expect(volumes).toContain("const checked = poolDraft(readPoolForm(dialog, pool), { pool, pools });");
    expect(volumes).toContain("addPool(checked.pool);");
  });

  test("a refused or cancelled save leaves the page's list as it was and keeps the dialog open", () => {
    expect(editPool).toContain("pools = previous;");
    expect(editPool).toContain("return false;");
    expect(editPool).toContain('fail(err.message, renamed ? "p-name" : "");');
    // The dialog's confirm runs the save, and closing it without one resolves to null.
    expect(volumes).toContain("function formDialog(title, body, submit) {");
    expect(volumes).toContain("if (submit && (await submit(root)) === false) return;");
  });

  test("a rename carries the role defaults with it", () => {
    expect(editPool).toContain("body.roles = renameRole(body.roles, pool.name, checked.pool.name);");
  });
});

describe("the pool form's words", () => {
  const added = [
    "vol.editPool",
    "vol.editPoolTitle",
    "vol.backendFixed",
    "vol.editRenameHelp",
    "vol.editMountsHelp",
    "vol.optionsRequired",
    "vol.savePreviewChanged",
  ] as const;

  test("each new key is in both dictionaries, with its own Chinese text", () => {
    for (const key of added) {
      expect([key, key in en, key in zh, zh[key] !== en[key]]).toEqual([key, true, true, true]);
    }
  });

  test("the rename and mount help name what is refused and what stays as it is, in both languages", () => {
    expect(en["vol.editRenameHelp"]).toContain("pool_in_use");
    expect(en["vol.editRenameHelp"]).toMatch(/rename/i);
    expect(zh["vol.editRenameHelp"]).toContain("pool_in_use");
    expect(zh["vol.editRenameHelp"]).toContain("改名");
    expect(en["vol.editMountsHelp"]).toMatch(/volumes that already exist/i);
    expect(zh["vol.editMountsHelp"]).toContain("已存在的卷");
    expect(en["vol.editMountsHelp"]).toContain("created with");
    expect(zh["vol.editMountsHelp"]).toContain("创建时的挂载参数");
  });

  test("the edit title names the pool it edits", () => {
    expect(en["vol.editPoolTitle"]).toContain("{name}");
    expect(zh["vol.editPoolTitle"]).toContain("{name}");
  });

  test("the save preview says a changed pool's parameters change", () => {
    expect(en["vol.savePreviewChanged"]).toContain("{name}");
    expect(zh["vol.savePreviewChanged"]).toContain("{name}");
    expect(volumes).toContain("poolPreviewHtml(err.details.preview, changed)");
  });
});
