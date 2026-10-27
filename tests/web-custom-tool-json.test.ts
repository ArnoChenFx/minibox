import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";
import {
  copyId,
  parseToolJson,
  TOOL_JSON_FIELDS,
  toolJsonEntry,
  toolJsonText,
} from "../web/js/lib/custom-tool-json.js";
import type { ToolStatusLike } from "../web/js/lib/custom-tool-json.js";
import {
  COMMAND_FIELDS,
  CUSTOM_LIMITS,
  customToolForm,
  isBuiltinId,
  validCustomId,
} from "../web/js/lib/custom-tool.js";

const WEB = join(ROOT, "web");
const read = (path: string) => readFileSync(join(WEB, path), "utf8");
const TOOLS_ROW = read(join("js", "components", "box-tools.js"));
const DIALOG = read(join("js", "components", "custom-tool-dialog.js"));
const CATALOG = JSON.parse(readFileSync(join(ROOT, "catalog", "bun.json"), "utf8")) as Record<string, unknown>;

/** A tool as `GET /api/tools` lists it: the merged catalog entry, with the commands, plus the install status. */
const BUN = {
  ...CATALOG,
  requires: null,
  desiredVersion: null,
  installed: false,
  installedVersion: null,
  managed: false,
} as unknown as ToolStatusLike;

describe("the JSON a tool row copies", () => {
  test("the copy is the catalog entry, in the catalog's field order, so it reads like a catalog/*.json file", () => {
    expect(Object.keys(JSON.parse(toolJsonText(toolJsonEntry(BUN as never))))).toEqual([
      "id",
      "name",
      "description",
      "category",
      "source",
      "package",
      "bin",
      "needsRoot",
      "estimatedMb",
      "install",
      "upgrade",
      "uninstall",
      "detect",
    ]);
    // Two spaces of indent and a trailing newline, as saveCustomEntry writes a tools.d file.
    expect(toolJsonText(toolJsonEntry(BUN as never))).toBe(`${JSON.stringify(CATALOG, null, 2)}\n`);
  });

  test("requires and stop appear only when the entry sets them", () => {
    const withOptionals = toolJsonText(
      toolJsonEntry({ ...BUN, requires: "Node ≥ 20", stop: "{{prefix}}/bin/bun stop" } as never),
    );
    const keys = Object.keys(JSON.parse(withOptionals));
    expect(keys).toContain("requires");
    expect(keys).toContain("stop");
    // The catalog's own order keeps `requires` after the size and `stop` between uninstall and detect.
    expect(keys.slice(keys.indexOf("estimatedMb"), keys.indexOf("install"))).toEqual(["estimatedMb", "requires"]);
    expect(keys.slice(keys.indexOf("uninstall"), keys.indexOf("detect"))).toEqual(["uninstall", "stop"]);
    // A blank optional is left out rather than written as an empty string, as the server's own writer does.
    const blank = Object.keys(JSON.parse(toolJsonText(toolJsonEntry({ ...BUN, requires: "  ", stop: "" } as never))));
    expect(blank).not.toContain("requires");
    expect(blank).not.toContain("stop");
  });

  test("the copy carries the entry's commands, not the install status, which a pasted description cannot use", () => {
    const text = toolJsonText(
      toolJsonEntry({ ...BUN, installed: true, managed: true, desiredVersion: "latest" } as never),
    );
    for (const field of ["installed", "installedVersion", "managed", "desiredVersion"]) {
      expect([field, text.includes(`"${field}"`)]).toEqual([field, false]);
    }
    expect(text).toContain("npm install -g --prefix {{prefix}} {{package_spec}}");
  });

  test("the fields a copy writes are the ones a paste reads, so a copy always goes back in", () => {
    expect(TOOL_JSON_FIELDS).toEqual([
      "id",
      "name",
      "description",
      "category",
      "source",
      "package",
      "bin",
      "needsRoot",
      "estimatedMb",
      "requires",
      ...COMMAND_FIELDS,
    ]);
  });
});

