import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";
import { validMountPath as serverValidMountPath } from "../src/volumes/mounts";
import { ROLE_MOUNT, VOLUME_ROLES } from "../src/volumes/types";
import {
  type CommandTemplate,
  commandsForSource,
  commandTemplate,
  customToolBody,
  customToolForm,
  isBuiltinId,
  validCustomId,
} from "../web/js/lib/custom-tool.js";
import {
  canonicalMounts,
  checkMountRows,
  createMountChoices,
  DEFAULT_MOUNTS,
  isVolumeErrorKey,
  roleMount,
  roleOfValue,
  rolePoolPicks,
  roleValue,
  rulePoolOf,
  namesOnHost,
  previewNoteLines,
  previewRoleNames,
  roleVolumeNames,
  sharedToolsOnHost,
  sharedToolsChoice,
  validMountPath,
  volumeChoices,
} from "../web/js/lib/mounts.js";
import { ownerKeyNotice } from "../web/js/lib/owner-key.js";
import { daysLeft } from "../web/js/lib/trash.js";

const LIB = join(ROOT, "web", "js", "lib");
const I18N = join(ROOT, "web", "js", "i18n");

interface Browser {
  /** The value saved under `minibox.lang` in localStorage. */
  saved?: string;
  languages?: string[];
  language?: string;
}

/**
 * Evaluates `expression` in a fresh process whose globals stand in for the browser. The i18n module reads the
 * language once, when it loads, so every scenario needs its own process. `i18n` and `format` are the loaded modules.
 */
function inBrowser<T>(browser: Browser, expression: string, prelude: string[] = []): T {
  const store = browser.saved === undefined ? [] : [["minibox.lang", browser.saved]];
  const script = [
    `const store = new Map(${JSON.stringify(store)});`,
    `Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {`,
    `  getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) } });`,
    `Object.defineProperty(globalThis, "navigator", { configurable: true, value: ${JSON.stringify({
      languages: browser.languages,
      language: browser.language,
    })} });`,
    `Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: {} } });`,
    `const i18n = await import(${JSON.stringify(join(LIB, "i18n.js"))});`,
    `const format = await import(${JSON.stringify(join(LIB, "format.js"))});`,
    `const search = await import(${JSON.stringify(join(LIB, "search.js"))});`,
    `const volumeList = await import(${JSON.stringify(join(LIB, "volume-list.js"))});`,
    `const toolList = await import(${JSON.stringify(join(LIB, "tool-list.js"))});`,
    `const templateList = await import(${JSON.stringify(join(LIB, "template-list.js"))});`,
    `const en = (await import(${JSON.stringify(join(I18N, "en.js"))})).default;`,
    `const zh = (await import(${JSON.stringify(join(I18N, "zh-CN.js"))})).default;`,
    ...prelude,
    `console.log(JSON.stringify(${expression}));`,
  ].join("\n");
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as T;
}

describe("language detection", () => {
  test("an English browser gets English, and the document language follows", () => {
    expect(inBrowser({ languages: ["en-US"] }, `({ lang: i18n.lang, html: document.documentElement.lang })`)).toEqual({
      lang: "en",
      html: "en",
    });
  });

  test("a Chinese browser gets zh-CN, whatever the region", () => {
    expect(inBrowser({ languages: ["zh-TW", "en"] }, `i18n.lang`)).toBe("zh-CN");
  });

  test("a browser that reports only navigator.language is detected too", () => {
    expect(inBrowser({ language: "zh-HK" }, `i18n.lang`)).toBe("zh-CN");
  });

  test("other languages fall back to English", () => {
    expect(inBrowser({ languages: ["fr-FR", "zh-CN"] }, `i18n.lang`)).toBe("en");
  });

  test("a saved preference beats the browser's language", () => {
    expect(inBrowser({ saved: "en", languages: ["zh-CN"] }, `i18n.lang`)).toBe("en");
  });

  test("an unknown saved preference is ignored", () => {
    expect(inBrowser({ saved: "fr", languages: ["zh-CN"] }, `i18n.lang`)).toBe("zh-CN");
  });
});

describe("t", () => {
  test("replaces {param} placeholders and leaves the ones without a value", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `({
          filled: i18n.t("ba.deletedVolumeFailed", { name: "alpha" }),
          unfilled: i18n.t("ba.deletedVolumeFailed"),
          otherParam: i18n.t("ba.deletedVolumeFailed", { title: "x" }),
        })`,
      ),
    ).toEqual({
      filled: "alpha was deleted, but some of its volumes were not removed",
      unfilled: "{name} was deleted, but some of its volumes were not removed",
      otherParam: "{name} was deleted, but some of its volumes were not removed",
    });
  });

  test("uses the Chinese dictionary for zh-CN", () => {
    expect(inBrowser({ saved: "zh-CN" }, `i18n.t("ba.deletedVolumeFailed", { name: "alpha" })`)).toBe(
      "alpha 已删除，但部分数据卷未能删除",
    );
  });

  test("returns the key itself for a key that no dictionary has", () => {
    expect(inBrowser({ languages: ["en-US"] }, `i18n.t("no.such.key")`)).toBe("no.such.key");
  });

  test("has() reports whether a key exists", () => {
    expect(
      inBrowser({ languages: ["en-US"] }, `({ yes: i18n.has("disk.container"), no: i18n.has("no.such") })`),
    ).toEqual({ yes: true, no: false });
  });
});

describe("format helpers", () => {
  test("sizes, percentages and limits in English", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `({
          bytesNull: format.bytes(null),
          bytes512: format.bytes(512),
          bytes1536: format.bytes(1536),
          bytes200g: format.bytes(200 * 1024 ** 3),
          pct: format.pct(12.345),
          pctRounded: format.pct(12.345, 0),
          pctNaN: format.pct(NaN),
          cpusNull: format.cpus(null),
          cpus1: format.cpus(1),
          cpus2: format.cpus(2),
          cpusHalf: format.cpus(0.5),
          memNull: format.mem(null),
          mem512: format.mem(512 * 1024 * 1024),
          mem2g: format.mem(2 * 1024 ** 3),
          gbOrMb: format.gbOrMb(1.5 * 1024 ** 3),
        })`,
      ),
    ).toEqual({
      bytesNull: "—",
      bytes512: "512 B",
      bytes1536: "1.5 KB",
      bytes200g: "200 GB",
      pct: "12.3%",
      pctRounded: "12%",
      pctNaN: "—",
      cpusNull: "Unlimited",
      cpus1: "1 core",
      cpus2: "2 cores",
      cpusHalf: "0.5 cores",
      memNull: "Unlimited",
      mem512: "512 MB",
      mem2g: "2 GB",
      gbOrMb: "1.5 GB",
    });
  });

  test("durations and relative times in English", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `({
          none: format.duration(null),
          minutes: format.duration(125),
          hours: format.duration(3700),
          days: format.duration(90000),
          noTime: format.relTime(null),
          justNow: format.relTime(new Date(Date.now() - 5000).toISOString()),
          seconds: format.relTime(new Date(Date.now() - 30000).toISOString()),
        })`,
      ),
    ).toEqual({
      none: "—",
      minutes: "2 min",
      hours: "1h 1m",
      days: "1d 1h",
      noTime: "—",
      justNow: "just now",
      seconds: "30 seconds ago",
    });
  });

  test("an elapsed span is read to the second, and from an hour on it reads like a duration", () => {
    const from = JSON.stringify(new Date(Date.UTC(2026, 9, 22, 0, 0, 0)).toISOString());
    const at = (ms: number) => `Date.parse(${from}) + ${ms}`;
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `({
          seconds: format.elapsed(${from}, ${at(42_000)}),
          minutes: format.elapsed(${from}, ${at(185_000)}),
          hours: format.elapsed(${from}, ${at(3_700_000)}),
          future: format.elapsed(${from}, ${at(-5_000)}),
          missing: format.elapsed(null),
        })`,
      ),
    ).toEqual({ seconds: "42s", minutes: "3m 05s", hours: "1h 1m", future: "0s", missing: "—" });
    expect(inBrowser({ saved: "zh-CN" }, `format.elapsed(${from}, ${at(185_000)})`)).toBe("3 分 05 秒");
  });

  test("ids, levels and translated units in Chinese", () => {
    expect(
      inBrowser(
        { saved: "zh-CN" },
        `({
          mem: format.mem(null),
          cpus: format.cpus(2),
          cpus1: format.cpus(1),
          hours: format.duration(3700),
          justNow: format.relTime(new Date(Date.now() - 5000).toISOString()),
        })`,
      ),
    ).toEqual({ mem: "不限", cpus: "2 核", cpus1: "1 核", hours: "1 小时 1 分钟", justNow: "刚刚" });
  });

  test("shortId strips the sha256 prefix and keeps twelve characters", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `({
          prefixed: format.shortId("sha256:0123456789abcdef0123"),
          short: format.shortId("abc"),
          none: format.shortId(null),
        })`,
      ),
    ).toEqual({ prefixed: "0123456789ab", short: "abc", none: "—" });
  });
});

