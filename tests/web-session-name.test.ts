import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";
import {
  DEFAULT_SESSION_NAME,
  nextSessionName,
  SESSION_NAME_MAX,
  SESSION_NAME_RE,
  sessionNameProblem,
} from "../web/js/lib/session-name.js";

/** The rule the server validates a session name with, read from its own source so the two cannot drift apart. */
const SERVER_SOURCE = readFileSync(join(ROOT, "src", "tmux", "format.ts"), "utf8");
const SERVER_RE = /export const SESSION_NAME_RE = (\/.*\/);/.exec(SERVER_SOURCE)?.[1];

describe("the new-session dialog's markup and wiring", () => {
  const PANEL = readFileSync(join(ROOT, "web", "js", "components", "terminal-panel.js"), "utf8");
  const UI = readFileSync(join(ROOT, "web", "js", "lib", "ui.js"), "utf8");

  test("the New session dialog opens with a name in the field, from the sessions the box has", () => {
    // `value` is what puts a name in the field; `placeholder` only draws a grey hint that cannot be submitted.
    expect(PANEL).toContain("value: nextSessionName(taken())");
    expect(PANEL).toContain("const taken = () => sessions.map((s) => s.name);");
    expect(PANEL).not.toContain("placeholder: DEFAULT_NAME");
    // The name and the checks come from the module, not from a rule copied into the component.
    expect(PANEL).toContain('from "../lib/session-name.js"');
    expect(PANEL).toContain("const problem = sessionNameProblem(value, taken());");
    expect(PANEL).not.toContain("NAME_RE");
  });

  test("the dialog checks the field as it opens and as it is typed, and Enter submits without pressing another button", () => {
    // The opening value is checked, so a suggestion that is already taken is flagged before the button is pressed.
    expect(UI).toContain('if (value.trim()) show(validate?.(value.trim()) ?? "");');
    // Every keystroke re-checks the field.
    expect(UI).toContain('input.addEventListener("input", () => show(validate?.(input.value.trim()) ?? ""));');
    // Enter does not also activate the button the dialog hands the focus back to, which would reopen the dialog.
    expect(UI).toMatch(
      /if \(e\.key !== "Enter"\) return;\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*e\.preventDefault\(\);\n\s*submit\(\);/,
    );
    // A refused value is drawn under the field, in the dialog's own error line, and marked on the input.
    expect(UI).toContain('input.classList.toggle("invalid", Boolean(problem));');
    expect(UI).toContain("err.textContent = problem;");
    expect(UI).toContain('id="pd-err" role="alert"');
  });

  test("a server error still comes back as the readable toast the panel already shows", () => {
    expect(PANEL).toContain('toast(t("bd.sessionStartFailed"), { type: "error", message: withHint(e) });');
  });

  test("the strings the dialog shows are in the dictionary, in both languages", () => {
    for (const key of [
      "bd.newSessionText",
      "bd.sessionNameHelp",
      "bd.sessionNameInvalid",
      "bd.sessionNameRequired",
      "bd.sessionNameTaken",
    ]) {
      expect([key, typeof en[key], typeof zh[key]]).toEqual([key, "string", "string"]);
    }
  });
});