describe("pasting a JSON description", () => {
  const taken = new Set(["bun", "codex"]);

  test("a copied built-in fills the form, and its id becomes <id>-copy because the catalog already has it", () => {
    const parsed = parseToolJson(toolJsonText(toolJsonEntry(BUN as never)), { taken });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    expect(parsed.values).toEqual({
      ...customToolForm(null),
      ...CATALOG,
      id: "bun-copy",
      requires: "",
      estimatedMb: String(CATALOG.estimatedMb),
      stop: "",
      overrideBuiltin: false,
    });
    // The form is the one the dialog saves, so the pasted values are exactly what a save sends.
    expect(validCustomId(parsed.values.id)).toBe(true);
  });

  test("an id nobody holds is kept as it is, so a hand-written description keeps its own name", () => {
    const parsed = parseToolJson(JSON.stringify({ ...CATALOG, id: "acme" }));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    expect(parsed.values.id).toBe("acme");
  });

  test("a taken -copy moves on to -copy-2, then -copy-3, and a long id keeps the suffix within 63 characters", () => {
    expect(copyId("bun", new Set())).toBe("bun");
    expect(copyId("bun", new Set(["bun"]))).toBe("bun-copy");
    expect(copyId("bun", new Set(["bun", "bun-copy"]))).toBe("bun-copy-2");
    expect(copyId("bun", new Set(["bun", "bun-copy", "bun-copy-2"]))).toBe("bun-copy-3");

    const long = "a".repeat(CUSTOM_LIMITS.id);
    const first = copyId(long, new Set([long]));
    expect(first.length).toBeLessThanOrEqual(CUSTOM_LIMITS.id);
    expect(first.endsWith("-copy")).toBe(true);
    expect(validCustomId(first)).toBe(true);
    const second = copyId(long, new Set([long, first]));
    expect(second.length).toBeLessThanOrEqual(CUSTOM_LIMITS.id);
    expect(second).not.toBe(first);
    expect(validCustomId(second)).toBe(true);
  });

  test("an id that is not valid is kept as typed, so the dialog can name the problem instead of renaming it", () => {
    expect(copyId("Bad Id", new Set())).toBe("Bad Id");
    expect(copyId("", new Set())).toBe("");
  });

  test("a description that is not JSON is refused with the parser's own words, and nothing is thrown", () => {
    const parsed = parseToolJson("{not json");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("json");
  });

  test("a field the form does not know is named, rather than silently dropped", () => {
    const parsed = parseToolJson(JSON.stringify({ ...CATALOG, instal: "typo" }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toEqual({ code: "unknownFields", fields: ["instal"] });
  });

  test("a missing required field, a wrong type, an over-long text and a bad size are each named", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["required", { ...CATALOG, install: undefined }],
      ["required", { ...CATALOG, name: "   " }],
      ["type", { ...CATALOG, needsRoot: "yes" }],
      ["tooLong", { ...CATALOG, name: "x".repeat(CUSTOM_LIMITS.name + 1) }],
      ["tooLong", { ...CATALOG, detect: "x".repeat(CUSTOM_LIMITS.command + 1) }],
      ["category", { ...CATALOG, category: "misc" }],
      ["source", { ...CATALOG, source: "cargo" }],
      ["estimatedMb", { ...CATALOG, estimatedMb: "1.5" }],
      ["id", { ...CATALOG, id: "Bun" }],
    ];
    for (const [code, body] of cases) {
      const parsed = parseToolJson(JSON.stringify(body));
      expect([code, parsed.ok, parsed.ok ? "" : parsed.error.code]).toEqual([code, false, code]);
    }
  });

  test("the optional fields default as the form's own new entry does: npm, agents, 50 MB, no stop", () => {
    const parsed = parseToolJson(
      JSON.stringify({
        id: "acme",
        name: "Acme",
        description: "Acme CLI",
        package: "acme.dev",
        bin: "acme",
        install: "i",
        upgrade: "u",
        uninstall: "x",
        detect: "d",
      }),
    );
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    expect(parsed.values).toMatchObject({
      category: "agents",
      source: "npm",
      estimatedMb: "50",
      requires: "",
      stop: "",
      needsRoot: false,
      overrideBuiltin: false,
    });
  });

  test("the root has to be one object, since a catalog entry is one", () => {
    for (const text of ["[]", "null", "42", '"bun"']) {
      const parsed = parseToolJson(text);
      expect([text, parsed.ok, parsed.ok ? "" : parsed.error.code]).toEqual([text, false, "json"]);
    }
  });
});