describe("search matching", () => {
  /** Whether one item with these fields survives the query: the same question `filterBySearch` answers for a list. */
  const HIT = `const hit = (query, fields) => search.filterBySearch([fields], query, (f) => f).length === 1;`;

  test("a blank query matches every item, and a term matches any field whatever its case", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `(() => {
          ${HIT}
          return {
            blank: hit("   ", ["alpha"]),
            noFields: hit("", []),
            caseless: hit("VOL_AB", ["vol_abc"]),
            anyField: hit("pool", ["alpha", "local pool"]),
            miss: hit("zzz", ["alpha"]),
          };
        })()`,
      ),
    ).toEqual({ blank: true, noFields: true, caseless: true, anyField: true, miss: false });
  });

  test("every term must match, each in some field, and extra spaces are ignored", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `(() => {
          ${HIT}
          return {
            both: hit("dev workspace", ["dev", "/workspace"]),
            spaced: hit("  Dev   WORK ", ["dev", "/workspace"]),
            oneMissing: hit("dev missing", ["dev", "/workspace"]),
          };
        })()`,
      ),
    ).toEqual({ both: true, spaced: true, oneMissing: false });
  });

  test("null, undefined and empty fields are skipped rather than matched", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `(() => {
          ${HIT}
          return {
            nothing: hit("x", [null, undefined, ""]),
            something: hit("abc", [null, "abc"]),
          };
        })()`,
      ),
    ).toEqual({ nothing: false, something: true });
  });

  test("non-Latin text matches as it is written", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `(() => {
          ${HIT}
          return { hit: hit("内置", ["内置模板"]), miss: hit("自定义", ["内置模板"]) };
        })()`,
      ),
    ).toEqual({ hit: true, miss: false });
  });

  test("filterBySearch keeps the matching items in order, and a blank query returns the list itself", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `(() => {
          const items = [
            { name: "alpha", tags: ["x"] },
            { name: "beta", tags: ["Node"] },
            { name: "gamma", tags: ["node"] },
          ];
          const fieldsOf = (item) => [item.name, ...item.tags];
          return {
            hits: search.filterBySearch(items, "NODE", fieldsOf).map((item) => item.name),
            none: search.filterBySearch(items, "nope", fieldsOf),
            same: search.filterBySearch(items, "  ", fieldsOf) === items,
          };
        })()`,
      ),
    ).toEqual({ hits: ["beta", "gamma"], none: [], same: true });
  });
});

/**
 * Volumes as the console receives them, with three boxes. `web` owns one volume and mounts a second one, `api` mounts
 * that second one too, and `idle` owns a volume that nothing mounts. `scratch` has no owner and no mount.
 */
const VOLUMES = `
  const boxNames = new Map([["bx_web", "web"], ["bx_api", "api"], ["bx_idle", "idle"]]);
  const roleLabel = (role) => ({ workspace: "Workspace", home: "Home", tools: "Tools", cache: "Cache" })[role];
  const view = (fields) => ({ id: "vol_x", name: "x", engineName: "mb-x", pool: "local", backend: "local", role: null, ownership: "independent", ownerBoxId: null, mounts: [], ...fields });
  const vWorkspace = view({ id: "vol_ws", name: "web-workspace", engineName: "mb-ws-web", role: "workspace", ownership: "owned", ownerBoxId: "bx_web", mounts: [{ boxId: "bx_web", boxName: "web", path: "/workspace", mode: "rw" }] });
  const vCache = view({ id: "vol_cache", name: "shared-cache", engineName: "mb-cache", role: "cache", pool: "nas", backend: "nfs", mounts: [{ boxId: "bx_web", boxName: "web", path: "/cache", mode: "ro" }, { boxId: "bx_api", boxName: "api", path: "/home/dev/.cache", mode: "rw" }] });
  const vScratch = view({ id: "vol_scratch", name: "scratch" });
  const vHome = view({ id: "vol_home", name: "dev-home", role: "home", ownership: "owned", ownerBoxId: "bx_idle" });
  const volumes = [vWorkspace, vCache, vScratch, vHome];
  const ctx = { boxNames, roleLabel };
`;

describe("volume search and groups", () => {
  test("a query finds a volume by its name, id, engine name, role, pool, owner box or mount path", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `(() => {
          ${VOLUMES}
          const find = (query) =>
            search.filterBySearch(volumes, query, (volume) => volumeList.volumeSearchFields(volume, ctx)).map((volume) => volume.id);
          return {
            name: find("web-work"),
            id: find("VOL_CACHE"),
            engine: find("mb-cache"),
            role: find("cache"),
            roleLabel: find("workspace"),
            pool: find("nas"),
            backend: find("nfs"),
            owner: find("idle"),
            mountPath: find("api:/home"),
            mountOfOtherBox: find("web:/cache"),
            mountPathWord: find("home"),
            allTermsMustMatch: find("workspace home"),
            nothing: find("missing"),
          };
        })()`,
      ),
    ).toEqual({
      name: ["vol_ws"],
      id: ["vol_cache"],
      engine: ["vol_cache"],
      role: ["vol_cache"],
      roleLabel: ["vol_ws"],
      pool: ["vol_cache"],
      backend: ["vol_cache"],
      owner: ["vol_home"],
      mountPath: ["vol_cache"],
      mountOfOtherBox: ["vol_cache"],
      mountPathWord: ["vol_cache", "vol_home"],
      allTermsMustMatch: [],
      nothing: [],
    });
  });

  test("the owner box's name comes from the box list, or from a mount of that box when the list lacks it", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `(() => {
          ${VOLUMES}
          return {
            listed: volumeList.ownerBoxName(vHome, boxNames),
            unlisted: volumeList.ownerBoxName(vHome, new Map()),
            fromMount: volumeList.ownerBoxName(vWorkspace, new Map()),
            ownerless: volumeList.ownerBoxName(vScratch, boxNames),
          };
        })()`,
      ),
    ).toEqual({ listed: "idle", unlisted: null, fromMount: "web", ownerless: null });
  });

  test("box groups hold owned volumes under their owner and others under the first box that mounts them, unattached last", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `(() => {
          ${VOLUMES}
          return volumeList.groupVolumes(volumes, "box", { boxNames }).map((g) => [g.kind, g.name, g.rows.map((v) => v.id)]);
        })()`,
      ),
    ).toEqual([
      ["box", "api", ["vol_cache"]],
      ["box", "idle", ["vol_home"]],
      ["box", "web", ["vol_ws"]],
      ["unattached", null, ["vol_scratch"]],
    ]);
  });

  test("role groups keep the role order, and volumes without a role form the last group", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `(() => {
          ${VOLUMES}
          return volumeList.groupVolumes(volumes, "role", { boxNames }).map((g) => [g.kind, g.name, g.rows.map((v) => v.id)]);
        })()`,
      ),
    ).toEqual([
      ["role", "workspace", ["vol_ws"]],
      ["role", "home", ["vol_home"]],
      ["role", "cache", ["vol_cache"]],
      ["other", null, ["vol_scratch"]],
    ]);
  });

  test("pool groups sort by pool name, and ownership groups list owned volumes first", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `(() => {
          ${VOLUMES}
          const shape = (groups) => groups.map((g) => [g.kind, g.name, g.rows.map((v) => v.id)]);
          return {
            pool: shape(volumeList.groupVolumes(volumes, "pool", { boxNames })),
            ownership: shape(volumeList.groupVolumes(volumes, "ownership", { boxNames })),
          };
        })()`,
      ),
    ).toEqual({
      pool: [
        ["pool", "local", ["vol_home", "vol_scratch", "vol_ws"]],
        ["pool", "nas", ["vol_cache"]],
      ],
      ownership: [
        ["owned", null, ["vol_home", "vol_ws"]],
        ["independent", null, ["vol_scratch", "vol_cache"]],
      ],
    });
  });

  test("without grouping, every volume is one group sorted by name, and no volumes make no groups", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `(() => {
          ${VOLUMES}
          return {
            none: volumeList.groupVolumes(volumes, "none", { boxNames }).map((g) => g.rows.map((v) => v.id)),
            empty: volumeList.groupVolumes([], "box", { boxNames }),
          };
        })()`,
      ),
    ).toEqual({ none: [["vol_home", "vol_scratch", "vol_cache", "vol_ws"]], empty: [] });
  });

  test("the group-by choice is saved and read back, and an unknown or unreadable value falls back to none", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `(() => {
          const before = volumeList.loadGroupBy();
          volumeList.saveGroupBy("box");
          const after = volumeList.loadGroupBy();
          localStorage.setItem("minibox.volumeGroupBy", "bogus");
          const unknown = volumeList.loadGroupBy();
          Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
            getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } } });
          const denied = volumeList.loadGroupBy();
          volumeList.saveGroupBy("role");
          return { before, after, unknown, denied };
        })()`,
      ),
    ).toEqual({ before: "none", after: "box", unknown: "none", denied: "none" });
  });

  test("every group-by choice has a label in both dictionaries", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `({
          choices: volumeList.GROUP_BY.filter((key) => !(key in volumeList.GROUP_LABELS)),
          missing: Object.values(volumeList.GROUP_LABELS).filter((key) => !(key in en) || !(key in zh)),
        })`,
      ),
    ).toEqual({ choices: [], missing: [] });
  });
});

