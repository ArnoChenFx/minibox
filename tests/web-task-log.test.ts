import { describe, expect, test } from "bun:test";

import { capLog, LOG_OMITTED, splitTaskLog } from "../web/js/lib/task-log.js";

describe("splitTaskLog", () => {
  test("a tool install's banner and command are taken apart from its output", () => {
    const log =
      "install codex@latest\n$ npm install -g codex\nUsing tools volume vol_1 (read-write)\nadded 1 package\n";
    expect(splitTaskLog(log)).toEqual({
      commands: [{ banner: "install codex@latest", command: "npm install -g codex" }],
      output: "Using tools volume vol_1 (read-write)\nadded 1 package\n",
    });
  });

  test("consecutive commands each keep the banner that names them", () => {
    const log = "stop x in the box\n$ a\nstopped\ninstall x@1\n$ b\nok\n";
    expect(splitTaskLog(log)).toEqual({
      commands: [
        { banner: "stop x in the box", command: "a" },
        { banner: "install x@1", command: "b" },
      ],
      output: "stopped\nok\n",
    });
  });

  test("a command on the first line has no banner", () => {
    expect(splitTaskLog("$ uname -a\nLinux\n")).toEqual({
      commands: [{ banner: null, command: "uname -a" }],
      output: "Linux\n",
    });
  });

  test("a command right after another command has no banner of its own", () => {
    expect(splitTaskLog("$ a\n$ b\nx")).toEqual({
      commands: [
        { banner: null, command: "a" },
        { banner: null, command: "b" },
      ],
      output: "x",
    });
  });

  test("a blank line above a command means it has no banner", () => {
    expect(splitTaskLog("kept\n\n$ a\nout")).toEqual({
      commands: [{ banner: null, command: "a" }],
      output: "kept\n\nout",
    });
  });

  test("carriage returns at the end of lines are not part of the banner or the command", () => {
    expect(splitTaskLog("install x\r\n$ a\r\nout\r\n")).toEqual({
      commands: [{ banner: "install x", command: "a" }],
      output: "out\r\n",
    });
  });

  test("a log without commands is all output, and a dollar sign inside a line is not a prompt", () => {
    expect(splitTaskLog("cost $5\nplain\n")).toEqual({ commands: [], output: "cost $5\nplain\n" });
    expect(splitTaskLog("… earlier output omitted …\nout\n")).toEqual({
      commands: [],
      output: "… earlier output omitted …\nout\n",
    });
  });

  test("an empty log has no commands and no output", () => {
    expect(splitTaskLog("")).toEqual({ commands: [], output: "" });
  });
});

describe("capLog", () => {
  test("a log within the cap is returned as is", () => {
    expect(capLog("a\nb\n", 10)).toBe("a\nb\n");
  });

  test("a log over the cap keeps whole lines from the end, behind the omitted marker", () => {
    const log = `${"x".repeat(50)}\nkeep 1\nkeep 2\n`;
    expect(capLog(log, 20)).toBe(`${LOG_OMITTED}keep 1\nkeep 2\n`);
  });

  test("a streamed log stays bounded however much is appended", () => {
    let log = "";
    for (let i = 0; i < 5000; i += 1) log = capLog(`${log}line ${i} ${"y".repeat(40)}\n`, 4096);
    expect(log.length).toBeLessThanOrEqual(4096 + LOG_OMITTED.length);
    expect(log.endsWith(`line 4999 ${"y".repeat(40)}\n`)).toBe(true);
  });
});
