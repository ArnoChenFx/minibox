import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { ROOT } from "../src/config";

const WEB = join(ROOT, "web");
const VENDOR = join(WEB, "vendor");
const PAGES = ["index.html", "login.html"];
const TEXT_FILE = /\.(html|js|css)$/;

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile());
}

describe("vendored front-end libraries", () => {
  const manifest = readFileSync(join(VENDOR, "SHA256SUMS"), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [hash = "", file = ""] = line.trim().split(/\s+/);
      return { hash, file };
    });

  test("SHA256SUMS lists the vendored files", () => {
    expect(manifest.length).toBeGreaterThan(0);
  });

  test("each file matches the hash recorded in SHA256SUMS", () => {
    for (const { hash, file } of manifest) {
      expect({ file, hash: sha256(join(VENDOR, file)) }).toEqual({ file, hash });
    }
  });

  test("no vendored file is missing from SHA256SUMS", () => {
    const listed = new Set(manifest.map((entry) => entry.file));
    const unlisted = filesUnder(VENDOR)
      .map((path) => relative(VENDOR, path).split(sep).join("/"))
      .filter((file) => file !== "SHA256SUMS" && file !== "README.md" && !listed.has(file));
    expect(unlisted).toEqual([]);
  });
});

describe("console pages", () => {
  test("pages have no inline scripts or event handlers, as script-src 'self' requires", () => {
    for (const page of PAGES) {
      const html = readFileSync(join(WEB, page), "utf8");
      for (const [, attributes = ""] of html.matchAll(/<script\b([^>]*)>/gi)) {
        expect({ page, attributes: /\ssrc=/.test(attributes) }).toEqual({ page, attributes: true });
      }
      expect({ page, handlers: html.match(/\son[a-z]+\s*=/gi) ?? [] }).toEqual({ page, handlers: [] });
    }
  });

  test("pages load every resource from MiniBox itself", () => {
    for (const page of PAGES) {
      const html = readFileSync(join(WEB, page), "utf8");
      const external = [...html.matchAll(/\s(?:src|href)="([^"]*)"/g)]
        .map((m) => m[1] ?? "")
        .filter((value) => !value.startsWith("/") && !value.startsWith("#") && !value.startsWith("data:"));
      expect({ page, external }).toEqual({ page, external: [] });
    }
  });

  test("no web UI file refers to a CDN", () => {
    const offenders = filesUnder(WEB)
      .filter((path) => !path.startsWith(VENDOR) && TEXT_FILE.test(path))
      .filter((path) => /jsdelivr|unpkg|cdnjs|googleapis/i.test(readFileSync(path, "utf8")))
      .map((path) => relative(WEB, path));
    expect(offenders).toEqual([]);
  });
});