describe("template search", () => {
  test("a query finds a template by its name, tags, reference, description, image id or badge", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `(() => {
          const templates = [
            { id: "sha256:aaa111", ref: "minibox-template:base", tags: ["minibox-template:base"], name: "base", description: "Debian 12 · Node.js 26" },
            { id: "sha256:bbb222", ref: "minibox-template:snap-dev", tags: ["minibox-template:snap-dev", "minibox-template:nightly"], name: "snap-dev", description: null },
          ];
          const badge = (tp) => (tp.ref === "minibox-template:base" ? "Built-in" : "Custom");
          const find = (query) =>
            search.filterBySearch(templates, query, (tp) => templateList.templateSearchFields(tp, badge(tp))).map((tp) => tp.id);
          return {
            name: find("SNAP"),
            tag: find("nightly"),
            ref: find("minibox-template:base"),
            description: find("node.js"),
            digest: find("bbb222"),
            badge: find("custom"),
            builtIn: find("built-in"),
            allTermsMustMatch: find("custom base"),
            nothing: find("missing"),
            blank: find("  ").length,
          };
        })()`,
      ),
    ).toEqual({
      name: ["sha256:bbb222"],
      tag: ["sha256:bbb222"],
      ref: ["sha256:aaa111"],
      description: ["sha256:aaa111"],
      digest: ["sha256:bbb222"],
      badge: ["sha256:bbb222"],
      builtIn: ["sha256:aaa111"],
      allTermsMustMatch: [],
      nothing: [],
      blank: 2,
    });
  });
});

describe("api errors", () => {
  test("a failed request keeps the server's translated message and the hint that says what to do", () => {
    const failure = {
      error: {
        code: "conflict",
        message: "The server's English text.",
        key: "session_image_unsupported",
        hintKey: "session_image_unsupported_hint",
      },
    };
    const error = inBrowser<{ message: string; hint: string; code: string; status: number }>(
      { languages: ["en-US"] },
      `await api.api("/api/boxes/alpha/sessions").then(() => null, (e) => ({ message: e.message, hint: e.hint, code: e.code, status: e.status }))`,
      [
        `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(failure))}, { status: 409, headers: { "content-type": "application/json" } });`,
        `const api = await import(${JSON.stringify(join(LIB, "api.js"))});`,
      ],
    );
    expect(error).toEqual({
      message: "This box's image is too old to run sessions: it lacks tmux or the dev user from the base template.",
      hint: "Build the base template again, then rebuild this box onto the current base template.",
      code: "conflict",
      status: 409,
    });
  });
});

describe("agent host refusals", () => {
  test("the feature an agent-host refusal names is translated, not left in English", () => {
    const failure = {
      error: {
        code: "unsupported",
        message: "Snapshots is not supported on agent hosts yet.",
        key: "agent_host_unsupported",
        params: { feature: "snapshots" },
      },
    };
    const message = inBrowser<string>(
      { languages: ["zh-CN"] },
      `await api.api("/api/boxes/alpha/snapshots", { method: "POST", body: {} }).then(() => null, (e) => e.message)`,
      [
        `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(failure))}, { status: 501, headers: { "content-type": "application/json" } });`,
        `const api = await import(${JSON.stringify(join(LIB, "api.js"))});`,
      ],
    );
    expect(message).toBe("Agent 宿主机暂不支持快照。");
  });
});

