import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";

import type { HostCtx } from "../src/host/registry";
import { type ByteStream, isByteStream, type RawBody } from "../src/lib/body";
import { AppError } from "../src/lib/errors";
import { RuntimeError } from "../src/runtime";
import {
  deletePath,
  listFiles,
  makeDirectory,
  movePath,
  readFile,
  streamDownload,
  streamUpload,
  writeFile,
} from "../src/services/files";
import { parseTar } from "../src/services/files-tar";
import { createVolume } from "../src/services/volumes";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

const LIMIT = 1024 * 1024;

let runtime: FakeRuntime;
let host: HostCtx;
let restoreLogs: () => void;

beforeAll(() => {
  restoreLogs = silenceLogs();
});
afterAll(() => restoreLogs());

beforeEach(() => {
  const created = createTestApp({ labelPrefix: "mbtest" });
  runtime = created.runtime;
  host = created.app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true" });
});

async function volume() {
  return createVolume(host, { name: "notes", role: null, createdBy: "owner" });
}

type Vol = Awaited<ReturnType<typeof volume>>;

/** An upload body of `text`, declared as `declared` bytes (its real length unless a test says otherwise). */
function bodyOf(text: string, declared = Buffer.byteLength(text)): RawBody {
  return { stream: new Response(Buffer.from(text)).body, length: declared };
}

function upload(
  vol: Vol,
  path: string,
  text: string,
  opts: { overwrite?: boolean; declared?: number; maxBytes?: number } = {},
) {
  return streamUpload(host, vol.id, {
    path,
    overwrite: opts.overwrite ?? false,
    body: bodyOf(text, opts.declared),
    maxBytes: opts.maxBytes ?? LIMIT,
  });
}

const filesOf = (vol: Vol) => runtime.filesOf(vol.engineName);
const textOf = (vol: Vol, path: string) => filesOf(vol).get(path)?.content?.toString("utf8");
const leftovers = (vol: Vol) => [...filesOf(vol).keys()].filter((key) => key.includes(".minibox-upload-"));

async function statusOf(p: Promise<unknown>): Promise<number> {
  const err = await rejectionOf(p);
  expect(err).toBeInstanceOf(AppError);
  return (err as AppError).status;
}

async function bytesOf(stream: ByteStream): Promise<Buffer> {
  return Buffer.from(await new Response(stream.body).arrayBuffer());
}

/** Waits until the helper runs a command, so a test can change the volume while that command is held. */
async function untilHelperRuns(command: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (runtime.callsTo("runHelper").some((call) => (call.args[0] as { cmd: string[] }).cmd[0] === command)) return;
    await Bun.sleep(5);
  }
  throw new Error(`the helper never ran ${command}`);
}

