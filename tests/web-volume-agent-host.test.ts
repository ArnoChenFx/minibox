import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { ROOT } from "../src/config";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";

const WEB = join(ROOT, "web");
const CELLS = join(WEB, "js", "components", "volume-cells.js");
const ROW = join(WEB, "js", "lib", "volume-row.js");
const USAGE = join(WEB, "js", "components", "volume-usage.js");
const STORAGE_CK = join(WEB, "js", "components", "storage-checkpoints.js");

/** Enough of a browser for these modules to load: they read a document and a language at import, and nothing else. */
const BROWSER = `
const realTimeout = globalThis.setTimeout;
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
const element = () => ({
  innerHTML: "", dataset: {}, hidden: false, disabled: false, checked: false,
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {},
  getAttribute: () => null, focus() {}, closest: () => null, append() {}, remove() {},
  querySelector: () => element(), querySelectorAll: () => [], contains: () => true,
});
Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: {}, body: element(), querySelector: () => null, querySelectorAll: () => [], createElement: () => element(), addEventListener() {}, removeEventListener() {} } });
Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) } });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: [LANG], language: LANG } });
Object.defineProperty(globalThis, "location", { configurable: true, value: { hash: "", search: "", pathname: "/", origin: "http://localhost" } });
`;

/** Runs `body` in a fresh process set to `language`, with `path` imported as `module`. Returns what `body` gives. */
function inBrowser<T>(language: "en-US" | "zh-CN", path: string, body: string): T {
  const script = [
    BROWSER.replaceAll("LANG", JSON.stringify(language)),
    `const module = await import(${JSON.stringify(path)});`,
    `const cells = await import(${JSON.stringify(CELLS)});`,
    `const out = await (async () => {`,
    body,
    `})();`,
    `console.log(JSON.stringify(out));`,
  ].join("\n");
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "null") as T;
}

/** Lets every promise the mounted component started settle, so its drawing is finished before it is read. */
const SETTLE = "for (let turn = 0; turn < 200; turn += 1) await new Promise((resolve) => realTimeout(resolve, 0));";

