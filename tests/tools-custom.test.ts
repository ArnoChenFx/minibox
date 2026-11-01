import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findCatalogEntry, loadCatalog } from "../src/tools/catalog";
import { commandFor } from "../src/tools/commands";
import {
  type CommandTemplate,
  CUSTOM_LIMITS,
  commandTemplate,
  customToolBody,
  customToolForm,
} from "../web/js/lib/custom-tool.js";
import { silenceLogs } from "./support/app";
import { call, type Harness, mint, refused, startHarness } from "./support/tokens";

const ENTRY = {
  name: "Sample tool",
  description: "A sample entry.",
  category: "terminal",
  source: "npm",
  package: "sample-tool",
  bin: "sample-tool",
  requires: "Node ≥ 20",
  install: "npm install -g --prefix {{prefix}} {{package_spec}}",
  upgrade: "npm install -g --prefix {{prefix}} {{package_spec}}",
  uninstall: "npm uninstall -g --prefix {{prefix}} {{package}}",
  detect: "command -v sample-tool >/dev/null && sample-tool --version 2>/dev/null",
};

let h: Harness;
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  h = startHarness();
});

afterEach(() => {
  h.stop();
  restoreLogs();
});

const toolsDir = () => join(h.app.cfg.dataDir, "tools.d");
const fileOf = (id: string) => join(toolsDir(), `${id}.json`);
const filesIn = () => (existsSync(toolsDir()) ? readdirSync(toolsDir()).toSorted() : []);
const put = (id: string, body: unknown, token?: string) =>
  call(h.base, `/api/tools/custom/${id}`, { method: "PUT", body, token });
const remove = (id: string, token?: string) => call(h.base, `/api/tools/custom/${id}`, { method: "DELETE", token });
const list = (token?: string) => call(h.base, "/api/tools/custom", { token });
const stopOf = async () => (await list()).json.tools?.[0]?.stop;
const catalogName = (id: string) => findCatalogEntry(loadCatalog(h.app.cfg.dataDir), id)?.name;