describe("streamed upload", () => {
  test("writes one file owned by uid 1000 and reports its bytes", async () => {
    const vol = await volume();
    const result = await upload(vol, "notes/todo.txt", "one\n");
    expect(result).toEqual({ volume: "notes", path: "notes/todo.txt", bytesWritten: 4, overwritten: false });
    expect(filesOf(vol).get("notes/todo.txt")).toMatchObject({ type: "file", uid: 1000, gid: 1000 });
    expect(textOf(vol, "notes/todo.txt")).toBe("one\n");
    expect(leftovers(vol)).toEqual([]);
  });

  test("refuses an existing file without overwrite and keeps it", async () => {
    const vol = await volume();
    await upload(vol, "a.txt", "first");
    const err = await rejectionOf(upload(vol, "a.txt", "second"));
    expect(err).toBeInstanceOf(AppError);
    expect(err as AppError).toMatchObject({ status: 409, code: "conflict", key: "file_exists" });
    expect(textOf(vol, "a.txt")).toBe("first");
    expect(leftovers(vol)).toEqual([]);
  });

  test("replaces an existing file with overwrite and says so", async () => {
    const vol = await volume();
    await upload(vol, "a.txt", "first");
    const result = await upload(vol, "a.txt", "second", { overwrite: true });
    expect(result).toMatchObject({ bytesWritten: 6, overwritten: true });
    expect(textOf(vol, "a.txt")).toBe("second");
    expect(leftovers(vol)).toEqual([]);
  });

  test("refuses a folder at the target, even with overwrite", async () => {
    const vol = await volume();
    await makeDirectory(host, vol.id, { path: "docs" });
    const err = await rejectionOf(upload(vol, "docs", "x", { overwrite: true }));
    expect(err as AppError).toMatchObject({ status: 409, key: "file_target_is_directory" });
    expect(filesOf(vol).get("docs")?.type).toBe("dir");
  });

  test("creates the folders the path needs", async () => {
    const vol = await volume();
    await upload(vol, "a/b/c.txt", "deep");
    expect(filesOf(vol).get("a")?.type).toBe("dir");
    expect(filesOf(vol).get("a/b")?.type).toBe("dir");
    expect(textOf(vol, "a/b/c.txt")).toBe("deep");
  });

  test("a body shorter than its declared length leaves nothing behind", async () => {
    const vol = await volume();
    const err = await rejectionOf(upload(vol, "short.txt", "abc", { declared: 5 }));
    expect(err as AppError).toMatchObject({ status: 400, key: "file_upload_mismatch" });
    expect(filesOf(vol).has("short.txt")).toBe(false);
    expect(leftovers(vol)).toEqual([]);
  });

  test("a body longer than its declared length keeps the file it would have replaced", async () => {
    const vol = await volume();
    await upload(vol, "a.txt", "first");
    const err = await rejectionOf(upload(vol, "a.txt", "far too long", { overwrite: true, declared: 3 }));
    expect(err as AppError).toMatchObject({ status: 400, key: "file_upload_mismatch" });
    expect(textOf(vol, "a.txt")).toBe("first");
    expect(leftovers(vol)).toEqual([]);
  });

  test("a body that fails while it is read leaves nothing behind and keeps the file it would have replaced", async () => {
    const vol = await volume();
    await upload(vol, "a.txt", "first");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("ab"));
      },
      pull(controller) {
        controller.error(new Error("the client went away"));
      },
    });
    const err = await rejectionOf(
      streamUpload(host, vol.id, {
        path: "a.txt",
        overwrite: true,
        body: { stream, length: 10 },
        maxBytes: LIMIT,
      }),
    );
    expect((err as Error).message).toBe("the client went away");
    expect(textOf(vol, "a.txt")).toBe("first");
    expect(leftovers(vol)).toEqual([]);
  });

  test("refuses a file over the size limit before any helper runs", async () => {
    const vol = await volume();
    const before = runtime.callsTo("putArchive").length;
    const err = await rejectionOf(upload(vol, "big.bin", "four!", { maxBytes: 3 }));
    expect(err as AppError).toMatchObject({ status: 413, code: "payload_too_large", key: "file_upload_too_large" });
    expect(runtime.callsTo("putArchive").length).toBe(before);
    expect(filesOf(vol).has("big.bin")).toBe(false);
  });

  test("refuses the volume root as a file", async () => {
    const vol = await volume();
    expect(await statusOf(upload(vol, "/", "x"))).toBe(400);
  });

  test("a failed rename removes the temporary name and the error is reported", async () => {
    const vol = await volume();
    runtime.fail("runHelper", new RuntimeError("engine", "helper failed"));
    const err = await rejectionOf(upload(vol, "kept.txt", "data"));
    expect(err).toBeInstanceOf(RuntimeError);
    expect(filesOf(vol).has("kept.txt")).toBe(false);
    expect(leftovers(vol)).toEqual([]);
  });

  test("a long file name keeps its full name through the tar and the rename", async () => {
    const vol = await volume();
    const name = `${"n".repeat(120)}.txt`;
    await upload(vol, name, "long");
    expect(textOf(vol, name)).toBe("long");
    expect((await readFile(host, vol.id, { path: name })).content).toBe("long");
  });

  test("refuses an upload through a link that leaves the volume", async () => {
    const vol = await volume();
    runtime.seedVolumeFile(vol.engineName, "escape", { type: "symlink", target: "/tmp" });
    runtime.seedOutsideFile("/tmp", { type: "dir" });
    expect(await statusOf(upload(vol, "escape/pwned.txt", "nope"))).toBe(400);
    expect(runtime.outsideFiles.get("/tmp/pwned.txt")).toBeUndefined();
  });

  test("replaces a link at the target and never writes through it", async () => {
    const vol = await volume();
    runtime.seedOutsideFile("/etc/alpine-release", { type: "file", content: Buffer.from("OUTSIDE") });
    runtime.seedVolumeFile(vol.engineName, "link.txt", { type: "symlink", target: "/etc/alpine-release" });
    await upload(vol, "link.txt", "inside", { overwrite: true });
    expect(filesOf(vol).get("link.txt")).toMatchObject({ type: "file" });
    expect(textOf(vol, "link.txt")).toBe("inside");
    expect(runtime.outsideFiles.get("/etc/alpine-release")?.content?.toString("utf8")).toBe("OUTSIDE");
  });
});