describe("the name a new session starts with", () => {
  test("a box with no sessions offers console, the name its first session already has", () => {
    expect(DEFAULT_SESSION_NAME).toBe("console");
    expect(nextSessionName([])).toBe("console");
    expect(nextSessionName([])).toBe("console");
  });

  test("a box whose console exists offers console-2, then console-3, and never the same name twice", () => {
    expect(nextSessionName(["console"])).toBe("console-2");
    expect(nextSessionName(["console", "console-2"])).toBe("console-3");
    // A session closed in the meantime leaves a hole, and the next name still has to be free.
    expect(nextSessionName(["console", "console-2", "console-4"])).toBe("console-3");
    // Two openings in a row, the second seeing what the first created, get two different names.
    const first = nextSessionName(["console"]);
    expect(nextSessionName(["console", first])).not.toBe(first);
  });

  test("names an agent started count too, since tmux holds them all in one list", () => {
    expect(nextSessionName(["build", "minibox-init"])).toBe("console");
    expect(nextSessionName(["minibox-init", "console", "build"])).toBe("console-2");
  });

  test("a name taken in another case is taken, so Console and console are not offered as two sessions", () => {
    expect(nextSessionName(["Console"])).toBe("console-2");
    expect(nextSessionName(["CONSOLE", "console-2"])).toBe("console-3");
  });

  test("the name stays inside the 32 characters the server takes, at console-99 and with a long base", () => {
    const many = ["console", ...Array.from({ length: 98 }, (_, i) => `console-${i + 2}`)];
    const last = nextSessionName(many);
    expect(last).toBe("console-100");
    expect(last.length).toBeLessThanOrEqual(SESSION_NAME_MAX);

    const long = "a".repeat(SESSION_NAME_MAX);
    const offered = nextSessionName([long], long);
    expect(offered).toBe(`${"a".repeat(SESSION_NAME_MAX - 2)}-2`);
    expect(offered.length).toBe(SESSION_NAME_MAX);
    expect(SESSION_NAME_RE.test(offered)).toBe(true);
    // Even a base that fills the limit and a series that reaches three digits keeps the suffix.
    const filled = [long, `${"a".repeat(SESSION_NAME_MAX - 2)}-2`, `${"a".repeat(SESSION_NAME_MAX - 3)}-3`];
    const next = nextSessionName(filled, long);
    expect(next.length).toBeLessThanOrEqual(SESSION_NAME_MAX);
    expect(next).toBe(`${"a".repeat(SESSION_NAME_MAX - 2)}-3`);
    expect(SESSION_NAME_RE.test(next)).toBe(true);
  });

  test("a base that is not a name falls back to console, so a caller cannot ask for a name the server refuses", () => {
    expect(nextSessionName([], "")).toBe("console");
    expect(nextSessionName([], "bad name!")).toBe("console");
    expect(nextSessionName(["console"], "-dash")).toBe("console-2");
  });

  test("the console name is never changed by the suggestion, so a box's first session keeps it", () => {
    // The suggestion only skips names; it does not rename anything the box already holds.
    expect(nextSessionName(["console"])).not.toBe("console");
    expect(nextSessionName(["console-2"])).toBe("console");
  });
});

describe("what the dialog says about a typed name", () => {
  const taken = ["console", "console-2"];

  test("the name the dialog opened with is accepted as it is", () => {
    expect(sessionNameProblem(nextSessionName(taken), taken)).toBe("");
  });

  test("a name already in the box is refused, before the request is sent", () => {
    expect(sessionNameProblem("console", taken)).toBe("bd.sessionNameTaken");
    expect(sessionNameProblem("console-2", taken)).toBe("bd.sessionNameTaken");
    expect(sessionNameProblem("Console", taken)).toBe("bd.sessionNameTaken");
    expect(sessionNameProblem("build", taken)).toBe("");
  });

  test("a name the server would refuse is refused here, with the same rule", () => {
    expect(sessionNameProblem("")).toBe("bd.sessionNameRequired");
    expect(sessionNameProblem("   ")).toBe("bd.sessionNameRequired");
    expect(sessionNameProblem("bad name")).toBe("bd.sessionNameInvalid");
    expect(sessionNameProblem("-lead")).toBe("bd.sessionNameInvalid");
    expect(sessionNameProblem("a".repeat(SESSION_NAME_MAX + 1))).toBe("bd.sessionNameInvalid");
    expect(sessionNameProblem("a".repeat(SESSION_NAME_MAX))).toBe("");
    expect(sessionNameProblem("dots.are.not.allowed")).toBe("bd.sessionNameInvalid");
  });

  test("the name is trimmed, as the dialog trims it, so trailing spaces are not a name of their own", () => {
    expect(sessionNameProblem(" build ")).toBe("");
    expect(sessionNameProblem(" console ", taken)).toBe("bd.sessionNameTaken");
  });

  test("the rule here is the server's rule, character for character", () => {
    expect(SERVER_RE).toBeDefined();
    expect(SESSION_NAME_RE.source).toBe(SERVER_RE!.slice(1, SERVER_RE!.lastIndexOf("/")));
    expect(SESSION_NAME_RE.flags).toBe(SERVER_RE!.slice(SERVER_RE!.lastIndexOf("/") + 1));
    expect(SESSION_NAME_MAX).toBe(32);
  });

  test("every problem the dialog can show has its own text in both languages", () => {
    const keys = new Set(
      ["", "  ", "bad name", "a".repeat(33), "console"]
        .map((value) => sessionNameProblem(value, taken))
        .filter(Boolean),
    );
    expect([...keys].toSorted()).toEqual(["bd.sessionNameInvalid", "bd.sessionNameRequired", "bd.sessionNameTaken"]);
    for (const key of keys) {
      expect([key, typeof en[key], typeof zh[key]]).toEqual([key, "string", "string"]);
      expect([key, zh[key] !== en[key]]).toEqual([key, true]);
    }
    // The taken message names the session the reader typed, in both languages.
    expect(en["bd.sessionNameTaken"]).toContain("{name}");
    expect(zh["bd.sessionNameTaken"]).toContain("{name}");
  });
});
