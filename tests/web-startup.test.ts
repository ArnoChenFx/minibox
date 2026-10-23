import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { ROOT } from "../src/config";
import { startupCommandProblem, STARTUP_COMMAND_MAX_BYTES } from "../src/startup/command";
import {
  isWatching,
  STARTUP_COMMAND_MAX_BYTES as CLIENT_MAX_BYTES,
  startupProblem,
  startupStatusView,
} from "../web/js/lib/startup.js";

const CARD = join(ROOT, "web", "js", "components", "startup-card.js");

/** The browser globals the card's modules read when they load, with an English navigator. */
const BROWSER = [
  `const stub = { documentElement: {}, body: {}, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), addEventListener() {}, removeEventListener() {} };`,
  `Object.defineProperty(globalThis, "document", { configurable: true, value: stub });`,
  `Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) } });`,
  `Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });`,
  `Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"], language: "en-US" } });`,
  `Object.defineProperty(globalThis, "location", { configurable: true, value: { hash: "", search: "", pathname: "/", origin: "http://localhost" } });`,
];

/** Renders each card model in one fresh process, so the markup comes from the module as the page loads it. */
function cardMarkup(models: Record<string, unknown>[]): string[] {
  const script = [
    ...BROWSER,
    `const { startupCardHtml } = await import(${JSON.stringify(CARD)});`,
    `console.log(JSON.stringify(${JSON.stringify(models)}.map((model) => startupCardHtml(model))));`,
  ].join("\n");
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as string[];
}

const COMMAND = "npm run dev";

function stateOf(extra: Partial<Record<string, unknown>> = {}) {
  return {
    revision: 3,
    command: COMMAND,
    status: "exited",
    exitCode: 0,
    startedAt: "2026-10-22T10:00:00Z",
    exitedAt: "2026-10-22T10:00:05Z",
    stale: false,
    log: ["ready on 3000"],
    error: null,
    ...extra,
  };
}

describe("startup command rules in the browser", () => {
  test("a command is refused for being empty, too long or holding a control character, as the server refuses it", () => {
    expect(startupProblem("")).toBe("empty");
    expect(startupProblem(" \t\n ")).toBe("empty");
    expect(startupProblem("x".repeat(STARTUP_COMMAND_MAX_BYTES))).toBeNull();
    expect(startupProblem("x".repeat(STARTUP_COMMAND_MAX_BYTES + 1))).toBe("too_long");
    expect(startupProblem("中".repeat(1365))).toBeNull();
    expect(startupProblem("中".repeat(1366))).toBe("too_long");
    expect(startupProblem("echo\u0007")).toBe("control");
    expect(startupProblem("echo one\n\techo two\r\n")).toBeNull();
  });

  test("the browser's limit and its checks are the server's, sample for sample", () => {
    expect(CLIENT_MAX_BYTES).toBe(STARTUP_COMMAND_MAX_BYTES);
    const samples = [
      "",
      "  ",
      "npm run dev",
      "echo one\necho two\n",
      "echo \u0000",
      "echo \u009b",
      "x".repeat(STARTUP_COMMAND_MAX_BYTES),
      "x".repeat(STARTUP_COMMAND_MAX_BYTES + 1),
      "中".repeat(1366),
    ];
    const disagreements = samples
      .map((sample) => ({
        sample: sample.slice(0, 12),
        browser: startupProblem(sample),
        server: startupCommandProblem(sample),
      }))
      .filter((pair) => pair.browser !== pair.server);
    expect(disagreements).toEqual([]);
  });

  test("each status has its badge tone and its label, and an exit code names itself", () => {
    expect(startupStatusView({ status: "running" })).toEqual({ tone: "badge-success", key: "sc.status.running" });
    expect(startupStatusView({ status: "cloning" })).toEqual({ tone: "badge-accent", key: "sc.status.cloning" });
    expect(startupStatusView({ status: "waiting" })).toEqual({ tone: "badge-accent", key: "sc.status.waiting" });
    expect(startupStatusView({ status: "failed" })).toEqual({ tone: "badge-danger", key: "sc.status.failed" });
    expect(startupStatusView({ status: "none" })).toEqual({ tone: "", key: "sc.status.none" });
    expect(startupStatusView({ status: "exited", exitCode: 0 })).toEqual({
      tone: "",
      key: "sc.status.exited",
      params: { code: 0 },
    });
    expect(startupStatusView({ status: "exited", exitCode: 3 })).toEqual({
      tone: "badge-danger",
      key: "sc.status.exited",
      params: { code: 3 },
    });
  });

  test("the card polls only while a command is set and its run is going on a running box", () => {
    expect(isWatching({ command: COMMAND, status: "running" }, true)).toBe(true);
    expect(isWatching({ command: COMMAND, status: "running" }, false)).toBe(false);
    expect(isWatching({ command: COMMAND, status: "exited" }, true)).toBe(false);
    expect(isWatching({ command: null, status: "none" }, true)).toBe(false);
  });
});