describe("streamed download", () => {
  test("a file streams its own bytes with its name, type and size", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "notes/todo.txt", content: "one\n" });
    const result = await streamDownload(host, vol.id, { path: "notes/todo.txt" });
    expect(isByteStream(result)).toBe(true);
    expect(result).toMatchObject({
      kind: "bytes",
      filename: "todo.txt",
      contentType: "application/octet-stream",
      length: 4,
    });
    expect((await bytesOf(result)).toString("utf8")).toBe("one\n");
  });

  test("a folder streams a gzip tar of everything in it", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "pack/a.txt", content: "A" });
    await writeFile(host, vol.id, { path: "pack/sub/b.txt", content: "B" });
    const result = await streamDownload(host, vol.id, { path: "pack" });
    expect(result).toMatchObject({ filename: "pack.tar.gz", contentType: "application/gzip", length: null });
    const names = parseTar(gunzipSync(await bytesOf(result))).map((entry) => entry.name);
    expect(names.some((name) => name.endsWith("a.txt"))).toBe(true);
    expect(names.some((name) => name.endsWith("b.txt"))).toBe(true);
  });

  test("the whole volume downloads as a gzip tar named after the volume", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "root.txt", content: "r" });
    const result = await streamDownload(host, vol.id, { path: "/" });
    expect(result).toMatchObject({ filename: "notes.tar.gz", contentType: "application/gzip" });
    expect(parseTar(gunzipSync(await bytesOf(result))).some((entry) => entry.name.endsWith("root.txt"))).toBe(true);
  });

  test("a missing path answers 404 and removes the helper it made", async () => {
    const vol = await volume();
    const created = runtime.callsTo("createContainer").length;
    const removed = runtime.callsTo("removeContainer").length;
    expect(await statusOf(streamDownload(host, vol.id, { path: "nope.txt" }))).toBe(404);
    expect(runtime.callsTo("createContainer").length - created).toBe(1);
    expect(runtime.callsTo("removeContainer").length - removed).toBe(1);
  });

  test("a link to a file inside the volume downloads the file it points at", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "real.txt", content: "target" });
    runtime.seedVolumeFile(vol.engineName, "link", { type: "symlink", target: "real.txt" });
    const result = await streamDownload(host, vol.id, { path: "link" });
    expect(result).toMatchObject({ filename: "link", length: 6 });
    expect((await bytesOf(result)).toString("utf8")).toBe("target");
  });

  test("a link that leaves the volume is refused", async () => {
    const vol = await volume();
    runtime.seedVolumeFile(vol.engineName, "escape", { type: "symlink", target: "/tmp" });
    runtime.seedOutsideFile("/tmp/secret", { type: "file", content: Buffer.from("secret") });
    expect(await statusOf(streamDownload(host, vol.id, { path: "escape/secret" }))).toBe(400);
  });

  test("a body read to its end, and one cancelled, each release the helper container", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "a.txt", content: "a" });
    const removed = runtime.callsTo("removeContainer").length;
    await bytesOf(await streamDownload(host, vol.id, { path: "a.txt" }));
    expect(runtime.callsTo("removeContainer").length).toBe(removed + 1);

    const cancelled = await streamDownload(host, vol.id, { path: "a.txt" });
    await cancelled.body.cancel();
    expect(runtime.callsTo("removeContainer").length).toBe(removed + 2);
  });
});

