import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { ROOT } from "../src/config";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";
import {
  PREVIEW_MAX_BYTES,
  absolutePath,
  baseOf,
  childrenOf,
  clashesOf,
  contentUrl,
  crumbsOf,
  deleteUrl,
  downloadUrl,
  joinPath,
  listUrl,
  mkdirUrl,
  moveUrl,
  nameProblem,
  parentOf,
  pickRoot,
  previewable,
  rootsOf,
  sortEntries,
  uploadUrl,
  visibleEntries,
} from "../web/js/lib/files.js";

const WEB = join(ROOT, "web");
const COMPONENT = join(WEB, "js", "components", "files.js");
const TRANSFER = join(WEB, "js", "lib", "file-transfer.js");

const stubs = [
  `const stub = { documentElement: {}, body: {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };`,
  `Object.defineProperty(globalThis, "document", { configurable: true, value: stub });`,
  `Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) } });`,
  `Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });`,
  `Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"], language: "en-US" } });`,
  `Object.defineProperty(globalThis, "location", { configurable: true, value: { hash: "", search: "", pathname: "/", origin: "http://localhost", href: "http://localhost/" } });`,
];

/** Runs a browser module in a fresh process with the globals it reads at import, and returns what the script prints. */
function inBrowser(script: string): unknown {
  const source = [...stubs, script].join("\n");
  const run = spawnSync(process.execPath, ["-e", source], { encoding: "utf8", timeout: 20_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as unknown;
}

const STAMP = "2026-10-01T08:00:00Z";
const file = (path: string, size: number | null = 10) => ({ path, type: "file" as const, size, mtime: STAMP });
const folder = (path: string) => ({ path, type: "dir" as const, size: null, mtime: STAMP });
const named = <T extends { path: string }>(entry: T) => ({ ...entry, name: baseOf(entry.path) });
const mount = (path: string, volumeId: string | null, role: string | null) => ({
  path,
  volume: volumeId ?? "gone",
  volumeId,
  volumeName: volumeId ? `${role ?? "custom"}-volume` : null,
  role,
  mode: "rw",
  pool: "default",
});
const row = (entry: Record<string, unknown>) =>
  inBrowser(
    `const { rowHtml } = await import(${JSON.stringify(COMPONENT)});` +
      `console.log(JSON.stringify(rowHtml(${JSON.stringify(entry)}, "vol_1")));`,
  ) as string;
const send = (script: string) =>
  inBrowser(
    `const { sendFile } = await import(${JSON.stringify(TRANSFER)});` +
      `class Xhr {
        constructor() { this.handlers = {}; this.headers = {}; this.upload = { addEventListener: (type, fn) => { this.handlers["upload:" + type] = fn; } }; globalThis.lastXhr = this; }
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader(name, value) { this.headers[name] = value; }
        addEventListener(type, fn) { this.handlers[type] = fn; }
        send(body) { this.body = body; }
        abort() { this.handlers.abort?.(); }
      }
      globalThis.XMLHttpRequest = Xhr;
      const file = { name: "a.bin", size: 4 };
      const progress = [];
      const sender = sendFile("/api/volumes/vol_1/files/stream?path=a.bin", file, { onProgress: (n) => progress.push(n) });
      const xhr = globalThis.lastXhr;
      ${script}`,
  );

describe("paths", () => {
  test("joinPath, parentOf and baseOf work on volume-relative paths", () => {
    expect(joinPath("", "a.txt")).toBe("a.txt");
    expect(joinPath("src", "a.txt")).toBe("src/a.txt");
    expect(parentOf("src/lib/a.txt")).toBe("src/lib");
    expect(parentOf("a.txt")).toBe("");
    expect(baseOf("src/lib/a.txt")).toBe("a.txt");
  });

  test("crumbsOf gives each folder on the way to the current one, with its own path", () => {
    expect(crumbsOf("")).toEqual([]);
    expect(crumbsOf("a/b/c")).toEqual([
      { name: "a", path: "a" },
      { name: "b", path: "a/b" },
      { name: "c", path: "a/b/c" },
    ]);
  });
});

describe("absolute paths", () => {
  test("a path in a volume becomes the path the box sees, under the volume's mount path", () => {
    expect(absolutePath("/workspace", "src/main.ts")).toBe("/workspace/src/main.ts");
    expect(absolutePath("/home/dev", "notes/todo.md")).toBe("/home/dev/notes/todo.md");
  });

  test("the root of a volume is its mount path, and a mount at / is not doubled", () => {
    expect(absolutePath("/workspace", "")).toBe("/workspace");
    expect(absolutePath("/opt/minibox/tools", "")).toBe("/opt/minibox/tools");
    expect(absolutePath("/", "")).toBe("/");
    expect(absolutePath("/", "etc/hosts")).toBe("/etc/hosts");
  });

  test("a mount path with a trailing slash still gives one separator", () => {
    expect(absolutePath("/data/", "a.txt")).toBe("/data/a.txt");
    expect(absolutePath("/data/", "")).toBe("/data");
  });
});

describe("listings", () => {
  test("childrenOf takes the folder's direct children from a one-level listing, and drops the folder itself", () => {
    const listing = [
      { path: "/", type: "dir" as const, size: null, mtime: STAMP },
      folder("src"),
      file("README.md", 120),
      file("src/main.ts", 900),
      folder("src/lib"),
    ];
    expect(childrenOf(listing, "").map((entry) => entry.name)).toEqual(["src", "README.md"]);
    expect(childrenOf(listing, "src").map((entry) => entry.name)).toEqual(["main.ts", "lib"]);
    expect(childrenOf(listing, "src/lib")).toEqual([]);
  });

  test("hidden names are left out unless asked for, and the filter is trimmed and ignores case", () => {
    const children = [".env", "App.tsx", "app.test.ts", "notes.md"].map((name) => ({
      ...file(name),
      name,
    }));
    expect(visibleEntries(children).map((entry) => entry.name)).toEqual(["App.tsx", "app.test.ts", "notes.md"]);
    expect(visibleEntries(children, { showHidden: true })).toHaveLength(4);
    expect(visibleEntries(children, { query: "  APP " }).map((entry) => entry.name)).toEqual([
      "App.tsx",
      "app.test.ts",
    ]);
    expect(visibleEntries(children, { query: ".ENV", showHidden: false })).toEqual([]);
    expect(visibleEntries(children, { query: ".ENV", showHidden: true }).map((entry) => entry.name)).toEqual([".env"]);
  });

  test("folders come first whatever the key, names sort numerically, and each key orders its own column", () => {
    const entries = [
      file("file10.txt", 5),
      folder("zeta"),
      file("File2.txt", 50),
      file("file1.txt", 500),
      folder("alpha"),
    ].map(named);
    expect(sortEntries(entries).map((entry) => entry.name)).toEqual([
      "alpha",
      "zeta",
      "file1.txt",
      "File2.txt",
      "file10.txt",
    ]);
    expect(sortEntries(entries, { descending: true }).map((entry) => entry.name)).toEqual([
      "zeta",
      "alpha",
      "file10.txt",
      "File2.txt",
      "file1.txt",
    ]);
    expect(sortEntries(entries, { key: "size" }).map((entry) => entry.name)).toEqual([
      "alpha",
      "zeta",
      "file10.txt",
      "File2.txt",
      "file1.txt",
    ]);
    const dated = [
      { ...file("old.txt"), mtime: "2025-01-01T00:00:00Z", name: "old.txt" },
      { ...file("new.txt"), mtime: "2026-06-01T00:00:00Z", name: "new.txt" },
    ];
    expect(sortEntries(dated, { key: "modified", descending: true }).map((entry) => entry.name)).toEqual([
      "new.txt",
      "old.txt",
    ]);
  });

  test("the sort does not change the list it was given", () => {
    const entries = [named(file("b.txt")), named(file("a.txt"))];
    sortEntries(entries);
    expect(entries.map((entry) => entry.name)).toEqual(["b.txt", "a.txt"]);
  });

  test("a file is previewable only when it is a regular file no larger than the preview limit", () => {
    expect(previewable(file("small.txt", 10))).toBe(true);
    expect(previewable(file("edge.txt", PREVIEW_MAX_BYTES))).toBe(true);
    expect(previewable(file("big.txt", PREVIEW_MAX_BYTES + 1))).toBe(false);
    expect(previewable(folder("dir"))).toBe(false);
    expect(previewable({ path: "link", type: "symlink", size: 0, mtime: null })).toBe(false);
    expect(previewable(file("unknown.txt", null))).toBe(false);
  });
});

describe("roots", () => {
  test("rootsOf keeps the mounts that hold a volume, with only the fields the page uses", () => {
    expect(rootsOf([mount("/workspace", "vol_1", "workspace"), mount("/gone", null, null)])).toEqual([
      { path: "/workspace", volumeId: "vol_1", volumeName: "workspace-volume", role: "workspace", mode: "rw" },
    ]);
  });

  test("pickRoot keeps the path asked for, else the workspace, else the first root, else nothing", () => {
    const roots = rootsOf([mount("/home/dev", "vol_2", "home"), mount("/workspace", "vol_1", "workspace")]);
    expect(pickRoot(roots, null)?.path).toBe("/workspace");
    expect(pickRoot(roots, "/home/dev")?.path).toBe("/home/dev");
    expect(pickRoot(roots, "/gone")?.path).toBe("/workspace");
    expect(pickRoot(rootsOf([mount("/data", "vol_3", null)]), null)?.path).toBe("/data");
    expect(pickRoot([], null)).toBeNull();
  });
});

describe("names", () => {
  test("nameProblem accepts ordinary names, including dotfiles and names of exactly 255 bytes", () => {
    expect(nameProblem("notes.md")).toBe("");
    expect(nameProblem(".gitignore")).toBe("");
    expect(nameProblem("报告 v2")).toBe("");
    expect(nameProblem("x".repeat(255))).toBe("");
    expect(nameProblem("é".repeat(127))).toBe("");
  });

  test("nameProblem names each reason a name cannot be used", () => {
    expect(nameProblem("")).toBe("fl.nameRequired");
    expect(nameProblem(".")).toBe("fl.nameReserved");
    expect(nameProblem("..")).toBe("fl.nameReserved");
    expect(nameProblem("a/b")).toBe("fl.nameCharacters");
    expect(nameProblem("tab\there")).toBe("fl.nameCharacters");
    expect(nameProblem("del\u007f")).toBe("fl.nameCharacters");
    expect(nameProblem("x".repeat(256))).toBe("fl.nameLong");
    expect(nameProblem("é".repeat(128))).toBe("fl.nameLong");
  });

  test("every key nameProblem can return has a translation in both languages", () => {
    const samples = ["", ".", "..", "a/b", "a\u0001", "x".repeat(256)];
    const keys = new Set(samples.map(nameProblem).filter(Boolean));
    expect([...keys].toSorted()).toEqual(["fl.nameCharacters", "fl.nameLong", "fl.nameRequired", "fl.nameReserved"]);
    for (const key of keys) {
      expect([key, typeof en[key], typeof zh[key]]).toEqual([key, "string", "string"]);
    }
  });

  test("clashesOf finds the planned uploads whose name is already in their folder", () => {
    const plans = [
      { path: "a/x.txt", n: 1 },
      { path: "a/y.txt", n: 2 },
      { path: "b/x.txt", n: 3 },
      { path: "top.txt", n: 4 },
    ];
    const namesIn = new Map([
      ["a", new Set(["x.txt"])],
      ["", new Set(["top.txt"])],
    ]);
    expect(clashesOf(plans, namesIn).map((plan) => plan.n)).toEqual([1, 4]);
    expect(clashesOf(plans, new Map())).toEqual([]);
  });
});

describe("request urls", () => {
  test("the listing names the root by leaving the path out, and asks one level deep", () => {
    expect(listUrl("vol_1", "")).toBe("/api/volumes/vol_1/files?maxDepth=1&limit=2000");
    expect(listUrl("vol_1", "a b/&c")).toBe("/api/volumes/vol_1/files?path=a%20b%2F%26c&maxDepth=1&limit=2000");
  });

  test("every path is percent-encoded and the volume id is encoded too", () => {
    expect(contentUrl("vol_1", "notes/a #1.txt")).toBe(
      "/api/volumes/vol_1/files/content?path=notes%2Fa%20%231.txt&encoding=utf-8",
    );
    expect(downloadUrl("a/b", "dir/x")).toBe("/api/volumes/a%2Fb/files/stream?path=dir%2Fx");
    expect(mkdirUrl("vol_1")).toBe("/api/volumes/vol_1/files/directory");
    expect(moveUrl("vol_1")).toBe("/api/volumes/vol_1/files/move");
  });

  test("an upload says whether it may replace, and a delete asks for confirmation only when told to", () => {
    expect(uploadUrl("vol_1", "f.txt", true)).toBe("/api/volumes/vol_1/files/stream?path=f.txt&overwrite=true");
    expect(uploadUrl("vol_1", "f.txt", false)).toBe("/api/volumes/vol_1/files/stream?path=f.txt&overwrite=false");
    expect(deleteUrl("vol_1", "f.txt")).toBe("/api/volumes/vol_1/files?path=f.txt");
    expect(deleteUrl("vol_1", "f.txt", true)).toBe("/api/volumes/vol_1/files?path=f.txt&confirm=true");
  });
});

describe("the rows of a listing", () => {
  test("a folder opens on a click, downloads as a .tar.gz, and has no preview", () => {
    const html = row(named(folder("docs")));
    expect(html).toContain('data-fb="open" data-path="docs"');
    expect(html).toContain('href="/api/volumes/vol_1/files/stream?path=docs"');
    expect(html).toContain('title="Download as .tar.gz"');
    expect(html).not.toContain('data-fb="preview"');
  });

  test("a small text file previews, while a file over the preview limit only downloads", () => {
    const small = row(named(file("docs/a.md", 42)));
    expect(small).toContain('data-fb="preview" data-path="docs/a.md"');
    const large = row(named(file("docs/big.bin", PREVIEW_MAX_BYTES + 1)));
    expect(large).not.toContain('data-fb="preview"');
    expect(large).toContain('<span class="fb-name">');
    expect(large).toContain('title="Download"');
  });

  test("every row copies the path the box sees, which is the mount path plus the path inside the volume", () => {
    const html = row(named(file("src/main.ts", 12)));
    expect(html).toContain('data-fb="copy-path" data-path="src/main.ts"');
    expect(html).toContain('title="Copy path"');
    expect(html).toContain('aria-label="Copy path"');
    // The button is its icon alone, so it keeps the row's width for the name.
    expect(html).not.toContain(">Copy path<");
  });

  test("a symbolic link is shown as a link, is not followed, and cannot be downloaded", () => {
    const html = row(named({ path: "docs/latest", type: "symlink", size: null, mtime: null }));
    expect(html).toContain('title="Symbolic link. Its target is not followed here."');
    expect(html).not.toContain("/files/stream?");
  });

  test("names and paths are escaped, and every row can be renamed or deleted", () => {
    const html = row(named(file('docs/<img src=x onerror="1">.txt', 3)));
    expect(html).toContain("&lt;img src=x onerror=&quot;1&quot;&gt;.txt");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain('data-fb="rename"');
    expect(html).toContain('data-fb="delete"');
  });
});

describe("the upload transport", () => {
  test("the body is sent as one octet stream, and progress reports the bytes that left", () => {
    const out = send(`
        xhr.handlers["upload:progress"]({ loaded: 2 });
        xhr.handlers["upload:progress"]({ loaded: 4 });
        xhr.status = 201;
        xhr.responseText = JSON.stringify({ path: "a.bin", bytesWritten: 4 });
        xhr.handlers.load();
        const reply = await sender.done;
        console.log(JSON.stringify({ method: xhr.method, url: xhr.url, headers: xhr.headers, sentFile: xhr.body === file, progress, reply }));
      `) as Record<string, unknown>;
    expect(out).toEqual({
      method: "PUT",
      url: "/api/volumes/vol_1/files/stream?path=a.bin",
      headers: { "content-type": "application/octet-stream" },
      sentFile: true,
      progress: [2, 4],
      reply: { path: "a.bin", bytesWritten: 4 },
    });
  });

  test("a refused upload rejects with the server's code, details and translated message", () => {
    const out = send(`
        xhr.status = 413;
        xhr.responseText = JSON.stringify({ error: { code: "payload_too_large", message: "too big", key: "file_upload_too_large", params: { limit: 5 }, details: { max: 5 } } });
        xhr.handlers.load();
        sender.done.catch((err) => console.log(JSON.stringify({ name: err.constructor.name, status: err.status, code: err.code, message: err.message, details: err.details })));
      `) as Record<string, unknown>;
    expect(out).toEqual({
      name: "ApiError",
      status: 413,
      code: "payload_too_large",
      message: en["err.file_upload_too_large"]?.replace("{limit}", "5"),
      details: { max: 5 },
    });
  });

  test("abort rejects with an AbortError, and a lost connection rejects with a network error", () => {
    const aborted = send(`
        sender.done.catch((err) => console.log(JSON.stringify({ name: err.name, message: err.message })));
        sender.abort();
      `) as Record<string, unknown>;
    expect(aborted).toEqual({ name: "AbortError", message: en["fl.uploadCancelled"] });
    const lost = send(`
        sender.done.catch((err) => console.log(JSON.stringify({ name: err.constructor.name, status: err.status, code: err.code })));
        xhr.handlers.error();
      `) as Record<string, unknown>;
    expect(lost).toEqual({ name: "ApiError", status: 0, code: "network" });
  });
});

describe("the files component", () => {
  test("the component module loads in a browser without touching the page", () => {
    const loaded = inBrowser(
      `const mod = await import(${JSON.stringify(COMPONENT)});` +
        `console.log(JSON.stringify({ exports: Object.keys(mod).toSorted() }));`,
    ) as { exports: string[] };
    expect(loaded.exports).toEqual(["listingHtml", "mountFiles", "rowHtml"]);
  });
});
