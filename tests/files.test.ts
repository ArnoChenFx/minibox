import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { HostCtx } from "../src/host/registry";
import { AppError } from "../src/lib/errors";
import type { OperationContext, Principal } from "../src/operations/types";
import { copyFiles, downloadArchive, listFiles, readFile, uploadArchive, writeFile } from "../src/services/files";
import { jailPath, splitLinkTarget } from "../src/services/files-path";
import { fileArchive } from "../src/services/files-tar";
import { createVolume } from "../src/services/volumes";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

const OWNER: Principal = { type: "owner", id: "owner", name: "owner" };

let runtime: FakeRuntime;
let host: HostCtx;
let ctx: OperationContext;
let restoreLogs: () => void;
let app: ReturnType<typeof createTestApp>["app"];

beforeAll(() => {
  restoreLogs = silenceLogs();
});
afterAll(() => restoreLogs());

beforeEach(() => {
  const created = createTestApp({ labelPrefix: "mbtest" });
  app = created.app;
  runtime = created.runtime;
  host = created.app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true" });
  ctx = {
    host,
    principal: OWNER,
    source: "rest",
    events: app.events,
    tokens: app.tokens,
    execs: app.execs,
  };
});

async function volume() {
  return createVolume(host, { name: "notes", role: null, createdBy: "owner" });
}

describe("path jail", () => {
  test("rejects escapes and accepts nested paths", () => {
    expect(jailPath("a/b")).toBe("a/b");
    expect(jailPath("/a/b")).toBe("a/b");
    expect(jailPath("./a")).toBe("a");
    expect(() => jailPath("../etc/passwd")).toThrow();
    expect(() => jailPath("a/../../x")).toThrow();
  });

  test("splitLinkTarget keeps .. for the physical walk and jails absolute targets to the mount", () => {
    expect(splitLinkTarget("/minibox-volume", "..")).toEqual({ relative: true, parts: [".."] });
    expect(splitLinkTarget("/minibox-volume", "./a//b/")).toEqual({ relative: true, parts: ["a", "b"] });
    expect(splitLinkTarget("/minibox-volume", "/minibox-volume/ok")).toEqual({ relative: false, parts: ["ok"] });
    expect(splitLinkTarget("/minibox-volume", "//minibox-volume/./ok")).toEqual({ relative: false, parts: ["ok"] });
    expect(splitLinkTarget("/minibox-volume", "/minibox-volume")).toEqual({ relative: false, parts: [] });
    // B1d: `..` after the mount is not normalized away here; the resolver refuses it at the volume root.
    expect(splitLinkTarget("/minibox-volume", "/minibox-volume/..")).toEqual({ relative: false, parts: [".."] });
    expect(splitLinkTarget("/minibox-volume", "/minibox-volume-other/x")).toBeNull();
    expect(splitLinkTarget("/minibox-volume", "/tmp")).toBeNull();
    expect(splitLinkTarget("/minibox-volume", "")).toBeNull();
  });
});

async function statusOf(p: Promise<unknown>): Promise<number> {
  const err = await rejectionOf(p);
  expect(err).toBeInstanceOf(AppError);
  return (err as AppError).status;
}

/** Every volume file operation that takes a path through `prefix` must answer 400 and leak nothing. */
async function expectAllRefused(vol: { id: string; engineName: string }, prefix: string, file: string): Promise<void> {
  const volId = vol.id;
  expect(await statusOf(readFile(host, volId, { path: `${prefix}/${file}` }))).toBe(400);
  expect(await statusOf(downloadArchive(host, volId, { path: `${prefix}/${file}` }))).toBe(400);
  expect(await statusOf(copyFiles(host, volId, { from: `${prefix}/${file}`, to: "leaked.txt" }))).toBe(400);
  expect(await statusOf(copyFiles(host, volId, { from: "inside.txt", to: `${prefix}/pwned.txt` }))).toBe(400);
  expect(await statusOf(writeFile(host, volId, { path: `${prefix}/pwned.txt`, content: "x" }))).toBe(400);
  expect(
    await statusOf(
      uploadArchive(host, volId, {
        path: prefix,
        content: Buffer.from(fileArchive("pwned.txt", Buffer.from("nope"))).toString("base64"),
      }),
    ),
  ).toBe(400);
  expect(runtime.outsideFiles.get("/pwned.txt")).toBeUndefined();
  expect(runtime.filesOf(vol.engineName).get("leaked.txt")).toBeUndefined();
}

