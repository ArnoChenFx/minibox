import { describe, expect, test } from "bun:test";

import {
  boxNetworkName,
  containerName,
  labelChange,
  labelKeys,
  parseBoxLabels,
  parseImageLabels,
  quoteLabelValue,
  stripSlash,
  templateOwnerOf,
  volumeName,
} from "../src/labels";

const keys = labelKeys("minibox");

/** Template labels that name an owner. An id that is undefined leaves its label out. */
const ownerLabels = (uid: string | undefined, gid: string | undefined): Record<string, string> => ({
  ...(uid === undefined ? {} : { "minibox.template.uid": uid }),
  ...(gid === undefined ? {} : { "minibox.template.gid": gid }),
});

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

  test("label values are double-quoted, with backslash, quote and dollar escaped", () => {
    expect(quoteLabelValue('say "hi" C:\\tmp $HOME')).toBe('"say \\"hi\\" C:\\\\tmp \\$HOME"');
    expect(labelChange("minibox.template", "true")).toBe('LABEL minibox.template="true"');
  });

  test("label values with control characters are refused, so they cannot start a new instruction", () => {
    for (const bad of ["a\nENV X=1", 'a\nCMD ["sh"]', "a\rb", "a\tb", "a\u0000b", "a\u007fb"]) {
      expect(() => labelChange("minibox.template.description", bad)).toThrow("control characters");
    }
  });

  test("templateOwnerOf reads the owner the template's uid and gid labels name", () => {
    expect(templateOwnerOf(ownerLabels("1000", "1000"))).toEqual({ uid: 1000, gid: 1000 });
    expect(templateOwnerOf(ownerLabels("0", "0"))).toEqual({ uid: 0, gid: 0 });
    expect(templateOwnerOf(ownerLabels("4294967294", "7"))).toEqual({ uid: 4294967294, gid: 7 });
  });

  test("templateOwnerOf names no owner unless both labels are decimal ids in range", () => {
    expect(templateOwnerOf(ownerLabels("1000", undefined))).toBeNull();
    expect(templateOwnerOf(ownerLabels(undefined, "1000"))).toBeNull();
    expect(templateOwnerOf(ownerLabels("dev", "1000"))).toBeNull();
    expect(templateOwnerOf(ownerLabels(" 1000", "1000"))).toBeNull();
    expect(templateOwnerOf(ownerLabels("-1", "1000"))).toBeNull();
    expect(templateOwnerOf(ownerLabels("1000", "4294967295"))).toBeNull();
    expect(templateOwnerOf(ownerLabels("99999999999999999999", "1000"))).toBeNull();
    expect(templateOwnerOf({})).toBeNull();
    expect(templateOwnerOf(undefined)).toBeNull();
    expect(templateOwnerOf(null)).toBeNull();
  });

  test("templateOwnerOf reads only the fixed minibox.template labels, whatever the prefix", () => {
    expect(templateOwnerOf({ "mb.template.uid": "1000", "mb.template.gid": "1000" })).toBeNull();
  });
});