describe("mount lists", () => {
  test("a mount path is valid by the rule the server applies to it", () => {
    const samples = [
      "/",
      "/a",
      "/opt/minibox/tools",
      "/a//b",
      "/a/./b",
      "/a/../b",
      "/a b",
      "/a\u0000b",
      "relative",
      "",
      "/..data",
      "/data/",
      `/${"x".repeat(199)}`,
      `/${"x".repeat(200)}`,
    ];
    for (const path of samples) expect([path, validMountPath(path)]).toEqual([path, serverValidMountPath(path)]);
  });

  test("the canonical form ignores the order of the list and keeps the mode", () => {
    const sorted = [
      { volume: "a", path: "/a", mode: "rw" },
      { volume: "b", path: "/b", mode: "ro" },
    ] as const;
    const reversed = sorted.toReversed();
    expect(canonicalMounts(reversed)).toBe(canonicalMounts(sorted));
    expect(canonicalMounts([{ volume: "a", path: "/a", mode: "ro" }])).not.toBe(
      canonicalMounts([{ volume: "a", path: "/a", mode: "rw" }]),
    );
    expect(canonicalMounts(null)).toBe("[]");
  });

  test("the default mounts are the role mounts the server provisions when a create names none", () => {
    expect(DEFAULT_MOUNTS.map(({ role, path, mode }) => ({ role, path, mode }))).toEqual(
      VOLUME_ROLES.map((role) => ({ role, ...ROLE_MOUNT[role] })),
    );
  });

  test("a custom row needs a volume and a path the server accepts, once", () => {
    expect(checkMountRows([{ volume: "", path: "/data", mode: "rw" }])).toEqual({ problem: { code: "volume" } });
    expect(checkMountRows([{ volume: "vol_a", path: "data", mode: "rw" }])).toEqual({
      problem: { code: "mount_path_invalid", path: "data" },
    });
    expect(
      checkMountRows([
        { volume: "vol_a", path: "/data", mode: "rw" },
        { volume: "vol_b", path: "/data", mode: "ro" },
      ]),
    ).toEqual({ problem: { code: "mount_duplicate", path: "/data" } });
  });

  test("a valid custom list is sent as entered, and an empty list means a box with no mounts", () => {
    expect(
      checkMountRows([
        { volume: "vol_a", path: "/data", mode: "rw" },
        { volume: "vol_b", path: "/opt/tools", mode: "ro" },
      ]),
    ).toEqual({
      mounts: [
        { volume: "vol_a", path: "/data", mode: "rw" },
        { volume: "vol_b", path: "/opt/tools", mode: "ro" },
      ],
    });
    expect(checkMountRows([])).toEqual({ mounts: [] });
  });

  test("a volume another live box owns is listed but unavailable, and every other volume is available", () => {
    const volumes = [
      { id: "vol_1", name: "workspace", ownership: "owned", ownerBoxId: "bx_live", rwMounts: 1 },
      { id: "vol_2", name: "orphan", ownership: "owned", ownerBoxId: "bx_gone", rwMounts: 0 },
      { id: "vol_3", name: "shared", ownership: "independent", ownerBoxId: null, rwMounts: 2 },
    ] as const;
    expect(volumeChoices(volumes, new Set(["bx_live"]))).toEqual([
      {
        id: "vol_1",
        name: "workspace",
        hostId: null,
        pool: null,
        role: null,
        ownership: "owned",
        rwMounts: 1,
        disabled: true,
      },
      {
        id: "vol_2",
        name: "orphan",
        hostId: null,
        pool: null,
        role: null,
        ownership: "owned",
        rwMounts: 0,
        disabled: false,
      },
      {
        id: "vol_3",
        name: "shared",
        hostId: null,
        pool: null,
        role: null,
        ownership: "independent",
        rwMounts: 2,
        disabled: false,
      },
    ]);
  });

  test("a create row can name a role to create, and the roles it names are what the server makes", () => {
    expect(DEFAULT_MOUNTS.map((mount) => roleValue(mount.role))).toEqual([
      "role:workspace",
      "role:home",
      "role:tools",
      "role:cache",
    ]);
    for (const mount of DEFAULT_MOUNTS) {
      expect(roleOfValue(roleValue(mount.role))).toBe(mount.role);
      expect(roleMount(mount.role)).toEqual(mount);
    }
    // A volume id, an empty choice and a role the model does not have are not roles.
    expect([roleOfValue("vol_a"), roleOfValue(""), roleOfValue(null), roleOfValue("role:scratch")]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  test("the rows of the default list are sent as roles, and a row that names a role keeps the role's path and mode", () => {
    expect(checkMountRows(DEFAULT_MOUNTS.map((mount) => ({ volume: roleValue(mount.role), ...mount })))).toEqual({
      mounts: [{ role: "workspace" }, { role: "home" }, { role: "tools" }, { role: "cache" }],
    });
    // A row that creates a role cannot move it, so the server's own keys are what the dialog shows.
    expect(checkMountRows([{ volume: roleValue("workspace"), path: "/data", mode: "rw" }])).toEqual({
      problem: { code: "mount_create_role_path", role: "workspace", path: "/data", expected: "/workspace" },
    });
    expect(
      checkMountRows([
        { volume: roleValue("home"), path: "/home/dev", mode: "rw" },
        { volume: roleValue("home"), path: "/home/dev", mode: "rw" },
      ]),
    ).toEqual({ problem: { code: "mount_create_role_duplicate", role: "home" } });
  });

  test("a create row offers the roles first, then the volumes that exist, and names the shared tools volume", () => {
    const volumes = volumeChoices(
      [
        { id: "vol_1", name: "notes", role: null, ownership: "independent", ownerBoxId: null, rwMounts: 0 },
        { id: "vol_2", name: "shared-tools", role: "tools", ownership: "independent", ownerBoxId: null, rwMounts: 0 },
      ],
      new Set(),
    );
    const choices = createMountChoices(volumes, sharedToolsChoice(volumes) !== null);
    expect(choices.map((choice) => choice.value)).toEqual([
      "role:workspace",
      "role:home",
      "role:tools",
      "role:cache",
      "vol_1",
      "vol_2",
    ]);
    // The tools role reuses the host's shared tools volume, and says it creates one when the host has none.
    expect(choices.find((choice) => choice.role === "tools")).toMatchObject({ shared: true, noShared: false });
    expect(createMountChoices(volumes, false).find((choice) => choice.role === "tools")).toMatchObject({
      shared: false,
      noShared: true,
    });
    expect(sharedToolsChoice(volumes)?.name).toBe("shared-tools");
    expect(sharedToolsChoice(volumeChoices([], new Set()))).toBeNull();
  });

  test("the predicted role volume names follow the server: <box>-<role>, and the host's one shared tools volume", () => {
    // Mirrors `defaultRolePlans` in src/volumes/engine.ts. Nothing is created and no pool is read.
    expect(roleVolumeNames({ boxName: "alpha", hostId: "local", labelPrefix: "mbtest" })).toEqual({
      workspace: { name: "alpha-workspace", exists: false, exact: true, hostKnown: true },
      home: { name: "alpha-home", exists: false, exact: true, hostKnown: true },
      tools: { name: "mbtest-tools-local", exists: false, exact: true, hostKnown: true },
      cache: { name: "alpha-cache", exists: false, exact: true, hostKnown: true },
    });
    // A shared tools volume that exists is what the tools row mounts, so nothing is created for it.
    expect(
      roleVolumeNames({
        boxName: "alpha",
        hostId: "lab",
        labelPrefix: "mbtest",
        sharedTools: { name: "mbtest-tools-lab" },
      }).tools,
    ).toEqual({ name: "mbtest-tools-lab", exists: true, exact: true, hostKnown: true });
  });

  test("a name the host already uses is a preview too: the server adds a suffix the dialog cannot know", () => {
    const names = roleVolumeNames({
      boxName: "alpha",
      hostId: "local",
      labelPrefix: "mbtest",
      taken: ["alpha-workspace", "mbtest-tools-local"],
    });
    // `freeName` tries `-<pool>`, then `-2`, `-3`…, so neither the suffix nor the length is predictable here.
    expect(names.workspace).toMatchObject({ name: "alpha-workspace", exact: false });
    expect(names.tools).toMatchObject({ name: "mbtest-tools-local", exact: false });
    expect(names.home).toMatchObject({ name: "alpha-home", exact: true });
  });

  test("automatic placement cannot name the shared tools volume, and an empty box name names nothing", () => {
    const auto = roleVolumeNames({ boxName: "alpha", hostId: "", labelPrefix: "mbtest", hostKnown: false });
    expect(auto.tools).toEqual({ name: null, exists: false, exact: false, hostKnown: false });
    expect(auto.workspace).toMatchObject({ name: "alpha-workspace", exact: true });
    expect(roleVolumeNames({ boxName: "  ", hostId: "local", labelPrefix: "mbtest" }).workspace).toEqual({
      name: null,
      exists: false,
      exact: false,
      hostKnown: true,
    });
  });

  test("an empty box name shows the naming rule with the box-name placeholder, and a filled one shows the real name", () => {
    // The dialog passes its own i18n text for a Box name it does not have yet. Nothing here is a real name.
    const boxNamePlaceholder = "<box name>";
    const unnamed = roleVolumeNames({
      boxName: "   ",
      hostId: "local",
      labelPrefix: "mbtest",
      boxNamePlaceholder,
    });
    expect(unnamed.workspace).toEqual({
      name: null,
      placeholder: "<box name>-workspace",
      exists: false,
      exact: false,
      hostKnown: true,
    });
    expect([unnamed.home?.placeholder, unnamed.cache?.placeholder]).toEqual(["<box name>-home", "<box name>-cache"]);
    // The tools volume is not named after the box, so the placeholder leaves it alone.
    expect(unnamed.tools).toEqual({ name: "mbtest-tools-local", exists: false, exact: true, hostKnown: true });

    // The role choices carry the placeholder, so the row's option reads `<box name>-workspace (preview)`.
    const choices = createMountChoices([], false, unnamed);
    expect(
      choices.filter((choice) => choice.role).map((choice) => choice.preview?.placeholder ?? choice.preview?.name),
    ).toEqual(["<box name>-workspace", "<box name>-home", "mbtest-tools-local", "<box name>-cache"]);

    // Once the box is named, the placeholder is gone and the choices carry the names the create would make.
    const named = roleVolumeNames({ boxName: "alpha", hostId: "local", labelPrefix: "mbtest", boxNamePlaceholder });
    expect(named.workspace).toEqual({ name: "alpha-workspace", exists: false, exact: true, hostKnown: true });
    expect(named.workspace?.placeholder).toBeUndefined();
    expect(
      createMountChoices([], false, named)
        .filter((choice) => choice.role)
        .map((choice) => choice.preview?.name),
    ).toEqual(["alpha-workspace", "alpha-home", "mbtest-tools-local", "alpha-cache"]);
  });

  test("the preview lines show the placeholder name, which is never a name, and leave the tools cases as they were", () => {
    const boxNamePlaceholder = "<box name>";
    const rows = [roleValue("workspace"), roleValue("home"), roleValue("cache")].map((volume) => ({ volume }));
    const unnamed = roleVolumeNames({
      boxName: "",
      hostId: "local",
      labelPrefix: "mbtest",
      boxNamePlaceholder,
      // A volume whose display name reads like the placeholder is still not the name the dialog previews.
      taken: ["<box name>-workspace"],
    });
    // The placeholder is not a name: it is never compared with the names the host uses, so nothing takes a suffix.
    expect(unnamed.workspace).toMatchObject({ name: null, placeholder: "<box name>-workspace", exact: false });
    expect(previewNoteLines(rows, unnamed)).toEqual([
      { key: "cb.previewUnnamedName", params: { name: "<box name>-workspace" }, role: "workspace" },
      { key: "cb.previewUnnamedName", params: { name: "<box name>-home" }, role: "home" },
      { key: "cb.previewUnnamedName", params: { name: "<box name>-cache" }, role: "cache" },
    ]);

    // The shared tools volume and automatic placement keep their own lines, name or no name.
    const shared = roleVolumeNames({
      boxName: "",
      hostId: "local",
      labelPrefix: "mbtest",
      sharedTools: { name: "mbtest-tools-local" },
      boxNamePlaceholder,
    });
    expect(previewNoteLines([{ volume: roleValue("tools") }], shared)).toEqual([
      { key: "cb.previewShared", params: { name: "mbtest-tools-local" }, role: "tools" },
    ]);
    const auto = roleVolumeNames({
      boxName: "",
      hostId: "",
      labelPrefix: "mbtest",
      hostKnown: false,
      boxNamePlaceholder,
    });
    expect(auto.tools).toEqual({ name: null, exists: false, exact: false, hostKnown: false });
    expect(previewNoteLines([{ volume: roleValue("tools") }], auto)).toEqual([
      { key: "cb.previewHostUnknown", params: { role: "tools" }, role: "tools" },
    ]);
    // Only the box can name workspace, home and cache, so automatic placement still shows their naming rule.
    expect(previewNoteLines([{ volume: roleValue("workspace") }], auto)).toEqual([
      { key: "cb.previewUnnamedName", params: { name: "<box name>-workspace" }, role: "workspace" },
    ]);

    // A role row is still sent as `{ role }` (with its pool when it picked one): the placeholder is display only.
    expect(checkMountRows([{ volume: roleValue("workspace"), path: "/workspace", mode: "rw" }])).toEqual({
      mounts: [{ role: "workspace" }],
    });
  });

  test("the preview lines name only the roles a row still names, and never promise a name that may change", () => {
    const names = roleVolumeNames({ boxName: "alpha", hostId: "local", labelPrefix: "mbtest" });
    // A row that mounts a volume that exists creates nothing, so it contributes no line.
    const rows = [{ volume: "vol_1" }, { volume: roleValue("workspace") }];
    expect(previewRoleNames(rows, names)).toEqual([
      { role: "workspace", name: "alpha-workspace", exists: false, exact: true, hostKnown: true },
    ]);
    // Every line names the role it is about, so the dialog can add the pool that role's row picked.
    expect(previewNoteLines(rows, names)).toEqual([
      { key: "cb.previewCreate", params: { name: "alpha-workspace" }, role: "workspace" },
    ]);
    expect(previewNoteLines([{ volume: roleValue("home") }], names)).toEqual([
      { key: "cb.previewCreate", params: { name: "alpha-home" }, role: "home" },
    ]);
    const taken = roleVolumeNames({ boxName: "alpha", hostId: "local", labelPrefix: "mbtest", taken: ["alpha-home"] });
    expect(previewNoteLines([{ volume: roleValue("home") }], taken)).toEqual([
      { key: "cb.previewCreateInexact", params: { name: "alpha-home" }, role: "home" },
    ]);
    const shared = roleVolumeNames({
      boxName: "alpha",
      hostId: "local",
      labelPrefix: "mbtest",
      sharedTools: { name: "mbtest-tools-local" },
    });
    expect(previewNoteLines([{ volume: roleValue("tools") }], shared)).toEqual([
      { key: "cb.previewShared", params: { name: "mbtest-tools-local" }, role: "tools" },
    ]);
    const auto = roleVolumeNames({ boxName: "alpha", hostId: "", labelPrefix: "mbtest", hostKnown: false });
    expect(previewNoteLines([{ volume: roleValue("tools") }], auto)).toEqual([
      { key: "cb.previewHostUnknown", params: { role: "tools" }, role: "tools" },
    ]);
    expect(
      previewNoteLines(
        [{ volume: roleValue("cache") }],
        roleVolumeNames({ boxName: "", hostId: "local", labelPrefix: "mbtest" }),
      ),
    ).toEqual([{ key: "cb.previewUnnamed", params: { role: "cache" }, role: "cache" }]);
    expect(previewNoteLines([], names)).toEqual([]);
  });

  test("a create row carries the predicted name of its role, and the volumes that exist carry none", () => {
    const volumes = volumeChoices(
      [
        {
          id: "vol_1",
          name: "notes",
          hostId: "local",
          role: null,
          ownership: "independent",
          ownerBoxId: null,
          rwMounts: 0,
        },
        {
          id: "vol_2",
          name: "mbtest-tools-local",
          hostId: "local",
          role: "tools",
          ownership: "independent",
          ownerBoxId: null,
          rwMounts: 0,
        },
      ],
      new Set(),
    );
    const names = roleVolumeNames({
      boxName: "alpha",
      hostId: "local",
      labelPrefix: "mbtest",
      sharedTools: sharedToolsOnHost(volumes, "local"),
      taken: namesOnHost(volumes, "local"),
    });
    const choices = createMountChoices(volumes, sharedToolsChoice(volumes) !== null, names);
    expect(choices.filter((choice) => choice.role).map((choice) => choice.preview)).toEqual([
      { name: "alpha-workspace", exists: false, exact: true, hostKnown: true },
      { name: "alpha-home", exists: false, exact: true, hostKnown: true },
      { name: "mbtest-tools-local", exists: true, exact: true, hostKnown: true },
      { name: "alpha-cache", exists: false, exact: true, hostKnown: true },
    ]);
    expect(choices.filter((choice) => !choice.role).map((choice) => choice.preview)).toEqual([null, null]);
    // Without a prediction, the role choices say so rather than inventing a name.
    expect(
      createMountChoices(volumes, true)
        .filter((choice) => choice.role)
        .map((choice) => choice.preview),
    ).toEqual([null, null, null, null]);
  });

  test("a role's pool is the one it picked, and the rule's pool when it picked none", () => {
    const pools = [
      { name: "local", backend: "local" as const, default: false },
      { name: "nas", backend: "nfs" as const, default: true },
      { name: "disk", backend: "path" as const, default: false },
    ];
    // Mirrors `poolForRole` in src/volumes/pools.ts: cache goes to the local pool, the others to the default one.
    expect(rulePoolOf("workspace", { pools })).toBe("nas");
    expect(rulePoolOf("home", { pools })).toBe("nas");
    expect(rulePoolOf("tools", { pools })).toBe("nas");
    expect(rulePoolOf("cache", { pools })).toBe("local");
    // A role the pools page points at a pool follows that pool instead of the rule.
    expect(rulePoolOf("cache", { pools, roles: { cache: "disk" } })).toBe("disk");
    // Without a pool list the local pool is what the rule names, because it is the built-in one.
    expect(rulePoolOf("workspace", { pools: [] })).toBe("local");
    // A pick is what the row shows; a role left out follows the rule.
    expect(rolePoolPicks(["workspace", "home", "tools", "cache"], { picks: { workspace: "disk" }, pools })).toEqual({
      workspace: "disk",
      home: "nas",
      tools: "nas",
      cache: "local",
    });
    // A pick no pool matches is one that went away, so the role falls back to its rule instead of naming nothing.
    expect(rolePoolPicks(["workspace"], { picks: { workspace: "gone" }, pools }).workspace).toBe("nas");
  });

  test("a name another pool uses is still taken, because display names are unique per host", () => {
    const volumes = volumeChoices(
      [
        {
          id: "vol_1",
          name: "alpha-workspace",
          hostId: "local",
          pool: "local",
          role: "workspace",
          ownership: "owned",
          ownerBoxId: "bx_gone",
          rwMounts: 0,
        },
      ],
      new Set(),
    );
    // `nameTaken` in src/volumes/provision.ts compares every name the host uses, whatever pool it was made on, so a
    // name another pool already holds is a clash wherever the new volume goes.
    const elsewhere = roleVolumeNames({
      boxName: "alpha",
      hostId: "local",
      labelPrefix: "mbtest",
      taken: namesOnHost(volumes, "local"),
    });
    expect(elsewhere.workspace).toMatchObject({ name: "alpha-workspace", exact: false });
    expect(elsewhere.home).toMatchObject({ name: "alpha-home", exact: true });
  });

  test("the shared tools volume is one per pool, so the tools row follows the pool it picks", () => {
    const volumes = volumeChoices(
      [
        {
          id: "vol_1",
          name: "mbtest-tools-local",
          hostId: "local",
          pool: "local",
          role: "tools",
          ownership: "independent",
          ownerBoxId: null,
          rwMounts: 0,
        },
        {
          id: "vol_2",
          name: "mbtest-tools-nas",
          hostId: "local",
          pool: "nas",
          role: "tools",
          ownership: "independent",
          ownerBoxId: null,
          rwMounts: 0,
        },
      ],
      new Set(),
    );
    // Without a pool the answer is the first shared tools volume, as it always was; with one it is that pool's.
    expect(sharedToolsOnHost(volumes, "local")?.name).toBe("mbtest-tools-local");
    expect(sharedToolsOnHost(volumes, "local", "nas")?.name).toBe("mbtest-tools-nas");
    expect(sharedToolsOnHost(volumes, "local", "disk")).toBeNull();
    // The tools row mounts the shared volume of the pool it goes to, and makes one when that pool has none.
    expect(createMountChoices(volumes, new Map([["tools", true]]))[2]).toMatchObject({ shared: true, noShared: false });
    expect(createMountChoices(volumes, new Map([["tools", false]]))[2]).toMatchObject({
      shared: false,
      noShared: true,
    });
  });

  test("a role row is sent with the pool it picked, and without one when it picked none", () => {
    expect(checkMountRows([{ volume: roleValue("workspace"), path: "/workspace", mode: "rw", pool: "nas" }])).toEqual({
      mounts: [{ role: "workspace", pool: "nas" }],
    });
    // An empty pool control is "use the rule", which the server reads as no pick at all.
    expect(checkMountRows([{ volume: roleValue("home"), path: "/home/dev", mode: "rw", pool: "" }])).toEqual({
      mounts: [{ role: "home" }],
    });
    // A row that mounts a volume that exists carries no pool: that volume is already on its own.
    expect(checkMountRows([{ volume: "vol_a", path: "/data", mode: "rw", pool: "nas" }])).toEqual({
      mounts: [{ volume: "vol_a", path: "/data", mode: "rw" }],
    });
  });

  test("the names of a host are read from the volumes it holds, and its shared tools volume even when it is taken", () => {
    const volumes = volumeChoices(
      [
        {
          id: "vol_1",
          name: "alpha-workspace",
          hostId: "local",
          role: "workspace",
          ownership: "owned",
          ownerBoxId: "bx_live",
          rwMounts: 1,
        },
        {
          id: "vol_2",
          name: "mbtest-tools-local",
          hostId: "local",
          role: "tools",
          ownership: "independent",
          ownerBoxId: null,
          rwMounts: 0,
        },
        {
          id: "vol_3",
          name: "mbtest-tools-lab",
          hostId: "lab",
          role: "tools",
          ownership: "independent",
          ownerBoxId: null,
          rwMounts: 0,
        },
      ],
      new Set(["bx_live"]),
    );
    expect(namesOnHost(volumes, "local")).toEqual(["alpha-workspace", "mbtest-tools-local"]);
    expect(namesOnHost(volumes, "lab")).toEqual(["mbtest-tools-lab"]);
    expect(sharedToolsOnHost(volumes, "local")?.name).toBe("mbtest-tools-local");
    expect(sharedToolsOnHost(volumes, "elsewhere")).toBeNull();
    // A row cannot pick a volume another live box owns, so `sharedToolsChoice` hides it, but the host still has it.
    expect(sharedToolsChoice(volumes)?.name).toBe("mbtest-tools-local");
    // Both readers agree on the host's shared tools volume, which is the one a create reuses instead of making one.
    expect(sharedToolsChoice(volumes)?.name).toBe(sharedToolsOnHost(volumes, "local")?.name);
    // An owned tools volume belongs to a box, so it is not the host's shared one: the create makes a new one there.
    const owned = volumeChoices(
      [
        {
          id: "vol_4",
          name: "other-tools",
          hostId: "lab",
          role: "tools",
          ownership: "owned",
          ownerBoxId: "bx_gone",
          rwMounts: 0,
        },
      ],
      new Set(),
    );
    expect(sharedToolsOnHost(owned, "lab")).toBeNull();
  });

  test("volume and mount errors are the ones the Volumes section shows", () => {
    expect(["volume_missing", "volume_in_use", "mount_path_invalid", "mount_invalid"].map(isVolumeErrorKey)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(["box_exists", "template_image_missing", undefined].map(isVolumeErrorKey)).toEqual([false, false, false]);
  });
});

describe("api error keys", () => {
  test("a server error keeps its message key, so a dialog can tell a volume error from a name conflict", () => {
    const seen = inBrowser<{ key: string; code: string; status: number; message: string }>(
      { languages: ["en-US"] },
      `await (async () => {
        globalThis.fetch = async () =>
          new Response(JSON.stringify({ error: { code: "conflict", message: "x", key: "volume_missing", params: { volume: "data" } } }), { status: 409 });
        try {
          await (await import(${JSON.stringify(join(LIB, "api.js"))})).api("/api/boxes", { method: "POST", body: {} });
        } catch (e) {
          return { key: e.key, code: e.code, status: e.status, message: e.message };
        }
      })()`,
    );
    expect(seen).toEqual({
      key: "volume_missing",
      code: "conflict",
      status: 409,
      message: expect.stringContaining("Volume data no longer exists"),
    });
  });
});

/** Tools in catalog order, with the fields the picker reads. Category labels come from the loaded dictionary. */
const TOOLS = `
  const categoryLabel = (id) => i18n.t("tool.cat." + id);
  const tool = (fields) => ({ description: "", needsRoot: false, installed: false, managed: false, ...fields });
  const tools = [
    tool({ id: "codex", name: "Codex", description: "Coding agent from OpenAI", category: "agents" }),
    tool({ id: "bun", name: "Bun", description: "Fast JavaScript runtime", category: "languages" }),
    tool({ id: "herdr", name: "herdr", description: "Terminal workspace for agents", category: "terminal" }),
    tool({ id: "tailscale", name: "Tailscale", description: "Private mesh network", category: "networking", needsRoot: true }),
    tool({ id: "zig", name: "Zig", description: "Systems language toolchain", category: "languages" }),
  ];
`;

/** Ten tools in catalog order. Seven are languages, so the collapsed picker has a group that folds and hides rows. */
const PICKER_TOOLS = `
  const tool = (fields) => ({ description: "", needsRoot: false, installed: false, managed: false, ...fields });
  const languages = ["bun", "zig", "go", "rust", "deno", "lua", "julia"].map((id) => tool({ id, name: id, category: "languages" }));
  const catalog = [
    tool({ id: "codex", name: "Codex", category: "agents" }),
    ...languages,
    tool({ id: "herdr", name: "herdr", category: "terminal" }),
    tool({ id: "tailscale", name: "Tailscale", category: "networking" }),
  ];
  const shape = (view) => ({
    groups: view.groups.map((group) => [group.id, group.count, group.folded, group.rows.map((row) => row.id)]),
    count: view.count,
    toggle: view.toggle,
  });
`;

describe("tool picker", () => {
  test("a query finds a tool by name, id, description or category label, every word must match, and case is ignored", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `(() => {
          ${TOOLS}
          const find = (query) => toolList.filterTools(tools, query, categoryLabel).map((tool) => tool.id);
          return {
            name: find("CODEX"),
            id: find("tailscale"),
            description: find("mesh"),
            category: find("networking"),
            label: find("runtimes"),
            words: find("zig toolchain"),
            everyWord: find("bun agent"),
            none: find("nope"),
            blank: toolList.filterTools(tools, "  ", categoryLabel) === tools,
          };
        })()`,
      ),
    ).toEqual({
      name: ["codex"],
      id: ["tailscale"],
      description: ["tailscale"],
      category: ["tailscale"],
      label: ["bun", "zig"],
      words: ["zig"],
      everyWord: [],
      none: [],
      blank: true,
    });
  });

  test("a Chinese picker searches the Chinese category labels", () => {
    expect(
      inBrowser(
        { languages: ["zh-CN"] },
        `(() => {
          ${TOOLS}
          const find = (query) => toolList.filterTools(tools, query, categoryLabel).map((tool) => tool.id);
          return { runtimes: find("运行时"), agents: find("代理"), networking: find("网络") };
        })()`,
      ),
    ).toEqual({ runtimes: ["bun", "zig"], agents: ["codex"], networking: ["tailscale"] });
  });

  test("groups follow the picker's order, drop empty categories, and keep catalog order inside each group", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `(() => {
          ${TOOLS}
          const shape = (list) => toolList.groupTools(list).map((group) => [group.id, group.rows.map((tool) => tool.id)]);
          return {
            all: shape(tools),
            runtimes: shape(toolList.filterTools(tools, "runtimes", categoryLabel)),
            reversed: shape([...tools].reverse()),
          };
        })()`,
      ),
    ).toEqual({
      all: [
        ["category:agents", ["codex"]],
        ["category:languages", ["bun", "zig"]],
        ["category:terminal", ["herdr"]],
        ["category:networking", ["tailscale"]],
      ],
      runtimes: [["category:languages", ["bun", "zig"]]],
      reversed: [
        ["category:agents", ["codex"]],
        ["category:languages", ["zig", "bun"]],
        ["category:terminal", ["herdr"]],
        ["category:networking", ["tailscale"]],
      ],
    });
  });

  test("the search fields are the name, id, description, category id and its label", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `(() => {
          ${TOOLS}
          return toolList.toolSearchFields(tools[0], categoryLabel);
        })()`,
      ),
    ).toEqual(["Codex", "codex", "Coding agent from OpenAI", "agents", "AI coding agents"]);
  });

  test("each tool gets one row action: a root tool none, a missing tool an install, a MiniBox tool an upgrade and uninstall", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `[
          { needsRoot: true, installed: false, managed: false },
          { needsRoot: false, installed: false, managed: false },
          { needsRoot: false, installed: true, managed: true },
          { needsRoot: false, installed: true, managed: false },
          { needsRoot: true, installed: true, managed: false },
        ].map((tool) => toolList.toolAction(tool))`,
      ),
    ).toEqual(["needsRoot", "install", "managed", "outside", "needsRoot"]);
  });

  test("a collapsed picker shows the first five tools in display order, and a tool picked past them stays in its place", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `(() => {
          ${PICKER_TOOLS}
          return {
            collapsed: shape(toolList.pickerView(catalog, { selected: new Set() })),
            picked: shape(toolList.pickerView(catalog, { selected: new Set(["julia"]) })),
          };
        })()`,
      ),
    ).toEqual({
      collapsed: {
        groups: [
          ["category:agents", 1, false, ["codex"]],
          ["category:languages", 7, false, ["bun", "zig", "go", "rust"]],
        ],
        count: 10,
        toggle: true,
      },
      picked: {
        groups: [
          ["category:agents", 1, false, ["codex"]],
          ["category:languages", 7, false, ["bun", "zig", "go", "rust", "julia"]],
        ],
        count: 10,
        toggle: true,
      },
    });
  });

  test("an expanded picker shows every tool, and a folded group keeps only its picked tools, or none", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `(() => {
          ${PICKER_TOOLS}
          const folded = (id) => id === "category:languages";
          return {
            expanded: shape(toolList.pickerView(catalog, { selected: new Set(), expanded: true })),
            picked: shape(toolList.pickerView(catalog, { selected: new Set(["zig"]), isFolded: folded })),
            empty: shape(toolList.pickerView(catalog, { selected: new Set(), isFolded: folded })),
          };
        })()`,
      ),
    ).toEqual({
      expanded: {
        groups: [
          ["category:agents", 1, false, ["codex"]],
          ["category:languages", 7, false, ["bun", "zig", "go", "rust", "deno", "lua", "julia"]],
          ["category:terminal", 1, false, ["herdr"]],
          ["category:networking", 1, false, ["tailscale"]],
        ],
        count: 10,
        toggle: true,
      },
      picked: {
        groups: [
          ["category:agents", 1, false, ["codex"]],
          ["category:languages", 7, true, ["zig"]],
        ],
        count: 10,
        toggle: true,
      },
      empty: {
        groups: [
          ["category:agents", 1, false, ["codex"]],
          ["category:languages", 7, true, []],
        ],
        count: 10,
        toggle: true,
      },
    });
  });

  test("a search shows every match and folds nothing, a search with no match shows nothing, and only more than five tools get a toggle", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `(() => {
          ${PICKER_TOOLS}
          const folded = () => true;
          return {
            search: shape(toolList.pickerView(catalog, { query: "languages", selected: new Set(), isFolded: folded })),
            none: shape(toolList.pickerView(catalog, { query: "nothing", selected: new Set() })),
            toggles: [catalog.slice(0, 5), catalog.slice(0, 6)].map((list) => toolList.pickerView(list, { selected: new Set() }).toggle),
          };
        })()`,
      ),
    ).toEqual({
      search: {
        groups: [["category:languages", 7, false, ["bun", "zig", "go", "rust", "deno", "lua", "julia"]]],
        count: 7,
        toggle: false,
      },
      none: { groups: [], count: 0, toggle: false },
      toggles: [false, true],
    });
  });

  test("the create dialog searches template cards without the badge, which that dialog does not show", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `(() => {
          const templates = [{ id: "sha256:aaa111", ref: "minibox-template:base", tags: [], name: "base", description: null }];
          return search.filterBySearch(templates, "built-in", (tp) => templateList.templateSearchFields(tp, "")).length;
        })()`,
      ),
    ).toBe(0);
  });
});

