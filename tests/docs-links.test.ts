import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SKIPPED_DIRS = new Set([".git", "node_modules", "data", "dist"]);
const REPO_FILE_URL = /https:\/\/github\.com\/ArnoChenFx\/minibox\/(?:blob|tree)\/main\/([^\s"'`<>()[\]#?]+)/g;

function filesUnder(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : filesUnder(path, pattern);
    return pattern.test(entry.name) ? [path] : [];
  });
}

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Lines outside fenced code blocks. Inside a fence, `#` starts a comment and `[x](y)` is not a link. */
function proseLines(markdown: string): string[] {
  const kept: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== undefined) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    } else if (marker) {
      fence = marker;
    } else {
      kept.push(line);
    }
  }
  return kept;
}

function targetsIn(line: string): string[] {
  const code = line.replace(/(`+)[^`]*?\1/g, "");
  const targets = [...code.matchAll(/\]\(\s*<?([^)\s>]+)/g)].map((match) => match[1] ?? "");
  targets.push(...[...code.matchAll(/\s(?:href|src)=["']([^"']*)["']/g)].map((match) => match[1] ?? ""));
  const definition = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)/.exec(code)?.[1];
  if (definition) targets.push(definition);
  return targets;
}

const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-");

/** The anchors GitHub generates for a Markdown file: its headings, plus explicit id and name attributes. */
function anchorsIn(markdown: string): Set<string> {
  const ids = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of proseLines(markdown)) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)?.[1];
    if (heading === undefined) continue;
    const base = slug(heading);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    ids.add(count === 0 ? base : `${base}-${count}`);
  }
  for (const match of markdown.matchAll(/\s(?:id|name)="([^"]+)"/g)) ids.add(match[1] ?? "");
  return ids;
}

const anchorCache = new Map<string, Set<string>>();
function anchorsOf(path: string): Set<string> {
  let ids = anchorCache.get(path);
  if (!ids) {
    ids = anchorsIn(readFileSync(path, "utf8"));
    anchorCache.set(path, ids);
  }
  return ids;
}

function resolveInRepo(file: string, path: string): string | undefined {
  const absolute = path.startsWith("/") ? join(ROOT, path) : resolve(dirname(file), path);
  return absolute === ROOT || absolute.startsWith(ROOT + sep) ? absolute : undefined;
}

function brokenReason(file: string, target: string): string | undefined {
  if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) return undefined;
  const hash = target.indexOf("#");
  const rawPath = hash === -1 ? target : target.slice(0, hash);
  const anchor = hash === -1 ? "" : decode(target.slice(hash + 1));
  const path = rawPath === "" ? file : resolveInRepo(file, decode(rawPath.split("?")[0] ?? ""));
  if (path === undefined) return "points outside the repository";
  if (!existsSync(path)) return "no such file or directory";
  if (anchor && path.endsWith(".md") && !anchorsOf(path).has(anchor)) return "no such heading";
  return undefined;
}

const markdownFiles = filesUnder(ROOT, /\.md$/);

describe("documentation links", () => {
  test("finds the Markdown files in the repository", () => {
    expect(markdownFiles).toContain(join(ROOT, "docs", "README.md"));
    expect(markdownFiles).toContain(join(ROOT, "docs", "user-guide", "boxes.md"));
  });

  test("relative links and anchors in Markdown resolve to files and headings", () => {
    const problems: string[] = [];
    for (const file of markdownFiles) {
      for (const line of proseLines(readFileSync(file, "utf8"))) {
        for (const target of targetsIn(line)) {
          const reason = brokenReason(file, target);
          if (reason) problems.push(`${relative(ROOT, file)}: ${target} (${reason})`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test("GitHub links into this repository point at files that exist", () => {
    const sources = [
      ...markdownFiles,
      ...["web", "src", "site"].flatMap((dir) => filesUnder(join(ROOT, dir), /\.(js|ts|html)$/)),
    ];
    const problems: string[] = [];
    for (const file of sources) {
      for (const match of readFileSync(file, "utf8").matchAll(REPO_FILE_URL)) {
        const path = join(ROOT, decode(match[1] ?? "").replace(/\/$/, ""));
        if (!existsSync(path)) problems.push(`${relative(ROOT, file)}: ${match[0]}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