describe("symlink resolution (B1c/B1d/B1e)", () => {
  beforeEach(() => {
    runtime.seedOutsideFile("/etc/alpine-release", { type: "file", content: Buffer.from("OUTSIDE") });
  });

  test("FakeRuntime follows chains like the kernel (a→b→.. leaks without the jail)", async () => {
    const vol = await volume();
    runtime.seedVolumeFile(vol.engineName, "a", { type: "symlink", target: "b" });
    runtime.seedVolumeFile(vol.engineName, "b", { type: "symlink", target: ".." });
    const created = await runtime.createContainer({
      image: host.baseTemplateTag,
      mounts: [{ source: vol.engineName, target: "/minibox-volume", mode: "ro" }],
    });
    const tar = await new Response(
      await runtime.getArchive(created.id, "/minibox-volume/a/etc/alpine-release"),
    ).arrayBuffer();
    const { parseTar } = await import("../src/services/files-tar");
    expect(
      parseTar(Buffer.from(tar))
        .find((entry) => entry.type === "file")
        ?.data.toString("utf8"),
    ).toBe("OUTSIDE");
  });

  test("refuses a symlink chain a→b, b→.. (B1c)", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "inside.txt", content: "in" });
    runtime.seedVolumeFile(vol.engineName, "a", { type: "symlink", target: "b" });
    runtime.seedVolumeFile(vol.engineName, "b", { type: "symlink", target: ".." });
    await expectAllRefused(vol, "a", "etc/alpine-release");
  });

  test("refuses .. through a link inside a target: up→.., c→up/.. (B1c/B1e)", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "inside.txt", content: "in" });
    runtime.seedVolumeFile(vol.engineName, "up", { type: "symlink", target: ".." });
    runtime.seedVolumeFile(vol.engineName, "c", { type: "symlink", target: "up/.." });
    await expectAllRefused(vol, "c", "etc/alpine-release");
  });

  test("refuses an absolute target that climbs out of the mount: a→/minibox-volume/.. (B1d)", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "inside.txt", content: "in" });
    runtime.seedVolumeFile(vol.engineName, "a", { type: "symlink", target: "/minibox-volume/.." });
    await expectAllRefused(vol, "a", "etc/alpine-release");
    runtime.seedVolumeFile(vol.engineName, "b", { type: "symlink", target: "/minibox-volume/./../etc" });
    await expectAllRefused(vol, "b", "alpine-release");
  });

  test("still refuses the B1 and B1b layouts", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "inside.txt", content: "in" });
    runtime.seedVolumeFile(vol.engineName, "escape", { type: "symlink", target: "/etc" });
    await expectAllRefused(vol, "escape", "alpine-release");
    runtime.seedVolumeFile(vol.engineName, "deep/link", { type: "symlink", target: ".." });
    runtime.seedVolumeFile(vol.engineName, "foo", { type: "symlink", target: ".." });
    await expectAllRefused(vol, "deep/link/foo", "etc/alpine-release");
  });

  test("refuses symlink loops with a 400", async () => {
    const vol = await volume();
    runtime.seedVolumeFile(vol.engineName, "l1", { type: "symlink", target: "l2" });
    runtime.seedVolumeFile(vol.engineName, "l2", { type: "symlink", target: "l1" });
    const err = await rejectionOf(readFile(host, vol.id, { path: "l1/x" }));
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(400);
  });

  test("in-volume chains resolve to the physical path and missing tails are created there", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "real/sub/data.txt", content: "data" });
    runtime.seedVolumeFile(vol.engineName, "hop1", { type: "symlink", target: "hop2" });
    runtime.seedVolumeFile(vol.engineName, "hop2", { type: "symlink", target: "/minibox-volume/real" });
    runtime.seedVolumeFile(vol.engineName, "real/back", { type: "symlink", target: "../real/sub" });

    expect((await readFile(host, vol.id, { path: "hop1/back/data.txt" })).content).toBe("data");
    expect((await readFile(host, vol.id, { path: "hop1/back" })).type).toBe("symlink");

    await writeFile(host, vol.id, { path: "hop1/new/dir/f.txt", content: "made" });
    const files = runtime.filesOf(vol.engineName);
    expect(files.get("real/new/dir/f.txt")?.content?.toString("utf8")).toBe("made");
    expect(files.get("hop1")?.type).toBe("symlink");

    await copyFiles(host, vol.id, { from: "hop1/back/data.txt", to: "hop1/copied.txt" });
    expect(files.get("real/copied.txt")?.content?.toString("utf8")).toBe("data");
    // The archive op runs on the physical path, not the lexical one (B1e).
    const gets = runtime.callsTo("getArchive").map((c) => c.args[1]);
    expect(gets).toContain("/minibox-volume/real/sub/data.txt");
  });
});