describe("startup card markup", () => {
  test("the command and its output are escaped, so a command never becomes markup", () => {
    const hostile = `echo '<img src=x onerror="alert(1)">' && cat </pre><script>x</script>`;
    const [html] = cardMarkup([
      {
        state: stateOf({ command: hostile, log: ["<b>bold</b>", "</pre><script>y</script>"] }),
        running: false,
      },
    ]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;/pre&gt;&lt;script&gt;y&lt;/script&gt;");
  });

  test("a running command shows Running, its start time, and a button to run it again", () => {
    const [html] = cardMarkup([
      { state: stateOf({ status: "running", exitCode: null, exitedAt: null }), running: true },
    ]);
    expect(html).toContain("Running");
    expect(html).toContain('<span class="dot"></span>');
    expect(html).toContain('data-startup-action="run"');
    expect(html).toContain("Run again");
    expect(html).toContain('data-startup-action="remove"');
  });

  test("on a stopped box the run button is absent, and the status says the command waits for the next start", () => {
    const [html] = cardMarkup([{ state: stateOf({ status: "waiting", exitCode: null }), running: false }]);
    expect(html).toContain("Waiting for the next start");
    expect(html).not.toContain('data-startup-action="run"');
    expect(html).toContain('data-startup-action="edit"');
  });

  test("an exit with a non-zero code is marked as a failure with its code", () => {
    const [html] = cardMarkup([{ state: stateOf({ status: "exited", exitCode: 2 }), running: true }]);
    expect(html).toContain('<span class="badge badge-danger">Exited with code 2</span>');
  });

  test("a failed launch names its reason, and the output is the empty note when there is none", () => {
    const [html] = cardMarkup([
      {
        state: stateOf({
          status: "failed",
          exitCode: null,
          startedAt: null,
          exitedAt: null,
          log: [],
          error: { key: "startup_command_failed", message: "x", params: { detail: "no tmux" } },
        }),
        running: true,
      },
    ]);
    expect(html).toContain("MiniBox could not run the startup command: no tmux");
    expect(html).toContain("No output yet.");
  });

  test("a stale run says the command changed since it ran", () => {
    const [html] = cardMarkup([{ state: stateOf({ stale: true }), running: false }]);
    expect(html).toContain("earlier version of this command");
  });

  test("with no command the card offers to set one and has nothing to remove", () => {
    const [html] = cardMarkup([{ state: stateOf({ command: null, status: "none", log: [] }), running: true }]);
    expect(html).toContain("No startup command is set.");
    expect(html).toContain("Set command");
    expect(html).not.toContain('data-startup-action="remove"');
    expect(html).not.toContain('data-startup-action="run"');
  });

  test("a token that cannot read the command sees that it needs secret:use, and no action", () => {
    const [html] = cardMarkup([{ forbidden: true, state: null }]);
    expect(html).toContain("needs the secret:use scope");
    expect(html).not.toContain("data-startup-action");
  });

  test("a failed read says so, with the message the server gave", () => {
    const [html] = cardMarkup([{ loadError: "box is gone" }]);
    expect(html).toContain("could not be loaded");
    expect(html).toContain("box is gone");
  });

  test("the editor holds the draft, escaped, with apply now only while the box runs", () => {
    const draft = `echo "a" </textarea><script>alert(1)</script>`;
    const [running, stopped] = cardMarkup([
      { state: stateOf(), running: true, editing: { draft, applyNow: true, error: "" } },
      { state: stateOf(), running: false, editing: { draft, applyNow: false, error: "" } },
    ]);
    expect(running).toContain('<textarea class="textarea command-input" data-startup-input');
    expect(running).not.toContain("</textarea><script>");
    expect(running).toContain("&lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(running).toContain("data-startup-apply checked");
    expect(running).toContain('data-startup-action="save"');
    expect(running).toContain('data-startup-action="cancel"');
    expect(stopped).not.toContain("data-startup-apply");
    expect(stopped).toContain('data-startup-action="save"');
  });

  test("an error in the editor is shown beside the draft", () => {
    const [html] = cardMarkup([
      {
        state: stateOf(),
        running: false,
        editing: { draft: "x", applyNow: false, error: "This box is at revision 4, not 3." },
      },
    ]);
    expect(html).toContain("data-startup-error>This box is at revision 4, not 3.</div>");
  });
});
