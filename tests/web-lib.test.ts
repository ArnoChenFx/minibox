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
  DEFAULT_MOUNTS,
  isVolumeErrorKey,
  validMountPath,
  volumeChoices,
} from "../web/js/lib/mounts.js";
import { retiredRedirect } from "../web/js/lib/retired-routes.js";

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
          gb2: format.gb(2 * 1024 ** 3),
          gb20: format.gb(20 * 1024 ** 3),
          pct: format.pct(12.345),
          pctRounded: format.pct(12.345, 0),
          pctNaN: format.pct(NaN),
          cpusNull: format.cpus(null),
          cpus2: format.cpus(2),
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
      gb2: "2.0 GB",
      gb20: "20 GB",
      pct: "12.3%",
      pctRounded: "12%",
      pctNaN: "—",
      cpusNull: "Unlimited",
      cpus2: "2 cores",
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
          hours: format.duration(3700),
          justNow: format.relTime(new Date(Date.now() - 5000).toISOString()),
        })`,
      ),
    ).toEqual({ mem: "不限", cpus: "2 核", hours: "1 小时 1 分钟", justNow: "刚刚" });
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

  test("level maps a percentage to the warning and critical thresholds", () => {
    expect(
      inBrowser({ languages: ["en-US"] }, `({ crit: format.level(95), warn: format.level(80), ok: format.level(10) })`),
    ).toEqual({ crit: "crit", warn: "warn", ok: "" });
  });
});

describe("search matching", () => {
  test("a blank query matches every item, and a term matches any field whatever its case", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `({
          blank: search.matchesSearch("   ", ["alpha"]),
          noFields: search.matchesSearch("", []),
          caseless: search.matchesSearch("VOL_AB", ["vol_abc"]),
          anyField: search.matchesSearch("pool", ["alpha", "local pool"]),
          miss: search.matchesSearch("zzz", ["alpha"]),
        })`,
      ),
    ).toEqual({ blank: true, noFields: true, caseless: true, anyField: true, miss: false });
  });

  test("every term must match, each in some field, and extra spaces are ignored", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `({
          both: search.matchesSearch("dev workspace", ["dev", "/workspace"]),
          spaced: search.matchesSearch("  Dev   WORK ", ["dev", "/workspace"]),
          oneMissing: search.matchesSearch("dev missing", ["dev", "/workspace"]),
        })`,
      ),
    ).toEqual({ both: true, spaced: true, oneMissing: false });
  });

  test("null, undefined and empty fields are skipped rather than matched", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `({
          nothing: search.matchesSearch("x", [null, undefined, ""]),
          something: search.matchesSearch("abc", [null, "abc"]),
        })`,
      ),
    ).toEqual({ nothing: false, something: true });
  });

  test("non-Latin text matches as it is written", () => {
    expect(
      inBrowser(
        { languages: ["en-US"] },
        `({ hit: search.matchesSearch("内置", ["内置模板"]), miss: search.matchesSearch("自定义", ["内置模板"]) })`,
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

describe("remote host refusals", () => {
  test("the feature a remote-host refusal names is translated, not left in English", () => {
    const failure = {
      error: {
        code: "unsupported",
        message: "Snapshots is not supported on remote hosts yet.",
        key: "host_unsupported",
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
    expect(message).toBe("远程宿主机暂不支持快照。");
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
      { id: "vol_1", name: "workspace", rwMounts: 1, disabled: true },
      { id: "vol_2", name: "orphan", rwMounts: 0, disabled: false },
      { id: "vol_3", name: "shared", rwMounts: 2, disabled: false },
    ]);
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

describe("retired console addresses", () => {
  test("the old Snapshots address opens Templates, which lists the snapshots that remain", () => {
    expect(retiredRedirect("/snapshots")).toBe("#/templates");
  });

  test("a path that still has a page is not redirected", () => {
    for (const path of ["/templates", "/templates/python-ml", "/boxes/bx_1", "/snapshotsx", "/constructor"]) {
      expect([path, retiredRedirect(path)]).toEqual([path, ""]);
    }
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