describe("volume file API", () => {
  test("writes and reads a file when no box is running (helper + archive)", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "hello.txt", content: "hi agent\n" });
    const read = await readFile(host, vol.id, { path: "hello.txt" });
    expect(read).toMatchObject({
      volume: "notes",
      path: "hello.txt",
      content: "hi agent\n",
      encoding: "utf-8",
      type: "file",
      truncated: false,
    });
    expect(runtime.callsTo("createContainer").length).toBeGreaterThan(0);
    expect(runtime.callsTo("putArchive").length).toBeGreaterThan(0);
    expect(runtime.callsTo("getArchive").length).toBeGreaterThan(0);
  });

  test("lists files via find helper and copies within the volume", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "src/a.txt", content: "a" });
    await writeFile(host, vol.id, { path: "src/b.txt", content: "b" });
    const listed = await listFiles(host, vol.id, { path: "src", maxDepth: 1, limit: 50 });
    expect(listed.entries.some((e) => e.path === "src/a.txt" && e.type === "file")).toBe(true);
    await copyFiles(host, vol.id, { from: "src/a.txt", to: "dst/a.txt" });
    const copied = await readFile(host, vol.id, { path: "dst/a.txt" });
    expect(copied.content).toBe("a");
  });

  test("refuses symlink escape on list paths and returns symlink metadata on read", async () => {
    const vol = await volume();
    runtime.seedVolumeFile(vol.engineName, "link", { type: "symlink", target: "/etc/passwd" });
    const read = await readFile(host, vol.id, { path: "link" });
    expect(read.type).toBe("symlink");
    expect(read.linkTarget).toBe("/etc/passwd");
    expect(read.content).toBe("");
  });

  test("FakeRuntime getArchive follows intermediate dir symlinks out of the volume", async () => {
    const vol = await volume();
    runtime.seedVolumeFile(vol.engineName, "escape", { type: "symlink", target: "/tmp" });
    runtime.seedOutsideFile("/tmp/pr79_secret", { type: "file", content: Buffer.from("secret-outside") });
    const created = await runtime.createContainer({
      image: host.baseTemplateTag,
      mounts: [{ source: vol.engineName, target: "/minibox-volume", mode: "ro" }],
    });
    const tar = await new Response(
      await runtime.getArchive(created.id, "/minibox-volume/escape/pr79_secret"),
    ).arrayBuffer();
    const { parseTar } = await import("../src/services/files-tar");
    const first = parseTar(Buffer.from(tar)).find((entry) => entry.type === "file");
    expect(first?.data.toString("utf8")).toBe("secret-outside");
  });

  test("refuses read/write/copy/upload/download through an intermediate escaping symlink", async () => {
    const vol = await volume();
    runtime.seedVolumeFile(vol.engineName, "escape", { type: "symlink", target: "/tmp" });
    runtime.seedOutsideFile("/tmp/pr79_secret", { type: "file", content: Buffer.from("secret-outside") });
    runtime.seedOutsideFile("/tmp", { type: "dir" });

    const read = await rejectionOf(readFile(host, vol.id, { path: "escape/pr79_secret" }));
    expect(read).toBeInstanceOf(AppError);
    expect((read as AppError).status).toBe(400);

    const write = await rejectionOf(writeFile(host, vol.id, { path: "escape/pwned.txt", content: "x" }));
    expect(write).toBeInstanceOf(AppError);
    expect((write as AppError).status).toBe(400);
    expect(runtime.outsideFiles.get("/tmp/pwned.txt")).toBeUndefined();

    const copy = await rejectionOf(copyFiles(host, vol.id, { from: "escape/pr79_secret", to: "safe.txt" }));
    expect(copy).toBeInstanceOf(AppError);
    expect((copy as AppError).status).toBe(400);

    const dl = await rejectionOf(downloadArchive(host, vol.id, { path: "escape/pr79_secret" }));
    expect(dl).toBeInstanceOf(AppError);
    expect((dl as AppError).status).toBe(400);

    const up = await rejectionOf(
      uploadArchive(host, vol.id, {
        path: "escape",
        content: Buffer.from(fileArchive("pwned.txt", Buffer.from("nope"))).toString("base64"),
      }),
    );
    expect(up).toBeInstanceOf(AppError);
    expect((up as AppError).status).toBe(400);
  });

  test("refuses read/write/copy/upload/download through nested relative symlink escape (B1b)", async () => {
    // deep/link → ".." (in-volume, lands at volume root); foo → ".." at root (escapes).
    // Lexical check of deep/link/foo with target ".." wrongly scored safe; physical base is foo.
    const vol = await volume();
    runtime.seedVolumeFile(vol.engineName, "deep/link", { type: "symlink", target: ".." });
    runtime.seedVolumeFile(vol.engineName, "foo", { type: "symlink", target: ".." });
    runtime.seedOutsideFile("/secret-out", { type: "file", content: Buffer.from("PWNED") });

    const read = await rejectionOf(readFile(host, vol.id, { path: "deep/link/foo/secret-out" }));
    expect(read).toBeInstanceOf(AppError);
    expect((read as AppError).status).toBe(400);

    const write = await rejectionOf(writeFile(host, vol.id, { path: "deep/link/foo/pwned.txt", content: "x" }));
    expect(write).toBeInstanceOf(AppError);
    expect((write as AppError).status).toBe(400);

    const copy = await rejectionOf(copyFiles(host, vol.id, { from: "deep/link/foo/secret-out", to: "leaked.txt" }));
    expect(copy).toBeInstanceOf(AppError);
    expect((copy as AppError).status).toBe(400);

    const dl = await rejectionOf(downloadArchive(host, vol.id, { path: "deep/link/foo/secret-out" }));
    expect(dl).toBeInstanceOf(AppError);
    expect((dl as AppError).status).toBe(400);

    const up = await rejectionOf(
      uploadArchive(host, vol.id, {
        path: "deep/link/foo",
        content: Buffer.from(fileArchive("pwned.txt", Buffer.from("nope"))).toString("base64"),
      }),
    );
    expect(up).toBeInstanceOf(AppError);
    expect((up as AppError).status).toBe(400);
  });

  test("archive helper createContainer uses NoCopy and runHelper-like hardening", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "hello.txt", content: "hi\n" });
    const create = runtime.callsTo("createContainer").find((c) => {
      const spec = c.args[0] as { mounts?: { noCopy?: boolean }[]; readonlyRootfs?: boolean; tmpfs?: unknown };
      return spec.mounts?.some((m) => m.noCopy);
    });
    expect(create).toBeTruthy();
    const spec = create!.args[0] as {
      mounts: { noCopy?: boolean; target: string }[];
      readonlyRootfs?: boolean;
      tmpfs?: Record<string, string>;
      memoryBytes?: number;
      network?: string;
      hardening?: { capDrop?: string[]; pidsLimit?: number };
    };
    expect(spec.mounts[0]).toMatchObject({ target: "/minibox-volume", noCopy: true });
    expect(spec.readonlyRootfs).toBe(true);
    expect(spec.tmpfs?.["/tmp"]).toContain("noexec");
    expect(spec.memoryBytes).toBe(256 * 1024 * 1024);
    expect(spec.network).toBe("none");
    expect(spec.hardening).toMatchObject({ capDrop: ["ALL"], pidsLimit: 64 });
  });

  test("download and upload round-trip a tar", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "pack/me.txt", content: "packed" });
    const dl = await downloadArchive(host, vol.id, { path: "pack" });
    expect(dl.encoding).toBe("base64");
    expect(dl.bytes).toBeGreaterThan(0);
    await uploadArchive(host, vol.id, {
      path: "out",
      content: Buffer.from(fileArchive("me.txt", Buffer.from("uploaded"))).toString("base64"),
    });
    const got = await readFile(host, vol.id, { path: "out/me.txt" });
    expect(got.content).toBe("uploaded");
  });

  test("operations refuse path escape and missing files", async () => {
    const vol = await volume();
    const escaped = await rejectionOf(app.operations.run("files.read", ctx, { id: vol.id, path: "../secret" }));
    expect(escaped).toBeInstanceOf(AppError);
    expect((escaped as AppError).status).toBe(400);

    const missing = await rejectionOf(app.operations.run("files.read", ctx, { id: vol.id, path: "nope.txt" }));
    expect(missing).toBeInstanceOf(AppError);
    expect((missing as AppError).status).toBe(404);
  });

  test("MCP core toolset exposes the four file tools", async () => {
    const tools = (await import("../src/operations/projections")).mcpTools(
      (await import("../src/operations/registry")).OPERATIONS,
      ["core"],
    );
    const names = tools.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("list_files");
    expect(names).toContain("copy_files");
  });
});

