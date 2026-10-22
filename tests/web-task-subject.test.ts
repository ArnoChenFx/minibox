import { describe, expect, test } from "bun:test";

import { subjectOf } from "../web/js/lib/task-subject.js";

describe("subjectOf", () => {
  test("the subject the server recorded wins", () => {
    expect(subjectOf({ op: "tool.install", subject: "codex", result: { id: "claude-code" } })).toBe("codex");
    expect(subjectOf({ op: "snapshot.create", subject: "before-upgrade" })).toBe("before-upgrade");
  });

  test("a tool task from before the subject was recorded names its tool from the result", () => {
    expect(subjectOf({ op: "tool.install", result: { id: "rust", version: "latest" } })).toBe("rust");
    expect(subjectOf({ op: "tool.upgrade", result: { id: "codex" } })).toBe("codex");
  });

  test("a failed tool task names its tool from the error's parameters", () => {
    expect(subjectOf({ op: "tool.install", error: { params: { id: "codex" } } })).toBe("codex");
  });

  test("other operations get no fallback, so their box or target names them instead", () => {
    expect(subjectOf({ op: "snapshot.create", result: { snapshot: { ref: "minibox-snap:nightly" } } })).toBe("");
    expect(subjectOf({ op: "tool.reconcile", result: { id: "box-id" } })).toBe("");
    expect(subjectOf({ op: "template.build", error: { params: { id: "x" } } })).toBe("");
  });

  test("a tool task with nothing to name it has an empty subject", () => {
    expect(subjectOf({ op: "tool.uninstall", result: null, error: null })).toBe("");
  });
});
