import { describe, expect, test } from "bun:test";

import {
  boxLabel,
  inPreviewNamespace,
  parsePreviewBaseDomain,
  parsePreviewHost,
  previewHostname,
  previewLaunchPath,
} from "../src/preview/domain";

const BASE = "minibox-preview.net";

describe("PREVIEW_BASE_DOMAIN", () => {
  test("blank means path mode", () => {
    expect(parsePreviewBaseDomain(undefined)).toBeNull();
    expect(parsePreviewBaseDomain("   ")).toBeNull();
  });

  test("a domain of two or more labels is kept in lower case", () => {
    expect(parsePreviewBaseDomain(" Minibox-Preview.NET ")).toBe(BASE);
    expect(parsePreviewBaseDomain("preview.localhost")).toBe("preview.localhost");
  });

  test.each([
    ["a single label", "localhost"],
    ["an address", "192.168.1.10"],
    ["a scheme", "https://minibox-preview.net"],
    ["a port", "minibox-preview.net:8443"],
    ["a path", "minibox-preview.net/box"],
    ["a leading hyphen", "-bad.net"],
    ["a trailing hyphen", "bad-.net"],
    ["an underscore", "under_score.net"],
    ["an empty label", "a..net"],
    ["a numeric top label", "minibox-preview.123"],
    ["more than 180 characters", `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.net`],
  ])("%s is refused at startup", (_, value) => {
    expect(() => parsePreviewBaseDomain(value)).toThrow("PREVIEW_BASE_DOMAIN");
  });
});

describe("box labels", () => {
  test("a DNS-safe box name is the label", () => {
    expect(boxLabel("demo", "bx_abc12345")).toBe("demo");
    expect(boxLabel("a".repeat(57), "bx_abc12345")).toBe("a".repeat(57));
  });

  test("a name that is not a DNS label falls back to the stable id, with a hyphen", () => {
    expect(boxLabel("My Box", "bx_abc12345")).toBe("bx-abc12345");
    expect(boxLabel("UPPER", "bx_abc12345")).toBe("bx-abc12345");
    expect(boxLabel("-lead", "bx_abc12345")).toBe("bx-abc12345");
    expect(boxLabel("a".repeat(58), "bx_abc12345")).toBe("bx-abc12345");
  });
});

describe("preview hostnames", () => {
  test("are <port>-<label>.<base>", () => {
    expect(previewHostname(5173, "demo", BASE)).toBe(`5173-demo.${BASE}`);
  });

  test("parse back to their port and label", () => {
    expect(parsePreviewHost(`5173-demo.${BASE}`, BASE)).toEqual({ port: 5173, label: "demo" });
    expect(parsePreviewHost(`65535-bx-abc12345.${BASE}`, BASE)).toEqual({ port: 65535, label: "bx-abc12345" });
  });

  test("are recognised only under the base domain", () => {
    expect(inPreviewNamespace(`5173-demo.${BASE}`, BASE)).toBe(true);
    expect(inPreviewNamespace(BASE, BASE)).toBe(false);
    expect(inPreviewNamespace("xminibox-preview.net", BASE)).toBe(false);
    expect(inPreviewNamespace(`5173-demo.${BASE}.evil.com`, BASE)).toBe(false);
  });

  test.each([
    ["the base domain itself", BASE],
    ["another domain", `5173-demo.other.net`],
    ["no port", `demo.${BASE}`],
    ["port 0", `0-demo.${BASE}`],
    ["a port above 65535", `65536-demo.${BASE}`],
    ["a port with a leading zero", `05173-demo.${BASE}`],
    ["an extra label before the box", `5173-demo.x.${BASE}`],
    ["an empty label", `5173-.${BASE}`],
    ["an uppercase label", `5173-Demo.${BASE}`],
    ["a suffix that is not a subdomain", `5173-demo.${BASE}.evil.com`],
  ])("%s is not a preview host", (_, hostname) => {
    expect(parsePreviewHost(hostname, BASE)).toBeNull();
  });

  test("the launch path names the box by its stable id", () => {
    expect(previewLaunchPath("bx_abc12345", 5173)).toBe("/api/boxes/bx_abc12345/ports/5173/preview");
  });
});