describe("box state badges", () => {
  test("a box asleep for idle reads sleeping, one past its TTL reads TTL expired, and a running box keeps its state", () => {
    const badges = inBrowser<{ idle: string; ttl: string; running: string; expired: string }>(
      { languages: ["en-US"] },
      `({
        idle: ui.boxState({ state: "exited", sleeping: true, stopReason: "idle" }),
        ttl: ui.boxState({ state: "exited", sleeping: true, stopReason: "ttl" }),
        running: ui.boxState({ state: "running", sleeping: false, stopReason: null }),
        expired: ui.stateBadge("expired"),
      })`,
      [`const ui = await import(${JSON.stringify(join(LIB, "ui.js"))});`],
    );
    expect({ idle: badges.idle, ttl: badges.ttl, running: badges.running }).toEqual({
      idle: "sleeping",
      ttl: "expired",
      running: "running",
    });
    expect(badges.expired).toContain("TTL expired");
  });
});

describe("recycle bin countdown", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-10-22T00:00:00.000Z");
  const at = (ms: number) => new Date(now + ms).toISOString();

  test("counts the days left, and a part of a day counts as a day", () => {
    expect(daysLeft(at(7 * DAY), now)).toBe(7);
    expect(daysLeft(at(DAY / 2), now)).toBe(1);
    expect(daysLeft(at(DAY + 1), now)).toBe(2);
  });

  test("an entry whose time has passed, or whose time is not a date, has no days left", () => {
    expect(daysLeft(at(0), now)).toBe(0);
    expect(daysLeft(at(-DAY), now)).toBe(0);
    expect(daysLeft("not a date", now)).toBe(0);
  });
});

