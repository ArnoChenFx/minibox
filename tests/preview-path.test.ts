import { describe, expect, test } from "bun:test";

import { rewriteLocation } from "../src/preview/headers";
import { isPreviewPath, parsePreviewPath, previewUrl } from "../src/preview/path";

describe("preview path routing", () => {
  test("recognizes the /box prefix", () => {
    expect(isPreviewPath("/box")).toBe(true);
    expect(isPreviewPath("/box/demo/3000/")).toBe(true);
    expect(isPreviewPath("/api/boxes")).toBe(false);
  });

  test("parses name, port and forward path", () => {
    expect(parsePreviewPath("/box/demo/5173/")).toEqual({
      ref: "demo",
      port: 5173,
      forwardPath: "/",
      prefix: "/box/demo/5173",
    });
    expect(parsePreviewPath("/box/demo/5173/@vite/client", "?t=1")).toEqual({
      ref: "demo",
      port: 5173,
      forwardPath: "/@vite/client?t=1",
      prefix: "/box/demo/5173",
    });
    expect(parsePreviewPath("/box/bx_01HABCDEFGHJKLMNPQRSTVWXYZ0/3000")).toMatchObject({
      ref: "bx_01HABCDEFGHJKLMNPQRSTVWXYZ0",
      port: 3000,
      forwardPath: "/",
    });
  });

  test("rejects missing or out-of-range ports", () => {
    expect(parsePreviewPath("/box/demo")).toBeNull();
    expect(parsePreviewPath("/box/demo/0/")).toBeNull();
    expect(parsePreviewPath("/box/demo/65536/")).toBeNull();
    expect(parsePreviewPath("/box//3000/")).toBeNull();
  });

  test("builds preview URLs", () => {
    expect(previewUrl("demo", 3000)).toBe("/box/demo/3000/");
    expect(previewUrl("demo", 3000, "/app")).toBe("/box/demo/3000/app");
  });

  test("rewrites relative and loopback Location headers under the prefix", () => {
    expect(rewriteLocation("/login", "/box/demo/3000")).toBe("/box/demo/3000/login");
    expect(rewriteLocation("http://127.0.0.1:3000/app", "/box/demo/3000")).toBe("/box/demo/3000/app");
    expect(rewriteLocation("https://example.com/x", "/box/demo/3000")).toBe("https://example.com/x");
  });
});