describe("reads", () => {
  test("a file that is not UTF-8 text is refused as text, and reads back exactly as base64", async () => {
    const vol = await volume();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
    await streamUpload(host, vol.id, {
      path: "notes/image.bin",
      overwrite: false,
      body: { stream: new Response(bytes).body, length: bytes.length },
      maxBytes: LIMIT,
    });
    const refused = await rejectionOf(readFile(host, vol.id, { path: "notes/image.bin" }));
    expect(refused as AppError).toMatchObject({ status: 400, key: "file_not_text" });
    const read = await readFile(host, vol.id, { path: "notes/image.bin", encoding: "base64" });
    expect(Buffer.from(read.content, "base64")).toEqual(bytes);
  });
});

describe("folders", () => {
  test("creates a folder and its parents once, then reports it as already there", async () => {
    const vol = await volume();
    expect(await makeDirectory(host, vol.id, { path: "made/deep" })).toEqual({
      volume: "notes",
      path: "made/deep",
      created: true,
    });
    expect(filesOf(vol).get("made/deep")?.type).toBe("dir");
    expect(await makeDirectory(host, vol.id, { path: "made/deep" })).toMatchObject({ created: false });
  });

  test("refuses a file at the folder's path", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "taken", content: "x" });
    expect(await statusOf(makeDirectory(host, vol.id, { path: "taken" }))).toBe(409);
  });
});

describe("move", () => {
  test("renames a file and creates the folders of its new path", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "a.txt", content: "moved" });
    expect(await movePath(host, vol.id, { from: "a.txt", to: "x/y/b.txt" })).toEqual({
      volume: "notes",
      from: "a.txt",
      to: "x/y/b.txt",
    });
    expect(filesOf(vol).has("a.txt")).toBe(false);
    expect(textOf(vol, "x/y/b.txt")).toBe("moved");
  });

  test("moves a folder with everything in it", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "d/one.txt", content: "1" });
    await writeFile(host, vol.id, { path: "d/inner/two.txt", content: "2" });
    await movePath(host, vol.id, { from: "d", to: "e" });
    expect(filesOf(vol).has("d")).toBe(false);
    expect(textOf(vol, "e/one.txt")).toBe("1");
    expect(textOf(vol, "e/inner/two.txt")).toBe("2");
  });

  test("refuses an existing destination and leaves both paths as they were", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "a.txt", content: "a" });
    await writeFile(host, vol.id, { path: "b.txt", content: "b" });
    const err = await rejectionOf(movePath(host, vol.id, { from: "a.txt", to: "b.txt" }));
    expect(err as AppError).toMatchObject({ status: 409, key: "file_exists" });
    expect(textOf(vol, "a.txt")).toBe("a");
    expect(textOf(vol, "b.txt")).toBe("b");
  });

  test("a destination that appears while the move runs is not clobbered", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "a.txt", content: "a" });
    const held = runtime.hold("runHelper", (args) => (args[0] as { cmd: string[] }).cmd[0] === "mv");
    const move = movePath(host, vol.id, { from: "a.txt", to: "b.txt" });
    await untilHelperRuns("mv");
    runtime.seedVolumeFile(vol.engineName, "b.txt", { type: "file", content: Buffer.from("new") });
    held.release();
    expect(await statusOf(move)).toBe(409);
    expect(textOf(vol, "a.txt")).toBe("a");
    expect(textOf(vol, "b.txt")).toBe("new");
  });

  test("refuses a move into its own subtree, the root, a missing source and the same path", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "d/x.txt", content: "x" });
    expect(await statusOf(movePath(host, vol.id, { from: "d", to: "d/inner" }))).toBe(400);
    expect(await statusOf(movePath(host, vol.id, { from: "/", to: "elsewhere" }))).toBe(400);
    expect(await statusOf(movePath(host, vol.id, { from: "missing", to: "elsewhere" }))).toBe(404);
    expect(await statusOf(movePath(host, vol.id, { from: "d", to: "d" }))).toBe(400);
    expect(textOf(vol, "d/x.txt")).toBe("x");
  });
});