describe("saving a custom entry", () => {
  test("the entry is written as tools.d/<id>.json with mode 0644, and the loader reads it back", async () => {
    const saved = await put("sample-tool", ENTRY);
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({
      tool: { id: "sample-tool", category: "terminal", requires: "Node ≥ 20", overridesBuiltin: false },
    });

    expect(statSync(fileOf("sample-tool")).mode & 0o777).toBe(0o644);
    expect(filesIn()).toEqual(["sample-tool.json"]);
    expect(JSON.parse(readFileSync(fileOf("sample-tool"), "utf8"))).toEqual({
      id: "sample-tool",
      name: "Sample tool",
      description: "A sample entry.",
      category: "terminal",
      source: "npm",
      package: "sample-tool",
      bin: "sample-tool",
      needsRoot: false,
      estimatedMb: 50,
      requires: "Node ≥ 20",
      install: "npm install -g --prefix {{prefix}} {{package_spec}}",
      upgrade: "npm install -g --prefix {{prefix}} {{package_spec}}",
      uninstall: "npm uninstall -g --prefix {{prefix}} {{package}}",
      detect: "command -v sample-tool >/dev/null && sample-tool --version 2>/dev/null",
    });
    expect(catalogName("sample-tool")).toBe("Sample tool");
    expect((await list()).json.tools).toEqual([expect.objectContaining({ id: "sample-tool", requires: "Node ≥ 20" })]);
  });

  test("a stop command is saved, read back by the loader and listed, and a save without one removes it", async () => {
    const withStop = { ...ENTRY, stop: "  {{prefix}}/bin/sample-tool stop  " };
    const saved = await put("sample-tool", withStop);
    expect(saved.status).toBe(200);
    expect(saved.json.tool?.stop).toBe("{{prefix}}/bin/sample-tool stop");
    const stored = JSON.parse(readFileSync(fileOf("sample-tool"), "utf8"));
    expect(Object.keys(stored).slice(-3)).toEqual(["uninstall", "stop", "detect"]);
    expect(stored.stop).toBe("{{prefix}}/bin/sample-tool stop");
    expect(findCatalogEntry(loadCatalog(h.app.cfg.dataDir), "sample-tool")?.stop).toBe(
      "{{prefix}}/bin/sample-tool stop",
    );
    expect(await stopOf()).toBe("{{prefix}}/bin/sample-tool stop");

    expect((await put("sample-tool", { ...ENTRY, stop: "   " })).status).toBe(200);
    expect(JSON.parse(readFileSync(fileOf("sample-tool"), "utf8"))).not.toHaveProperty("stop");
    expect(await stopOf()).toBeNull();
  });

  test("overriding a built-in with a stop command keeps it, so the override still stops the daemon", async () => {
    const tailscale = findCatalogEntry(loadCatalog(h.app.cfg.dataDir), "tailscale");
    expect(tailscale?.stop).toBeTruthy();
    const { id: _id, ...body } = tailscale as NonNullable<typeof tailscale>;
    const saved = await put("tailscale", { ...body, name: "Tailscale (mine)", overrideBuiltin: true });
    expect(saved.status).toBe(200);
    const merged = findCatalogEntry(loadCatalog(h.app.cfg.dataDir), "tailscale");
    expect(merged).toMatchObject({ name: "Tailscale (mine)", stop: tailscale?.stop, install: tailscale?.install });
  });

  test("a save replaces the entry, a multi-line command is kept as written, and omitted optional fields are defaulted", async () => {
    await put("sample-tool", ENTRY);
    const multiline = {
      ...ENTRY,
      name: "Sample tool 2",
      requires: undefined,
      install: "set -e\nnpm install -g --prefix {{prefix}} {{package_spec}}",
      category: undefined,
    };
    expect((await put("sample-tool", multiline)).status).toBe(200);
    const stored = JSON.parse(readFileSync(fileOf("sample-tool"), "utf8"));
    expect(stored).toMatchObject({ name: "Sample tool 2", category: "agents", install: multiline.install });
    expect(stored).not.toHaveProperty("requires");
    expect(filesIn()).toEqual(["sample-tool.json"]);
  });

  test("an entry the loader would reject is refused with the field at fault, and no file is written", async () => {
    const cases: [string, unknown, string][] = [
      ["Bad_ID", ENTRY, "id"],
      ["sample-tool", { ...ENTRY, name: "x".repeat(81) }, "name"],
      ["sample-tool", { ...ENTRY, description: "two\nlines" }, "description"],
      ["sample-tool", { ...ENTRY, category: "misc" }, "category"],
      ["sample-tool", { ...ENTRY, source: "docker" }, "source"],
      ["sample-tool", { ...ENTRY, package: "sample; rm -rf /" }, "package"],
      ["sample-tool", { ...ENTRY, bin: "../escape" }, "bin"],
      ["sample-tool", { ...ENTRY, estimatedMb: 0 }, "estimatedMb"],
      ["sample-tool", { ...ENTRY, needsRoot: "yes" }, "needsRoot"],
      ["sample-tool", { ...ENTRY, requires: "x".repeat(CUSTOM_LIMITS.requires + 1) }, "requires"],
      ["sample-tool", { ...ENTRY, install: "npm install {{home}}" }, "install"],
      ["sample-tool", { ...ENTRY, upgrade: "x".repeat(CUSTOM_LIMITS.command + 1) }, "upgrade"],
      ["sample-tool", { ...ENTRY, stop: "kill {{pid}}" }, "stop"],
      ["sample-tool", { ...ENTRY, stop: "stop\u0000" }, "stop"],
      ["sample-tool", { ...ENTRY, stop: 42 }, "stop"],
      ["sample-tool", { ...ENTRY, detect: "echo\u0007" }, "detect"],
      ["sample-tool", { ...ENTRY, overrideBuiltin: "yes" }, "overrideBuiltin"],
    ];
    for (const [id, body, field] of cases) {
      const reply = await put(id, body);
      expect({
        field,
        status: reply.status,
        code: reply.json.error?.code,
        at: reply.json.error?.details?.field,
      }).toEqual({ field, status: 400, code: "validation_failed", at: field });
    }
    expect(filesIn()).toEqual([]);
    expect((await list()).json.tools).toEqual([]);
  });

  test("a built-in id needs overrideBuiltin, and with it the entry replaces the built-in until it is deleted", async () => {
    expect(refused(await put("uv", ENTRY))).toEqual({ status: 409, key: "tool_custom_builtin" });
    expect(filesIn()).toEqual([]);

    const replaced = await put("uv", { ...ENTRY, name: "uv (mine)", overrideBuiltin: true });
    expect(replaced.status).toBe(200);
    expect(replaced.json.tool).toMatchObject({ id: "uv", name: "uv (mine)", overridesBuiltin: true });
    expect(catalogName("uv")).toBe("uv (mine)");
    expect((await list()).json.tools).toEqual([expect.objectContaining({ id: "uv", overridesBuiltin: true })]);

    expect((await remove("uv")).json).toEqual({ id: "uv", restoredBuiltin: true });
    expect(catalogName("uv")).toBe("uv");
    expect(filesIn()).toEqual([]);
  });

  test("another file that defines the id, or a file named for the id that defines another, is a conflict and neither changes", async () => {
    mkdirSync(toolsDir(), { recursive: true });
    writeFileSync(join(toolsDir(), "hand-written.json"), JSON.stringify({ ...ENTRY, id: "clash" }));
    const handWritten = readFileSync(join(toolsDir(), "hand-written.json"), "utf8");
    expect(refused(await put("clash", ENTRY))).toEqual({ status: 409, key: "tool_custom_file_conflict" });
    expect(readFileSync(join(toolsDir(), "hand-written.json"), "utf8")).toBe(handWritten);
    expect(filesIn()).toEqual(["hand-written.json"]);

    writeFileSync(fileOf("mismatch"), JSON.stringify({ ...ENTRY, id: "other-id" }));
    expect(refused(await put("mismatch", ENTRY))).toEqual({ status: 409, key: "tool_custom_file_other" });
    expect(JSON.parse(readFileSync(fileOf("mismatch"), "utf8")).id).toBe("other-id");
  });

  test("the body the form sends is accepted as sent, and the npm and pip templates render the install the helper runs", async () => {
    for (const source of ["npm", "pip"] as const) {
      const id = `form-${source}`;
      const commands = commandTemplate(source) as CommandTemplate;
      const values = {
        ...customToolForm(null),
        ...commands,
        id,
        name: "Form tool",
        description: "Installed from the form.",
        source,
        package: `${id}-pkg`,
        bin: id,
        requires: "Runtime note",
      };
      const reply = await put(id, customToolBody(values));
      expect(reply.status).toBe(200);

      const entry = findCatalogEntry(loadCatalog(h.app.cfg.dataDir), id);
      expect(entry).toMatchObject({ source, package: `${id}-pkg`, requires: "Runtime note", needsRoot: false });
      expect(entry).toMatchObject({
        install: commands.install,
        uninstall: commands.uninstall,
        detect: commands.detect,
      });
      if (!entry) throw new Error(`${id} is missing from the catalog`);
      expect(commandFor(entry, "install", "1.2.3")).toContain(
        source === "pip"
          ? `pip install --upgrade ${id}-pkg==1.2.3`
          : `npm install -g --prefix /opt/minibox/tools ${id}-pkg@1.2.3`,
      );
    }
  });

  test("the form's length limits are the server's: the limit is accepted, and one character more is refused", async () => {
    const cases: [string, number, (text: string) => unknown][] = [
      ["name", CUSTOM_LIMITS.name, (text) => ({ ...ENTRY, name: text })],
      ["description", CUSTOM_LIMITS.description, (text) => ({ ...ENTRY, description: text })],
      ["package", CUSTOM_LIMITS.package, (text) => ({ ...ENTRY, package: text })],
      ["bin", CUSTOM_LIMITS.bin, (text) => ({ ...ENTRY, bin: text })],
      ["requires", CUSTOM_LIMITS.requires, (text) => ({ ...ENTRY, requires: text })],
      ["install", CUSTOM_LIMITS.command, (text) => ({ ...ENTRY, install: text })],
    ];
    for (const [field, limit, body] of cases) {
      const text = field === "install" ? "i" : field === "package" ? "p" : "x";
      const fits = await put("limits-probe", body(text.repeat(limit)));
      expect({ field, status: fits.status }).toEqual({ field, status: 200 });
      const over = await put("limits-probe", body(text.repeat(limit + 1)));
      expect({ field, status: over.status, at: over.json.error?.details?.field }).toEqual({
        field,
        status: 400,
        at: field,
      });
    }
    const idAtLimit = "a".repeat(CUSTOM_LIMITS.id);
    expect((await put(idAtLimit, ENTRY)).status).toBe(200);
    expect(refused(await put(`${idAtLimit}a`, ENTRY)).status).toBe(400);
  });
});