/** One button of the markup, so a test can read what a row says about it. */
const button = (html: string, action: string): string =>
  html.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`))?.[0] ?? "";
const titleOf = (tag: string): string => /\btitle="([^"]*)"/.exec(tag)?.[1] ?? "";
const isDisabled = (tag: string): boolean => /\bdisabled\b/.test(tag);

/** The English text of a dictionary key, which a test compares against. */
const english = (key: string): string => en[key] ?? key;

const volume = (extra = {}) => ({
  id: "vol_1",
  name: "notes",
  hostId: "edge",
  role: null,
  checkpoint: true,
  ownership: "independent",
  ownerBoxId: null,
  mounts: [],
  bytes: 1024,
  limits: { softBytes: null, hardBytes: null, action: "warn" },
  usage: { scope: "volume", level: "unknown", history: [], lastError: null },
  ...extra,
});

const AGENT = [
  { id: "local", transport: "local" },
  { id: "edge", transport: "agent" },
];
const PLAIN = [
  { id: "local", transport: "local" },
  { id: "edge", transport: "unix" },
];

describe("a volume row's buttons on an agent host", () => {
  test("browse and snapshot are disabled with the reason as their title, and stay usable on any other host", () => {
    const out = inBrowser<{ agentBrowse: string; agentSnapshot: string; plainBrowse: string; plainSnapshot: string }>(
      "en-US",
      ROW,
      `const volume = () => (${JSON.stringify(volume())});
       const row = (hosts) => {
         const block = module.agentVolumeBlock(volume(), hosts);
         return {
           browse: cells.rowButton("browse", volume(), "folder", "Browse files", { block }),
           snapshot: cells.rowButton("snapshot", volume(), "camera", "Snapshot", { block }),
         };
       };
       const agent = row(${JSON.stringify(AGENT)});
       const plain = row(${JSON.stringify(PLAIN)});
       return { agentBrowse: agent.browse, agentSnapshot: agent.snapshot, plainBrowse: plain.browse, plainSnapshot: plain.snapshot };`,
    );
    // The blocked buttons carry the reason, which the page spells out once above the table.
    expect(titleOf(out.agentBrowse)).toBe(`Browse files: ${english("vol.agentHost")}`);
    expect(titleOf(out.agentSnapshot)).toBe(`Snapshot: ${english("vol.agentHost")}`);
    expect(isDisabled(out.agentBrowse)).toBe(true);
    expect(isDisabled(out.agentSnapshot)).toBe(true);
    // A host that is not an agent keeps both buttons exactly as they were: the label alone, and no `disabled`.
    expect(titleOf(out.plainBrowse)).toBe("Browse files");
    expect(titleOf(out.plainSnapshot)).toBe("Snapshot");
    expect(isDisabled(out.plainBrowse)).toBe(false);
    expect(isDisabled(out.plainSnapshot)).toBe(false);
  }, 30_000);

  test("the measure button in the size cell takes the same reason, in both languages", () => {
    for (const [language, dictionary] of [
      ["en-US", en],
      ["zh-CN", zh],
    ] as const) {
      const text = (key: string): string => dictionary[key] ?? "";
      const out = inBrowser<{ agent: string; plain: string }>(
        language,
        USAGE,
        `return {
          agent: module.usageCellHtml(${JSON.stringify(volume())}, "vol.agentHost"),
          plain: module.usageCellHtml(${JSON.stringify(volume())}, ""),
        };`,
      );
      expect([language, titleOf(button(out.agent, "measure"))]).toEqual([
        language,
        `${text("vol.measure")}: ${text("vol.agentHost")}`,
      ]);
      expect([language, isDisabled(button(out.agent, "measure"))]).toEqual([language, true]);
      expect([language, titleOf(button(out.plain, "measure"))]).toEqual([language, text("vol.measure")]);
      expect([language, isDisabled(button(out.plain, "measure"))]).toEqual([language, false]);
    }
  }, 30_000);
});

/** Draws the timeline with the two boxes below and the hosts `hosts`, and returns its markup. */
function drawTimeline(hosts: readonly { id: string; transport: string }[]): string {
  return inBrowser<string>(
    "en-US",
    STORAGE_CK,
    `
    globalThis.EventSource = undefined;
    globalThis.fetch = async (path) => {
      if (path.startsWith("/api/hosts")) return { ok: true, status: 200, text: async () => JSON.stringify({ hosts: ${JSON.stringify(hosts)} }) };
      const body = path.startsWith("/api/checkpoints/usage")
        ? null
        : path.startsWith("/api/checkpoints")
          ? { checkpoints: [] }
          : path.startsWith("/api/rollbacks")
            ? { rollbacks: [] }
            : { boxes: [
                { id: "b1", boxId: "bx_1", name: "alpha", hostId: "edge" },
                { id: "b2", boxId: "bx_2", name: "beta", hostId: "local" },
              ] };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const root = element();
    const dispose = module.mountStorageCheckpoints(root, {});
    ${SETTLE}
    const html = root.innerHTML;
    dispose();
    return html;`,
  );
}

describe("the checkpoint timeline's take button on an agent host", () => {
  test("a box on an agent host cannot take a checkpoint, and a box on any other host can", () => {
    const html = drawTimeline([
      { id: "local", transport: "local" },
      { id: "edge", transport: "agent" },
    ]);
    const edge = button(html, "ck-take").split("<button")[1] ?? "";
    expect(titleOf(edge)).toBe(`${english("act.checkpoint")}: ${english("bd.agentCheckpoints")}`);
    expect(isDisabled(edge)).toBe(true);
    // The other box is on the local host, so its take button keeps the plain label and stays enabled.
    const takes = [...html.matchAll(/<button[^>]*data-action="ck-take"[^>]*>/g)].map((match) => match[0]);
    expect(takes).toHaveLength(2);
    const plain = takes.find((tag) => tag.includes('data-box="bx_2"')) ?? "";
    expect(titleOf(plain)).toBe(english("act.checkpoint"));
    expect(isDisabled(plain)).toBe(false);
  }, 30_000);

  test("with no agent host, every take button is enabled", () => {
    const html = drawTimeline([
      { id: "local", transport: "local" },
      { id: "edge", transport: "unix" },
    ]);
    const takes = [...html.matchAll(/<button[^>]*data-action="ck-take"[^>]*>/g)].map((match) => match[0]);
    expect(takes).toHaveLength(2);
    for (const tag of takes) {
      expect(titleOf(tag)).toBe(english("act.checkpoint"));
      expect(isDisabled(tag)).toBe(false);
    }
  }, 30_000);
});