describe("delete", () => {
  test("without confirm, answers 409 with a preview and removes nothing", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "gone.txt", content: "bytes" });
    const err = await rejectionOf(deletePath(host, vol.id, { path: "gone.txt", confirm: false }));
    expect(err as AppError).toMatchObject({ status: 409, code: "confirmation_required" });
    expect((err as AppError).details).toEqual({
      preview: { action: "delete_file", volume: "notes", path: "gone.txt", type: "file", size: 5 },
    });
    expect(textOf(vol, "gone.txt")).toBe("bytes");
  });

  test("with confirm, removes one file", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "gone.txt", content: "bytes" });
    expect(await deletePath(host, vol.id, { path: "gone.txt", confirm: true })).toEqual({
      volume: "notes",
      path: "gone.txt",
    });
    expect(filesOf(vol).has("gone.txt")).toBe(false);
  });

  test("with confirm, removes a folder tree", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "d/x.txt", content: "x" });
    await writeFile(host, vol.id, { path: "d/y/z.txt", content: "z" });
    await deletePath(host, vol.id, { path: "d", confirm: true });
    expect([...filesOf(vol).keys()].filter((key) => key === "d" || key.startsWith("d/"))).toEqual([]);
  });

  test("removes a link itself and leaves the file it points at", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "real.txt", content: "keep" });
    runtime.seedVolumeFile(vol.engineName, "ln", { type: "symlink", target: "real.txt" });
    await deletePath(host, vol.id, { path: "ln", confirm: true });
    expect(filesOf(vol).has("ln")).toBe(false);
    expect(textOf(vol, "real.txt")).toBe("keep");
  });

  test("refuses the volume root even with confirm, and a missing path answers 404", async () => {
    const vol = await volume();
    expect(await statusOf(deletePath(host, vol.id, { path: "/", confirm: true }))).toBe(400);
    expect(await statusOf(deletePath(host, vol.id, { path: "nope", confirm: true }))).toBe(404);
  });
});

describe("listing", () => {
  test("each entry carries its modification time", async () => {
    const vol = await volume();
    runtime.seedVolumeFile(vol.engineName, "old.txt", {
      type: "file",
      content: Buffer.from("hi"),
      mtime: 1_600_000_000,
    });
    const listed = await listFiles(host, vol.id, { path: "/", maxDepth: 1 });
    expect(listed.entries).toContainEqual({
      path: "old.txt",
      type: "file",
      size: 2,
      mtime: "2020-09-13T12:26:40.000Z",
    });
  });

  test("the listed folder is still the first entry, as the API has always answered", async () => {
    const vol = await volume();
    await writeFile(host, vol.id, { path: "one.txt", content: "1" });
    const listed = await listFiles(host, vol.id, { path: "/", maxDepth: 1 });
    expect(listed.entries[0]).toMatchObject({ path: "/", type: "dir", size: null });
    expect(listed.entries.map((entry) => entry.path)).toContain("one.txt");
  });

  test("a warning from the helper's stderr does not hide the entry after it", async () => {
    const vol = await volume();
    runtime.helperHandler = () => ({
      exitCode: 0,
      logs: [
        "d\t0\t1700000000.0000000000\t/minibox-volume\0",
        "find: '/minibox-volume/locked': Permission denied\n",
        "f\t3\t1700000000.0000000000\t/minibox-volume/ok.txt\0",
      ].join(""),
    });
    const listed = await listFiles(host, vol.id, { path: "/", maxDepth: 1 });
    expect(listed.entries).toEqual([
      { path: "/", type: "dir", size: null, mtime: "2023-11-14T22:13:20.000Z" },
      { path: "ok.txt", type: "file", size: 3, mtime: "2023-11-14T22:13:20.000Z" },
    ]);
  });
});
