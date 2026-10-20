import { describe, expect, test } from "bun:test";

import {
  boxNetworkName,
  containerName,
  labelKeys,
  parseBoxLabels,
  parseImageLabels,
  stripSlash,
  volumeName,
} from "../src/labels";

const keys = labelKeys("minibox");

describe("labels", () => {
  test("keys derive from prefix", () => {
    expect(keys.box).toBe("minibox");
    expect(labelKeys("mb").snapshotOf).toBe("mb.snapshot.of");
    expect(labelKeys("mb").profile).toBe("mb.profile");
  });

  test("parseBoxLabels", () => {
    expect(
      parseBoxLabels(
        { minibox: "true", "minibox.name": "demo", "minibox.template": "img:1", "minibox.created": "2026-01-01" },
        keys,
      ),
    ).toEqual({ isBox: true, name: "demo", template: "img:1", created: "2026-01-01", profile: null });
    expect(parseBoxLabels(undefined, keys)).toEqual({
      isBox: false,
      name: null,
      template: "",
      created: null,
      profile: null,
    });
    expect(parseBoxLabels({ minibox: "false" }, keys).isBox).toBe(false);
  });

  test("parseBoxLabels reads the profile a box was created with", () => {
    expect(parseBoxLabels({ minibox: "true", "minibox.profile": "strict" }, keys).profile).toBe("strict");
    expect(parseBoxLabels({ minibox: "true", "minibox.profile": "paranoid" }, keys).profile).toBeNull();
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
    expect(boxNetworkName("minibox")).toBe("minibox-boxes");
    expect(boxNetworkName("mb")).toBe("mb-boxes");
    expect(stripSlash("/minibox-a")).toBe("minibox-a");
  });
});
