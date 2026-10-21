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
