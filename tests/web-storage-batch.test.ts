import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";

const WEB = join(ROOT, "web");
const STORAGE = join(WEB, "js", "components", "storage-checkpoints.js");
const VOLUMES = join(WEB, "js", "pages", "volumes.js");

/**
 * Runs `body` in a fresh process, with the browser the storage page touches stubbed. The stubs are enough for the
 * checkpoint timeline to draw: `innerHTML` is kept as text, and every element query answers an empty list. The value
 * `body` returns comes back as JSON.
 */
function inBrowser<T>(body: string): T {
  const script = [
    BROWSER,
    `const component = await import(${JSON.stringify(STORAGE)});`,
    `const result = await (async () => {`,
    body,
    `})();`,
    `console.log(JSON.stringify(result));`,
  ].join("\n");
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "null") as T;
}

/** The browser the checkpoint timeline reads: a document, a window, storage, a language and a location. */
const BROWSER = `
const realTimeout = globalThis.setTimeout;
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
const element = () => ({
  innerHTML: "",
  dataset: {},
  hidden: false,
  disabled: false,
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {},
  removeEventListener() {},
  setAttribute() {},
  removeAttribute() {},
  getAttribute: () => null,
  focus() {},
  closest: () => null,
  querySelector: () => element(),
  querySelectorAll: () => [],
  contains: () => true,
  append() {},
  remove() {},
});
Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: {}, body: element(), querySelector: () => null, querySelectorAll: () => [], createElement: () => element(), addEventListener() {}, removeEventListener() {} } });
Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) } });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], language: "en" } });
Object.defineProperty(globalThis, "location", { configurable: true, value: { hash: "", search: "", pathname: "/", origin: "http://localhost" } });
`;

const settle = "for (let turn = 0; turn < 200; turn += 1) await new Promise((resolve) => realTimeout(resolve, 0));";

/** The console's sources, so a test can hold the page to the batch reads it should make. */
const volumes = readFileSync(VOLUMES, "utf8");
const storage = readFileSync(STORAGE, "utf8");

describe("the storage page reads staged changes and waiting rollbacks in one request each", () => {
  test("the volumes table asks for every box's staged changes once, not once per box", () => {
    expect(volumes).toContain('api("/api/staged")');
    expect(volumes).not.toContain("/staged`");
    expect(volumes).not.toContain("/staged)");
  });

  test("the checkpoint timeline asks for every waiting rollback once, not once per box", () => {
    expect(storage).toContain('api("/api/rollbacks")');
    expect(storage).not.toContain("/rollback`");
    expect(storage).not.toContain("/rollback)");
  });

  test("a failed staged read leaves the volumes table without the pending column, and no request fails the load", () => {
    // The read is caught where it is made, so the volume, pool, box and checkpoint reads still draw the page.
    expect(volumes).toContain(".then((body) => body.staged ?? [])");
    expect(volumes).toContain(".catch(() => [])");
  });

  test("a failed rollback read draws the timeline without a pending line", () => {
    expect(storage).toContain(".catch(() => ({ rollbacks: [] }))");
  });
});

/** A rollback that waits, as `/api/rollbacks` returns it. */
function pendingRollback(boxId: string) {
  return {
    boxId,
    checkpoint: { id: "ck_1", label: "before the change" },
    safetyCheckpointId: "ck_safe",
    createdBy: "owner",
    createdAt: "2026-10-20T10:00:00.000Z",
    replaced: [{ id: "vol_r", name: "alpha-workspace", path: "/workspace" }],
    restored: [{ id: "vol_s", name: "alpha-old", path: "/workspace" }],
  };
}

describe("the checkpoint timeline draws the rollbacks the batch read returns", () => {
  test("a waiting rollback is a line with both buttons, and a box with none has no line", () => {
    const PENDING = pendingRollback("bx_1");
    const out = inBrowser<{ paths: string[]; pending: boolean; other: number }>(`
      const paths = [];
      globalThis.EventSource = undefined;
      globalThis.fetch = async (path) => {
        paths.push(path);
        const body = path.startsWith("/api/rollbacks")
          ? { rollbacks: [{ box: { id: "b1", boxId: "bx_1", name: "alpha", hostId: "local" }, rollback: ${JSON.stringify(PENDING)} }] }
          : path.startsWith("/api/checkpoints/usage")
            ? null
            : path.startsWith("/api/checkpoints")
              ? { checkpoints: [] }
              : { boxes: [{ id: "b1", boxId: "bx_1", name: "alpha" }, { id: "b2", boxId: "bx_2", name: "beta" }] };
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      };
      const root = element();
      const dispose = component.mountStorageCheckpoints(root, {});
      ${settle}
      const html = root.innerHTML;
      dispose();
      return {
        paths,
        pending: html.includes('data-action="ck-confirm"') && html.includes("alpha"),
        other: html.split('data-action="ck-confirm"').length - 1,
      };
    `);
    expect(out.paths.filter((path) => path.startsWith("/api/rollbacks"))).toEqual(["/api/rollbacks"]);
    expect(out.paths.filter((path) => path.includes("/boxes/") && path.includes("rollback"))).toEqual([]);
    expect(out.pending).toBe(true);
    // One line, for the one box that waits: the box with no rollback has none.
    expect(out.other).toBe(1);
  });

  test("a rollback read that fails draws the timeline with no pending line and no error", () => {
    const out = inBrowser<{ html: string; failed: boolean }>(`
      globalThis.EventSource = undefined;
      globalThis.fetch = async (path) => {
        if (path.startsWith("/api/rollbacks")) return { ok: false, status: 500, text: async () => JSON.stringify({ error: { code: "internal", message: "boom" } }) };
        const body = path.startsWith("/api/checkpoints/usage")
          ? null
          : path.startsWith("/api/checkpoints")
            ? { checkpoints: [] }
            : { boxes: [{ id: "b1", boxId: "bx_1", name: "alpha" }] };
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      };
      const root = element();
      const dispose = component.mountStorageCheckpoints(root, {});
      ${settle}
      const html = root.innerHTML;
      dispose();
      return { html, failed: html.includes("ck-confirm") };
    `);
    expect(out.failed).toBe(false);
    // The timeline still drew: the failure cost the pending lines, not the page.
    expect(out.html).toContain("sck-head");
  });
});
