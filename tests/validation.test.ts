import { describe, expect, test } from "bun:test";

import { AppError } from "../src/lib/errors";
import {
  optionalBoolean,
  parseCreateBox,
  parseResources,
  validateCpus,
  validateMemoryMb,
  validateName,
  validateTail,
} from "../src/lib/validation";

const defaults = { cpus: 2, memoryMb: 4096 };

function expectValidation(fn: () => unknown, field?: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).status).toBe(400);
    if (field) expect((e as AppError).details).toEqual({ field });
    return;
  }
  throw new Error("expected validation error");
}

describe("validateName", () => {
  test("accepts docker-safe names and trims", () => {
    expect(validateName("dev-1")).toBe("dev-1");
    expect(validateName("  a.b_c ")).toBe("a.b_c");
  });
  test("rejects empty, bad first char, illegal chars, too long", () => {
    for (const bad of ["", "   ", "-x", ".x", "a b", "名字", "a/b", "x".repeat(64), 42, null]) {
      expectValidation(() => validateName(bad), "name");
    }
  });
});

describe("resources", () => {
  test("cpus range and rounding", () => {
    expect(validateCpus(2)).toBe(2);
    expect(validateCpus("1.555")).toBe(1.56);
    expectValidation(() => validateCpus(0), "cpus");
    expectValidation(() => validateCpus(65), "cpus");
    expectValidation(() => validateCpus("abc"), "cpus");
  });
  test("memory must be integer MB within range", () => {
    expect(validateMemoryMb(4096)).toBe(4096);
    expectValidation(() => validateMemoryMb(64), "memoryMb");
    expectValidation(() => validateMemoryMb(1024.5), "memoryMb");
  });
  test("parseResources requires at least one field", () => {
    expect(parseResources({ cpus: 4 })).toEqual({ cpus: 4 });
    expectValidation(() => parseResources({}));
    expectValidation(() => parseResources([]));
  });
});

describe("parseCreateBox", () => {
  test("applies defaults", () => {
    expect(parseCreateBox({ name: "demo" }, defaults)).toEqual({
      name: "demo",
      image: undefined,
      cpus: 2,
      memoryMb: 4096,
    });
  });
  test("validates template ref", () => {
    expect(parseCreateBox({ name: "a", template: "minibox-template:base" }, defaults).image).toBe(
      "minibox-template:base",
    );
    expectValidation(() => parseCreateBox({ name: "a", template: "bad ref" }, defaults), "template");
  });
  test("rejects non-object bodies", () => {
    expectValidation(() => parseCreateBox(null, defaults));
    expectValidation(() => parseCreateBox("x", defaults));
  });
  test("accepts a known security profile and leaves it to the server default otherwise", () => {
    expect(parseCreateBox({ name: "a", profile: "strict" }, defaults).profile).toBe("strict");
    expect(parseCreateBox({ name: "a" }, defaults).profile).toBeUndefined();
    expect(parseCreateBox({ name: "a", profile: "" }, defaults).profile).toBeUndefined();
    expect(parseCreateBox({ name: "a", profile: null }, defaults).profile).toBeUndefined();
  });
  test("rejects unknown security profiles with a translatable key", () => {
    for (const bad of ["privileged", "Strict", 1, true]) {
      expectValidation(() => parseCreateBox({ name: "a", profile: bad }, defaults), "profile");
    }
    try {
      parseCreateBox({ name: "a", profile: "privileged" }, defaults);
    } catch (e) {
      expect((e as AppError).key).toBe("profile_invalid");
      expect((e as AppError).params).toEqual({ profiles: "standard, strict, relaxed" });
    }
  });
});

describe("misc", () => {
  test("validateTail", () => {
    expect(validateTail(null)).toBe(300);
    expect(validateTail("50")).toBe(50);
    expectValidation(() => validateTail("0"), "tail");
    expectValidation(() => validateTail("9999"), "tail");
  });
  test("optionalBoolean", () => {
    expect(optionalBoolean(undefined, "x")).toBe(false);
    expect(optionalBoolean("true", "x")).toBe(true);
    expect(optionalBoolean(false, "x")).toBe(false);
    expectValidation(() => optionalBoolean("yes", "x"), "x");
  });
});
