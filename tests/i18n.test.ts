import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { ROOT } from "../src/config";
import { AppError } from "../src/lib/errors";
import { errorResponse } from "../src/lib/http";
import { FEATURES, MESSAGES, msg } from "../src/lib/messages";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).toSorted();

const WEB = join(ROOT, "web");
/** Vendored libraries are not ours, and i18n.js documents the markup syntax in its comments. */
const NOT_CONSOLE = [join(WEB, "vendor"), join(WEB, "js", "lib", "i18n.js")];

function consoleFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (NOT_CONSOLE.includes(path)) return [];
    if (entry.isDirectory()) return consoleFiles(path);
    return /\.(js|html)$/.test(entry.name) ? [path] : [];
  });
}

/** Keys named by a literal: t("…"), data-i18n, data-i18n-html, data-i18n-attr, and a route's crumbs. */
function literalKeys(source: string): string[] {
  const attrKeys = [...source.matchAll(/data-i18n-attr="([^"]*)"/g)].flatMap((m) =>
    (m[1] ?? "").split(";").map((pair) => pair.split(":")[1]?.trim() ?? ""),
  );
  return [
    ...[...source.matchAll(/\bt\("([\w.-]+)"/g)].map((m) => m[1] ?? ""),
    ...[...source.matchAll(/data-i18n(?:-html)?="([\w.-]+)"/g)].map((m) => m[1] ?? ""),
    ...[...source.matchAll(/crumbs: \["([\w.-]+)"\]/g)].map((m) => m[1] ?? ""),
    ...attrKeys,
  ].filter(Boolean);
}

describe("i18n dictionaries", () => {
  test("en and zh-CN have the same keys", () => {
    expect(Object.keys(zh).toSorted()).toEqual(Object.keys(en).toSorted());
  });
  test("translations keep the same placeholders", () => {
    for (const [k, v] of Object.entries(en)) expect([k, placeholders(zh[k] ?? "")]).toEqual([k, placeholders(v)]);
  });
  test("every server message key has a UI translation", () => {
    for (const k of Object.keys(MESSAGES)) expect([k, `err.${k}` in en]).toEqual([k, true]);
  });
});

describe("save as template strings", () => {
  const added = [
    "tp.saveAction",
    "tp.saveTitle",
    "tp.saveDesc",
    "tp.saveScope",
    "tp.saved",
    "tp.openTemplate",
    "tp.saveFailed",
    "task.op.template.save",
    "err.template_name_taken",
    "sn.legacyTitle",
    "sn.legacyText",
  ];

  test("each one has its own Chinese text, not the English copied across", () => {
    for (const key of added) expect([key, zh[key] !== en[key]]).toEqual([key, true]);
  });

  test("the scope line names checkpoints for data in both languages", () => {
    expect(en["tp.saveScope"]).toContain("checkpoint");
    expect(zh["tp.saveScope"]).toContain("检查点");
  });

  test("login.feat2 names checkpoints for data and templates for the environment in both languages", () => {
    expect(en["login.feat2"]).toMatch(/checkpoints/i);
    expect(en["login.feat2"]).toMatch(/templates/i);
    expect(zh["login.feat2"]).toContain("检查点");
    expect(zh["login.feat2"]).toContain("模板");
  });
});

describe("list, settings navigation and secret strings", () => {
  const added = [
    "list.showAll",
    "list.collapse",
    "st.navLabel",
    "st.secretGenerate",
    "st.secretGenerateHelp",
    "st.secretShow",
    "st.secretHide",
    "st.secretCopy",
    "st.secretCopied",
    "st.secretCopyFailed",
  ];

  test("each one has its own Chinese text, not the English copied across", () => {
    for (const key of added) expect([key, zh[key] !== en[key]]).toEqual([key, true]);
  });

  test("the show-all toggle names the count in both languages", () => {
    expect(en["list.showAll"]).toContain("{n}");
    expect(zh["list.showAll"]).toContain("{n}");
    expect(zh["list.collapse"]).toBe("收起");
  });
});

describe("console translations", () => {
  const used = consoleFiles(WEB).flatMap((path) =>
    literalKeys(readFileSync(path, "utf8")).map((key) => ({ key, file: relative(WEB, path) })),
  );

  test("the scan sees the keys the pages name, so the check below cannot pass vacuously", () => {
    expect(used.map((u) => u.key)).toEqual(expect.arrayContaining(["nav.settings", "nav.about", "about.links"]));
  });

  test("every literal key the console names exists in both dictionaries", () => {
    const missing = used.filter(({ key }) => !(key in en) || !(key in zh));
    expect(missing).toEqual([]);
  });
});

describe("server messages", () => {
  test("msg interpolates params and label names", () => {
    expect(msg("field_required", { label: "boxName" }).text).toBe("Box name is required.");
    expect(msg("box_exists", { name: "dev" }).text).toBe("A box named “dev” already exists.");
  });
  test("every feature name a message can carry has a UI translation", () => {
    for (const k of Object.keys(FEATURES)) {
      expect([k, `feature.${k}` in en && `feature.${k}` in zh]).toEqual([k, true]);
    }
  });
  test("an agent-host refusal names its feature by key, and the Chinese text takes the translated name", () => {
    const refusal = msg("agent_host_unsupported", { feature: "snapshots" });
    expect(refusal.text).toBe("Snapshots is not supported on agent hosts yet.");
    expect(refusal.params).toEqual({ feature: "snapshots" });
    const template = zh["err.agent_host_unsupported"] ?? "";
    expect(template.replace("{feature}", zh["feature.snapshots"] ?? "")).toBe("Agent 宿主机暂不支持快照。");
  });
  test("error responses carry key and params", async () => {
    const res = errorResponse(new AppError(409, "conflict", msg("box_exists", { name: "dev" })));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({ code: "conflict", key: "box_exists", params: { name: "dev" } });
  });
});