describe("owner key notice", () => {
  const lastUsedAt = "2026-10-23T01:00:00.000Z";

  test("is the outcome the server reports, and nothing when the owner key was not used lately", () => {
    expect(ownerKeyNotice({ mcpOwnerKey: { outcome: "accepted", lastUsedAt } })).toBe("accepted");
    expect(ownerKeyNotice({ mcpOwnerKey: { outcome: "refused", lastUsedAt } })).toBe("refused");
    expect(ownerKeyNotice({ mcpOwnerKey: null })).toBeNull();
    expect(ownerKeyNotice({})).toBeNull();
    expect(ownerKeyNotice(null)).toBeNull();
  });

  test("an outcome the console does not know shows nothing", () => {
    expect(ownerKeyNotice({ mcpOwnerKey: { outcome: "maybe" as "accepted", lastUsedAt } })).toBeNull();
  });
});

describe("custom tool form", () => {
  const claude = JSON.parse(readFileSync(join(ROOT, "catalog", "claude-code.json"), "utf8")) as CommandTemplate;
  const npm = commandTemplate("npm") as CommandTemplate;
  const pip = commandTemplate("pip") as CommandTemplate;

  test("the npm template is claude-code's own install, upgrade and uninstall, and its detect names the binary", () => {
    expect({ install: npm.install, upgrade: npm.upgrade, uninstall: npm.uninstall }).toEqual({
      install: claude.install,
      upgrade: claude.upgrade,
      uninstall: claude.uninstall,
    });
    expect(npm.detect).toBe("command -v {{bin}} >/dev/null && {{bin}} --version 2>/dev/null");
  });

  test("a pip template installs into a venv under tools/venvs and links the binary, so uninstall removes exactly that", () => {
    expect(pip.install).toBe(pip.upgrade);
    expect(pip.install).toContain("python3 -m venv {{prefix}}/venvs/{{bin}}");
    expect(pip.install).toContain("{{prefix}}/venvs/{{bin}}/bin/pip install --upgrade {{package_spec}}");
    expect(pip.uninstall).toBe("rm -f {{prefix}}/bin/{{bin}} && rm -rf {{prefix}}/venvs/{{bin}}");
  });

  test("a script has no template, and only the two package managers do", () => {
    expect([commandTemplate("script"), commandTemplate("nope")]).toEqual([null, null]);
  });

  test("a source change moves the commands still holding a template and keeps the ones the admin typed", () => {
    const typed = { ...npm, upgrade: "my upgrade", stop: "my stop" };
    expect(commandsForSource(typed, "npm", "pip")).toEqual({ ...pip, upgrade: "my upgrade", stop: "my stop" });
    expect(commandsForSource(typed, "npm", "script")).toEqual({
      install: "",
      upgrade: "my upgrade",
      uninstall: "",
      stop: "my stop",
      detect: "",
    });
    expect(
      commandsForSource({ install: "", upgrade: "", uninstall: "", stop: "", detect: "" }, "script", "npm"),
    ).toEqual({ ...npm, stop: "" });
  });

  test("a new entry starts on npm with its templates, and an existing entry shows its own text", () => {
    expect(customToolForm(null)).toEqual({
      id: "",
      name: "",
      description: "",
      category: "agents",
      source: "npm",
      package: "",
      bin: "",
      requires: "",
      estimatedMb: "50",
      needsRoot: false,
      overrideBuiltin: false,
      ...npm,
      stop: "",
    });
    const entry = {
      id: "acme",
      name: "Acme",
      description: "Acme CLI",
      category: "terminal",
      source: "script",
      package: "acme.dev",
      bin: "acme",
      requires: null,
      estimatedMb: 12,
      needsRoot: false,
      overridesBuiltin: true,
      install: "i",
      upgrade: "u",
      uninstall: "x",
      stop: "s" as string | null,
      detect: "d",
    };
    const existing = customToolForm(entry);
    expect(existing).toEqual({
      id: "acme",
      name: "Acme",
      description: "Acme CLI",
      category: "terminal",
      source: "script",
      package: "acme.dev",
      bin: "acme",
      requires: "",
      estimatedMb: "12",
      needsRoot: false,
      overrideBuiltin: true,
      install: "i",
      upgrade: "u",
      uninstall: "x",
      stop: "s",
      detect: "d",
    });
    expect(customToolForm({ ...entry, stop: null }).stop).toBe("");
  });

  test("an id is built in when the merged catalog lists it, unless a custom entry says otherwise", () => {
    const catalogIds = new Set(["claude-code", "uv", "acme", "mine"]);
    const customById = new Map([
      ["acme", { id: "acme", overridesBuiltin: true }],
      ["mine", { id: "mine", overridesBuiltin: false }],
    ]);
    expect(["claude-code", "uv", "acme", "mine", "fresh"].map((id) => isBuiltinId(id, catalogIds, customById))).toEqual(
      [true, true, true, false, false],
    );
  });

  test("the request body trims text, leaves out the id and a blank requirement, and sends a size as a number when it is one", () => {
    const values = {
      ...customToolForm(null),
      id: "acme",
      name: "  Acme  ",
      package: " acme.dev ",
      bin: "acme",
      requires: "   ",
      estimatedMb: " 12 ",
      needsRoot: true,
    };
    const body = customToolBody(values);
    expect(body).toEqual({
      name: "Acme",
      description: "",
      category: "agents",
      source: "npm",
      package: "acme.dev",
      bin: "acme",
      needsRoot: true,
      estimatedMb: 12,
      install: npm.install,
      upgrade: npm.upgrade,
      uninstall: npm.uninstall,
      detect: npm.detect,
      overrideBuiltin: false,
    });
    expect(body).not.toHaveProperty("id");
    expect(customToolBody({ ...values, requires: " Node ≥ 22 " }).requires).toBe("Node ≥ 22");
    expect(body).not.toHaveProperty("stop");
    expect(customToolBody({ ...values, stop: "  {{prefix}}/bin/acme stop  " }).stop).toBe("{{prefix}}/bin/acme stop");
    expect(customToolBody({ ...values, estimatedMb: "1.5" }).estimatedMb).toBe("1.5");
    expect(customToolBody({ ...values, estimatedMb: "" }).estimatedMb).toBe("");
  });

  test("an id is valid when it is a lowercase letter, then lowercase letters, digits or hyphens, at most 63 characters", () => {
    expect(["acme", "acme-2", "a".repeat(63)].map(validCustomId)).toEqual([true, true, true]);
    expect(["Acme", "2acme", "acme_x", "", "a".repeat(64)].map(validCustomId)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});