describe("the custom-tool dialog's paste box", () => {
  test("the box folds, holds the JSON, and has its own error line", () => {
    expect(DIALOG).toContain("foldSectionHtml({");
    expect(DIALOG).toContain('id: "ctPaste"');
    expect(DIALOG).toContain('id="ct-paste"');
    expect(DIALOG).toContain('id="ct-paste-apply"');
    expect(DIALOG).toContain('id="ct-paste-error" role="alert"');
    expect(DIALOG).toContain("bindFoldSections(root);");
    // The paste rules come from the module, not from a copy in the component.
    expect(DIALOG).toContain('from "../lib/custom-tool-json.js"');
    expect(DIALOG).not.toContain("JSON.parse(");
  });

  test("a refused paste keeps what is typed: the form is only written once the description parses", () => {
    const apply = DIALOG.slice(DIALOG.indexOf("const applyPaste = () =>"), DIALOG.indexOf("bindFoldSections(root);"));
    expect(apply).toContain("const parsed = parseToolJson(box.value, { taken: takenIds() });");
    // The refusal comes before any write to the form, and returns.
    expect(apply.indexOf("if (!parsed.ok)")).toBeLessThan(apply.indexOf("const { values } = parsed;"));
    expect(apply).toMatch(/if \(!parsed\.ok\) \{[\s\S]*?return;\n\s*\}/);
  });

  test("every id a paste must avoid is a catalog id or a saved custom one", () => {
    expect(DIALOG).toContain("const takenIds = () => new Set([...catalogIds, ...customById.keys()]);");
    expect(isBuiltinId("bun", new Set(["bun"]), new Map())).toBe(true);
  });

  test("a paste never claims the built-in override, so it adds a tool rather than replacing one", () => {
    const apply = DIALOG.slice(DIALOG.indexOf("const applyPaste = () =>"));
    expect(apply).toContain('read("overrideBuiltin").checked = false;');
  });

  test("the strings the box shows are in the dictionary, in both languages", () => {
    for (const key of [
      "ct.pasteTitle",
      "ct.pasteHelp",
      "ct.pasteApply",
      "ct.pasteBadJson",
      "ct.pasteUnknownFields",
      "ct.pasteRequired",
      "ct.pasteType",
      "ct.pasteTooLong",
      "ct.pasteCategory",
      "ct.pasteSource",
      "ct.pasteEstimatedMb",
      "ct.pasteId",
    ]) {
      expect([key, typeof en[key], typeof zh[key]]).toEqual([key, "string", "string"]);
    }
  });
});

describe("the copy button of a tool row", () => {
  test("every row offers it, built-in and custom alike, and it names the tool it copies", () => {
    expect(TOOLS_ROW).toContain('data-action="tool-copy-json"');
    expect(TOOLS_ROW).toContain('data-tool="${esc(tool.id)}"');
    // The button is added outside the custom branch, so a built-in row has it too.
    const row = TOOLS_ROW.slice(
      TOOLS_ROW.indexOf("function toolRow("),
      TOOLS_ROW.indexOf("export function mountTools"),
    );
    expect(row).toContain("${copyJsonButton(tool)}");
    expect(row).not.toMatch(/isCustom \? `\$\{copyJsonButton/);
  });

  test("a built-in row gains no edit or delete action, only the copy button", () => {
    const row = TOOLS_ROW.slice(
      TOOLS_ROW.indexOf("function toolRow("),
      TOOLS_ROW.indexOf("export function mountTools"),
    );
    expect(row).toContain('${isCustom ? customActionCell(tool) : ""}');
    expect(row).not.toMatch(/tool-custom-edit[\s\S]*?\$\{copyJsonButton/);
  });

  test("the click copies the entry as JSON through the shared clipboard helper, which falls back off secure contexts", () => {
    expect(TOOLS_ROW).toContain("await copyText(toolJsonText(toolJsonEntry(tool, custom)));");
    expect(TOOLS_ROW).toContain('toastError(t("bd.toolCopyJsonFailed"), e);');
    const DOM = read(join("js", "lib", "dom.js"));
    expect(DOM).toContain('document.execCommand("copy")');
    expect(DOM).toContain("if (!copied) throw new Error(");
  });

  test("the strings the row shows are in the dictionary, in both languages", () => {
    for (const key of ["bd.toolCopyJson", "bd.toolCopyJsonHelp", "bd.toolCopyJsonDone", "bd.toolCopyJsonFailed"]) {
      expect([key, typeof en[key], typeof zh[key]]).toEqual([key, "string", "string"]);
    }
  });
});