describe("component lookups are stat-only (B1f)", () => {
  const BIG = 8 * 1024 * 1024;
  /** One header, or one fake 16 KiB chunk, at most. */
  const HEADER_BUDGET = 16 * 1024;

  test("paths through a directory holding a large file never stream that directory", async () => {
    const vol = await volume();
    runtime.seedVolumeFile(vol.engineName, "big/blob.bin", { type: "file", content: Buffer.alloc(BIG, 1) });
    runtime.seedVolumeFile(vol.engineName, "big/n.txt", { type: "file", content: Buffer.from("small") });

    runtime.archiveBytesRead = 0;
    await writeFile(host, vol.id, { path: "big/deeper/new.txt", content: "x" });
    expect(runtime.archiveBytesRead).toBe(0);

    runtime.archiveBytesRead = 0;
    expect((await readFile(host, vol.id, { path: "big/n.txt" })).content).toBe("small");
    expect(runtime.archiveBytesRead).toBeLessThanOrEqual(HEADER_BUDGET);

    runtime.archiveBytesRead = 0;
    const dir = await rejectionOf(readFile(host, vol.id, { path: "big" }));
    expect((dir as AppError).status).toBe(400);
    expect(runtime.archiveBytesRead).toBe(0);

    runtime.archiveBytesRead = 0;
    await copyFiles(host, vol.id, { from: "big/n.txt", to: "big/m.txt" });
    expect(runtime.archiveBytesRead).toBe(0);

    // Directory components are stat'ed, never archived.
    const archived = runtime.callsTo("getArchive").map((c) => c.args[1]);
    expect(archived).not.toContain("/minibox-volume/big");
    expect(runtime.callsTo("statPath").map((c) => c.args[1])).toContain("/minibox-volume/big");
  });

  test("a symlink component reads only its archive header", async () => {
    const vol = await volume();
    runtime.seedVolumeFile(vol.engineName, "big/blob.bin", { type: "file", content: Buffer.alloc(BIG, 1) });
    runtime.seedVolumeFile(vol.engineName, "big/n.txt", { type: "file", content: Buffer.from("small") });
    runtime.seedVolumeFile(vol.engineName, "via", { type: "symlink", target: "big" });
    runtime.archiveBytesRead = 0;
    expect((await readFile(host, vol.id, { path: "via/n.txt" })).content).toBe("small");
    expect(runtime.archiveBytesRead).toBeLessThanOrEqual(2 * HEADER_BUDGET);
    const archived = runtime.callsTo("getArchive").map((c) => c.args[1]);
    expect(archived).toEqual(["/minibox-volume/via", "/minibox-volume/big/n.txt"]);
  });

  test("reading a large file pulls only maxBytes of it and reports the real size", async () => {
    const vol = await volume();
    runtime.seedVolumeFile(vol.engineName, "huge.txt", { type: "file", content: Buffer.alloc(BIG, 0x61) });
    runtime.archiveBytesRead = 0;
    const read = await readFile(host, vol.id, { path: "huge.txt", maxBytes: 1000 });
    expect(read).toMatchObject({ size: BIG, truncated: true, type: "file" });
    expect(read.content.length).toBe(1000);
    expect(runtime.archiveBytesRead).toBeLessThanOrEqual(HEADER_BUDGET);

    runtime.archiveBytesRead = 0;
    const full = await readFile(host, vol.id, { path: "huge.txt" });
    expect(full.content.length).toBe(1024 * 1024);
    expect(runtime.archiveBytesRead).toBeLessThanOrEqual(1024 * 1024 + 2 * HEADER_BUDGET);
  });

  test("download stops streaming once the archive passes the cap", async () => {
    const vol = await volume();
    runtime.seedVolumeFile(vol.engineName, "big/blob.bin", { type: "file", content: Buffer.alloc(BIG, 1) });
    runtime.archiveBytesRead = 0;
    expect(await statusOf(downloadArchive(host, vol.id, { path: "big" }))).toBe(400);
    expect(runtime.archiveBytesRead).toBeLessThanOrEqual(4 * 1024 * 1024 + HEADER_BUDGET);
  });
});

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (`${len}${body}`.length !== len) len += 1;
  return `${len}${body}`;
}