describe("deleting a custom entry", () => {
  test("delete removes only the tools.d file and runs no helper, so a tool on the shared volume stays installed", async () => {
    await put("sample-tool", ENTRY);
    await put("other-tool", { ...ENTRY, name: "Other", package: "other-tool", bin: "other-tool" });
    const helpersBefore = h.runtime.callsTo("runHelper").length;

    expect((await remove("sample-tool")).json).toEqual({ id: "sample-tool", restoredBuiltin: false });
    expect(filesIn()).toEqual(["other-tool.json"]);
    expect(h.runtime.callsTo("runHelper")).toHaveLength(helpersBefore);
  });

  test("a built-in id with no override cannot be deleted, and an unknown id is not found", async () => {
    expect(refused(await remove("uv"))).toEqual({ status: 409, key: "tool_custom_builtin_delete" });
    expect(refused(await remove("nothing-here"))).toEqual({ status: 404, key: "tool_custom_not_found" });
  });

  test("a broken file named for an id can be deleted or replaced by that name", async () => {
    mkdirSync(toolsDir(), { recursive: true });
    writeFileSync(fileOf("broken"), "{ not json");
    expect((await remove("broken")).json).toEqual({ id: "broken", restoredBuiltin: false });
    expect(filesIn()).toEqual([]);

    writeFileSync(fileOf("broken"), "{ not json");
    expect((await put("broken", ENTRY)).status).toBe(200);
    expect(JSON.parse(readFileSync(fileOf("broken"), "utf8")).id).toBe("broken");
  });

  test("the list reports a broken file in tools.d the way the loader does, rather than hiding it", async () => {
    mkdirSync(toolsDir(), { recursive: true });
    writeFileSync(join(toolsDir(), "bad.json"), "{ not json");
    const reply = await list();
    expect(reply.status).toBe(400);
    expect(reply.json.error?.code).toBe("validation_failed");
  });
});

