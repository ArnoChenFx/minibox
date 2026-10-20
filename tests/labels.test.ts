import { describe, expect, test } from "bun:test";

import {
  containerName,
  labelChange,
  labelKeys,
  parseBoxLabels,
  parseImageLabels,
  quoteLabelValue,
  stripSlash,
  volumeName,
} from "../src/labels";

const keys = labelKeys("minibox");

describe("labels", () => {
  test("keys derive from prefix", () => {
    expect(keys.box).toBe("minibox");
    expect(labelKeys("mb").snapshotOf).toBe("mb.snapshot.of");
  });

  test("parseBoxLabels", () => {
    expect(
      parseBoxLabels(
        { minibox: "true", "minibox.name": "demo", "minibox.template": "img:1", "minibox.created": "2026-01-01" },
        keys,
      ),
    ).toEqual({ isBox: true, name: "demo", template: "img:1", created: "2026-01-01" });
    expect(parseBoxLabels(undefined, keys)).toEqual({ isBox: false, name: null, template: "", created: null });
    expect(parseBoxLabels({ minibox: "false" }, keys).isBox).toBe(false);
  });

  test("parseImageLabels", () => {
    const l = parseImageLabels({ "minibox.snapshot": "true", "minibox.snapshot.of": "demo" }, keys);
    expect(l.isSnapshot).toBe(true);
    expect(l.isTemplate).toBe(false);
    expect(l.snapshotOf).toBe("demo");
  });

  test("names", () => {
    expect(containerName("minibox", "a")).toBe("minibox-a");
    expect(volumeName("minibox", "a")).toBe("minibox-ws-a");
    expect(stripSlash("/minibox-a")).toBe("minibox-a");
  });

  test("label values are double-quoted, with backslash, quote and dollar escaped", () => {
    expect(quoteLabelValue('say "hi" C:\\tmp $HOME')).toBe('"say \\"hi\\" C:\\\\tmp \\$HOME"');
    expect(labelChange("minibox.template", "true")).toBe('LABEL minibox.template="true"');
  });

  test("label values with control characters are refused, so they cannot start a new instruction", () => {
    for (const bad of ["a\nENV X=1", 'a\nCMD ["sh"]', "a\rb", "a\tb", "a\u0000b", "a\u007fb"]) {
      expect(() => labelChange("minibox.template.description", bad)).toThrow("control characters");
    }
  });
});