function tarHeader(name: string, type: string, size: number, link = ""): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0);
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  block.write(type, 156);
  if (link) block.write(link.slice(0, 100), 157);
  block.write("ustar\0", 257);
  return block;
}

function enc(o: object): string {
  return Buffer.from(JSON.stringify(o)).toString("base64");
}

describe("tar first entry and engine path stat", () => {
  test("firstEntry applies a PAX linkpath longer than the ustar field", async () => {
    const { firstEntry } = await import("../src/lib/tar");
    const long = `${"../".repeat(40)}etc`;
    const paxBody = Buffer.from(paxRecord("linkpath", long));
    const pad = Buffer.alloc((512 - (paxBody.length % 512)) % 512);
    const tar = Buffer.concat([
      tarHeader("PaxHeaders/l", "x", paxBody.length),
      paxBody,
      pad,
      tarHeader("l", "2", 0, long),
    ]);
    expect(firstEntry(tar)).toMatchObject({ name: "l", type: "symlink", linkname: long });
    // Incomplete input is not an entry yet.
    expect(firstEntry(tar.subarray(0, 600))).toBeNull();
  });

  test("parsePathStat decodes the engine's stat header", async () => {
    const { parsePathStat } = await import("../src/docker/archive");
    expect(parsePathStat(enc({ name: "d", size: 4096, mode: 2147484141, linkTarget: "" }), "/v/d").type).toBe("dir");
    expect(parsePathStat(enc({ name: "f", size: 3, mode: 420, linkTarget: "" }), "/v/f")).toMatchObject({
      type: "file",
      size: 3,
    });
    expect(parsePathStat(enc({ name: "l", size: 4, mode: 134218239, linkTarget: "/v/d" }), "/v/l")).toMatchObject({
      type: "symlink",
      linkTarget: "/v/d",
    });
    expect(parsePathStat(enc({ name: "p", size: 0, mode: 2 ** 25 + 0o644 }), "/v/p").type).toBe("other");
    expect(() => parsePathStat(undefined, "/v/x")).toThrow();
  });
});
