import { describe, expect, test } from "bun:test";

import { containerName, labelKeys, parseBoxLabels, parseImageLabels, stripSlash, volumeName } from "../src/labels";

const keys = labelKeys("minibox");

describe("labels", () => {
  test("keys derive from prefix", () => {
    expect(keys.box).toBe("minibox");
    expect(labelKeys("mb").snapshotOf).toBe("mb.snapshot.of");
  });

  test("parseBoxLabels", () => {
    expect(
      parseBoxLabels(
        {
          minibox: "true",
          "minibox.name": "demo",
          "minibox.template": "img:1",
          "minibox.created": "2026-01-01",
          "minibox.profile": "strict",
        },
        keys,
      ),
    ).toEqual({ isBox: true, name: "demo", template: "img:1", created: "2026-01-01", profile: "strict" });
    expect(parseBoxLabels(undefined, keys)).toEqual({
      isBox: false,
      name: null,
      template: "",
      created: null,
      profile: null,
    });
    expect(parseBoxLabels({ minibox: "false" }, keys).isBox).toBe(false);
  });

  test("boxes created before profiles existed have no profile", () => {
    expect(parseBoxLabels({ minibox: "true", "minibox.profile": "loud" }, keys).profile).toBeNull();
    expect(parseBoxLabels({ minibox: "true" }, keys).profile).toBeNull();
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
});