describe("who may change the custom catalog", () => {
  test("only the owner may list, save or delete: every other token is refused and the catalog is unchanged", async () => {
    await put("sample-tool", ENTRY);
    const tokens = [
      mint(h.app, { name: "admin", preset: "admin" }),
      mint(h.app, { name: "operator", preset: "operator" }),
      mint(h.app, { name: "readonly", preset: "readonly" }),
      mint(h.app, { name: "sandboxed", preset: "sandboxed-agent" }),
      mint(h.app, { name: "installer", scopes: ["tool:install"] }),
      mint(h.app, { name: "box-scoped", preset: "operator", boxes: { type: "created-by-me" } }),
    ];
    for (const token of tokens) {
      expect({ who: token.id, list: refused(await list(token.secret)) }).toEqual({
        who: token.id,
        list: { status: 403, key: "operation_forbidden" },
      });
      expect({ who: token.id, put: refused(await put("other-tool", ENTRY, token.secret)) }).toEqual({
        who: token.id,
        put: { status: 403, key: "operation_forbidden" },
      });
      expect({ who: token.id, remove: refused(await remove("sample-tool", token.secret)) }).toEqual({
        who: token.id,
        remove: { status: 403, key: "operation_forbidden" },
      });
    }
    expect(filesIn()).toEqual(["sample-tool.json"]);
    expect((await list()).json.tools).toEqual([expect.objectContaining({ id: "sample-tool" })]);
  });
});
