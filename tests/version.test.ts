import { describe, expect, test } from "bun:test";

import pkg from "../package.json";
import { normalizeVersion, resolveVersion } from "../src/version";

describe("version", () => {
  test("strips leading v", () => {
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeVersion("1.2.3-rc.1")).toBe("1.2.3-rc.1");
  });
  test("MINIBOX_VERSION env wins", () => {
    expect(resolveVersion({ MINIBOX_VERSION: "v9.8.7" })).toBe("9.8.7");
  });
  test("falls back to git describe or package.json", () => {
    const v = resolveVersion({});
    expect(v.length).toBeGreaterThan(0);
    expect(v.startsWith(pkg.version) || /^\d+\.\d+\.\d+/.test(v)).toBe(true);
  });
});
