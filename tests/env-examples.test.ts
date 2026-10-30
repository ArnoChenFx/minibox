import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ASSIGNMENT = /^#? ?[A-Z][A-Z0-9_]*=/;

/**
 * The settings of an example file in order, with the blank lines that separate its groups. A setting is a line such as
 * `PORT=3920` or `# BOX_PROFILE=standard`. The prose around them is what differs between the two languages.
 */
function settingsOf(file: string): string[] {
  return readFileSync(join(ROOT, file), "utf8")
    .trimEnd()
    .split("\n")
    .filter((line) => line === "" || ASSIGNMENT.test(line));
}

describe("the example configuration files", () => {
  test("the Chinese file sets what the English file sets, with the same defaults and in the same groups", () => {
    const english = settingsOf(".env.example");
    expect(english.filter((line) => line !== "").length).toBeGreaterThan(40);
    expect(settingsOf(".env.zh.example")).toEqual(english);
  });

  test("the Chinese file is written in Chinese", () => {
    const comments = readFileSync(join(ROOT, ".env.zh.example"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("#") && !ASSIGNMENT.test(line));
    expect(comments.length).toBeGreaterThan(40);
    const missing = comments.filter((line) => !/\p{Script=Han}/u.test(line));
    // A line that continues the sentence above may be only a path, a number or a URL; most lines carry Chinese.
    expect(missing.length).toBeLessThan(comments.length / 4);
  });
});
