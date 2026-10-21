import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { ROOT } from "../src/config";

const LIB = join(ROOT, "web", "js", "lib");

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
function inBrowser<T>(browser: Browser, expression: string): T {
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
