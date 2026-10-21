import { describe, expect, test } from "bun:test";

import {
  appendedLines,
  classifyTmuxFailure,
  hexBytes,
  isKeyName,
  isSessionName,
  LIST_SESSIONS_FORMAT,
  PROBE_FORMAT,
  paneLines,
  paneTarget,
  parseProbe,
  parseSessionList,
  sessionTarget,
} from "../src/tmux/format";

describe("session names", () => {
  test("accept short alphanumeric names with dashes and underscores", () => {
    for (const name of ["main", "build-1", "a_b", "X", "s".repeat(32)]) expect(isSessionName(name)).toBe(true);
  });

  test("refuse names tmux would rewrite or that could be read as flags or targets", () => {
    for (const name of ["", "-x", "a:b", "a.b", "a=b", "a b", "a;b", "a/b", "_lead", "s".repeat(33), "é"]) {
      expect(isSessionName(name)).toBe(false);
    }
  });

  test("session and pane targets", () => {
    expect(sessionTarget("main")).toBe("=main");
    expect(paneTarget("main")).toBe("=main:");
  });
});

describe("session list", () => {
  test("parses the format the service asks tmux for", () => {
    expect(LIST_SESSIONS_FORMAT).toBe("#{session_name}\t#{@minibox-origin}\t#{session_created}\t#{session_attached}");
    const stdout = ["build\tagent\t1750000000\t0", "shell\thuman\t1750000100\t1", ""].join("\n");
    expect(parseSessionList(stdout)).toEqual([
      { name: "build", origin: "agent", createdAt: 1_750_000_000_000, attached: 0 },
      { name: "shell", origin: "human", createdAt: 1_750_000_100_000, attached: 1 },
    ]);
  });

  test("a session without the mark is treated as agent-driven", () => {
    expect(parseSessionList("legacy\t\t1750000000\t0")).toEqual([
      { name: "legacy", origin: "agent", createdAt: 1_750_000_000_000, attached: 0 },
    ]);
  });

  test("skips lines whose name is not a valid session name", () => {
    expect(parseSessionList("bad:name\tagent\t1\t0\n\n")).toEqual([]);
  });

  test("an empty server prints nothing", () => {
    expect(parseSessionList("")).toEqual([]);
  });
});

describe("probe", () => {
  test("reads the name and origin of a session in one line", () => {
    expect(PROBE_FORMAT).toContain("#{session_name}\t#{@minibox-origin}");
    expect(parseProbe("work\thuman\n")).toEqual({ name: "work", origin: "human" });
    expect(parseProbe("work\t\n")).toEqual({ name: "work", origin: "agent" });
  });

  test("an empty answer means the session is not there, whatever tmux's exit status says", () => {
    expect(parseProbe("\n")).toBeNull();
    expect(parseProbe("")).toBeNull();
  });
});

describe("pane lines", () => {
  test("drops the final newline and trailing blank rows, keeps blank rows in the middle", () => {
    expect(paneLines("one\r\n\ntwo\n\n\n")).toEqual(["one", "", "two"]);
  });

  test("an empty pane has no lines", () => {
    expect(paneLines("\n\n")).toEqual([]);
    expect(paneLines("")).toEqual([]);
  });
});

describe("hexBytes", () => {
  test("encodes UTF-8 bytes as two-digit lowercase hex", () => {
    expect(hexBytes("a\n")).toEqual(["61", "0a"]);
    expect(hexBytes("é")).toEqual(["c3", "a9"]);
  });

  test("round-trips arbitrary text", () => {
    const text = "echo 'hi' && ls -la; 中文 🙂";
    const bytes = Buffer.from(hexBytes(text).map((hex) => Number.parseInt(hex, 16)));
    expect(bytes.toString("utf8")).toBe(text);
  });
});

describe("key names", () => {
  test("accept named keys, modifiers, and single characters", () => {
    for (const key of [
      "Enter",
      "Tab",
      "BTab",
      "Escape",
      "BSpace",
      "PPage",
      "F1",
      "F12",
      "Up",
      "C-c",
      "M-x",
      "C-M-a",
      "a",
      "7",
      "/",
      "&",
    ]) {
      expect(isKeyName(key)).toBe(true);
    }
  });

  test("refuse separators, flags, unknown names, and too many modifiers", () => {
    for (const key of ["-", ";", "-x", "C-", "F13", "enter", "C-S-M-a", "ab", "", "\n", "$"]) {
      expect(isKeyName(key)).toBe(false);
    }
  });
});

describe("classifyTmuxFailure", () => {
  test("maps a missing binary, a missing server, a missing target, and a duplicate", () => {
    expect(classifyTmuxFailure(127, "")).toBe("missing");
    expect(classifyTmuxFailure(1, "no server running on /tmp/tmux-1000/default")).toBe("no_server");
    expect(classifyTmuxFailure(1, "error connecting to /tmp/tmux-1000/default (No such file or directory)")).toBe(
      "no_server",
    );
    expect(classifyTmuxFailure(1, "can't find session: =build")).toBe("not_found");
    expect(classifyTmuxFailure(1, "can't find pane: =build:")).toBe("not_found");
    expect(classifyTmuxFailure(1, "duplicate session: build")).toBe("duplicate");
  });

  test("anything else is a plain failure", () => {
    expect(classifyTmuxFailure(1, "unknown key: Foo")).toBe("failed");
  });
});

describe("appendedLines", () => {
  test("returns what was appended after the previous snapshot", () => {
    expect(appendedLines(["$ ls", "a"], ["$ ls", "a", "b", "$ "])).toEqual(["b", "$ "]);
  });

  test("nothing new when the snapshot is unchanged", () => {
    expect(appendedLines(["a", "b"], ["a", "b"])).toEqual([]);
  });

  test("skips lines that scrolled out of history", () => {
    expect(appendedLines(["x", "x", "x", "y"], ["x", "x", "y", "z"])).toEqual(["z"]);
  });

  test("everything is new when nothing was read before", () => {
    expect(appendedLines([], ["a", "b"])).toEqual(["a", "b"]);
  });

  test("no overlap means the screen was redrawn, so the caller resets", () => {
    expect(appendedLines(["a", "b"], ["c", "d"])).toBeUndefined();
    expect(appendedLines(["a", "b"], [])).toBeUndefined();
  });

  test("a shorter snapshot that is a prefix of the old one resets", () => {
    expect(appendedLines(["a", "b"], ["a"])).toBeUndefined();
  });

  test("the prompt line grows when a command is typed, and that line is returned in full", () => {
    expect(appendedLines(["$ "], ["$ echo one", "one", "$ "])).toEqual(["$ echo one", "one", "$ "]);
    expect(appendedLines(["$ echo one", "one", "$ "], ["$ echo one", "one", "$ echo two", "two", "$ "])).toEqual([
      "$ echo two",
      "two",
      "$ ",
    ]);
  });

  test("a last line that grew is returned in full, and the lines before it are not", () => {
    expect(appendedLines(["a", "$ "], ["a", "$ ec"])).toEqual(["$ ec"]);
    expect(appendedLines(["a", "$ "], ["a", "$ "])).toEqual([]);
  });
});
