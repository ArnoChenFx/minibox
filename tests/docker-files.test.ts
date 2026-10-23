/**
 * Runs the file browser's volume operations against a real engine. Uploads and downloads go through the Engine's archive
 * API, and the helper that writes a volume runs as uid 1000, so the files it writes belong to the box user.
 *
 *   bun run test:docker
 *
 * That script (scripts/docker-integration.ts) pulls the image, picks a fresh label prefix and sweeps what the run left
 * behind. To run this file directly: MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbit<id> bun test tests/docker-files.test.ts
 *
 * The helper image is debian:bookworm-slim, the userland of the base template: the listing needs GNU find (-printf),
 * which BusyBox does not have. Optional: DOCKER_SOCKET (default /var/run/docker.sock). The prefix must start with
 * "mbit", so the cleanup can never touch a real MiniBox install.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { createDockerRuntime } from "../src/docker/runtime";
import { createLocalHost, type HostCtx } from "../src/host/registry";
import type { RawBody } from "../src/lib/body";
import type { Runtime } from "../src/runtime";
import {
  deletePath,
  listFiles,
  makeDirectory,
  movePath,
  readFile,
  streamDownload,
  streamUpload,
} from "../src/services/files";
import { parseTar } from "../src/services/files-tar";
import { createVolume, type VolumeView } from "../src/services/volumes";
import { rejectionOf, silenceLogs, testConfig } from "./support/app";

const enabled = process.env.MINIBOX_TEST_DOCKER === "1";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const HELPER_IMAGE = "debian:bookworm-slim";
const LONG = 60_000;
const LIMIT = 16 * 1024 * 1024;
const DEV_UID = 1000;

const PREFIX_PATTERN = /^mbit[a-z0-9-]{3,40}$/;
const prefix = process.env.MINIBOX_TEST_PREFIX ?? `mbit${Date.now().toString(36)}`;
if (enabled && !PREFIX_PATTERN.test(prefix)) throw new Error(`MINIBOX_TEST_PREFIX must match ${PREFIX_PATTERN}`);

const runtime: Runtime = createDockerRuntime(SOCKET);
const cfg = testConfig({
  labelPrefix: prefix,
  dockerSocket: SOCKET,
  baseTemplateTag: HELPER_IMAGE,
  dataDir: mkdtempSync(join(tmpdir(), "minibox-files-test-")),
});
const host: HostCtx = createLocalHost(cfg, runtime);
const MOUNT = "/minibox-volume";

/** An upload body of `text`, declared as `declared` bytes (its real length unless a test says otherwise). */
function bodyOf(text: string, declared = Buffer.byteLength(text)): RawBody {
  return { stream: new Response(Buffer.from(text)).body, length: declared };
}

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

describe.skipIf(!enabled)("the file browser's volume operations on a real engine", () => {
  let restoreLogs: () => void;
  let vol: VolumeView;

  /** Runs `sh -c` in a helper with the volume mounted. A write runs as the box user, as the file API's helpers do. */
  async function inVolume(script: string, mode: "ro" | "rw" = "rw") {
    return runtime.runHelper({
      image: HELPER_IMAGE,
      cmd: ["sh", "-c", script],
      user: mode === "rw" ? `${DEV_UID}:${DEV_UID}` : undefined,
      mounts: [{ source: vol.engineName, target: MOUNT, mode }],
      labels: { [host.keys.internal]: "true" },
      timeoutSec: 60,
    });
  }

  async function ownerOf(path: string): Promise<string> {
    const result = await inVolume(`stat -c '%u:%g' ${MOUNT}/${path}`, "ro");
    expect(result.exitCode).toBe(0);
    return result.logs.trim();
  }

  beforeAll(async () => {
    restoreLogs = silenceLogs();
    vol = await createVolume(host, { name: `${prefix}-files`, role: null, createdBy: "owner" });
  }, LONG);

  afterAll(async () => {
    await runtime.removeVolume(vol?.engineName ?? "").catch(() => {});
    restoreLogs?.();
  });

  test(
    "an uploaded file is written with its bytes and owned by uid 1000, its folders too",
    async () => {
      const result = await streamUpload(host, vol.id, {
        path: "notes/todo.txt",
        overwrite: false,
        body: bodyOf("hello\n"),
        maxBytes: LIMIT,
      });
      expect(result).toEqual({ volume: vol.name, path: "notes/todo.txt", bytesWritten: 6, overwritten: false });
      const read = await readFile(host, vol.id, { path: "notes/todo.txt" });
      expect([read.type, read.size, read.content]).toEqual(["file", 6, "hello\n"]);
      expect(await ownerOf("notes/todo.txt")).toBe(`${DEV_UID}:${DEV_UID}`);
      expect(await ownerOf("notes")).toBe(`${DEV_UID}:${DEV_UID}`);
    },
    LONG,
  );

  test(
    "an empty file is accepted and lands as a zero-byte file",
    async () => {
      const result = await streamUpload(host, vol.id, {
        path: "empty.txt",
        overwrite: false,
        body: bodyOf(""),
        maxBytes: LIMIT,
      });
      expect(result.bytesWritten).toBe(0);
      const read = await readFile(host, vol.id, { path: "empty.txt" });
      expect([read.type, read.size]).toEqual(["file", 0]);
      expect(await ownerOf("empty.txt")).toBe(`${DEV_UID}:${DEV_UID}`);
    },
    LONG,
  );

  test(
    "a body that is shorter than its declared length is refused, and no file or temporary name is left",
    async () => {
      const err = await rejectionOf(
        streamUpload(host, vol.id, {
          path: "short.txt",
          overwrite: false,
          body: bodyOf("abc", 10),
          maxBytes: LIMIT,
        }),
      );
      expect(err).toMatchObject({ status: 400, key: "file_upload_mismatch" });
      const listing = await listFiles(host, vol.id, { maxDepth: 1 });
      expect(listing.entries.map((entry) => entry.path)).not.toContain("short.txt");
      expect(listing.entries.filter((entry) => entry.path.includes(".minibox-upload-"))).toEqual([]);
    },
    LONG,
  );

  test(
    "a body that is longer than its declared length is refused, and no file or temporary name is left",
    async () => {
      const err = await rejectionOf(
        streamUpload(host, vol.id, {
          path: "long.txt",
          overwrite: false,
          body: bodyOf("abcdefghij", 3),
          maxBytes: LIMIT,
        }),
      );
      expect(err).toMatchObject({ status: 400, key: "file_upload_mismatch" });
      const listing = await listFiles(host, vol.id, { maxDepth: 1 });
      expect(listing.entries.map((entry) => entry.path)).not.toContain("long.txt");
      expect(listing.entries.filter((entry) => entry.path.includes(".minibox-upload-"))).toEqual([]);
    },
    LONG,
  );

  test(
    "a body that fails while it is read is refused, and no file or temporary name is left",
    async () => {
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
          path: "dropped.txt",
          overwrite: false,
          body: { stream, length: 10 },
          maxBytes: LIMIT,
        }),
      );
      expect((err as Error).message).toBe("the client went away");
      const listing = await listFiles(host, vol.id, { maxDepth: 1 });
      expect(listing.entries.map((entry) => entry.path)).not.toContain("dropped.txt");
      expect(listing.entries.filter((entry) => entry.path.includes(".minibox-upload-"))).toEqual([]);
    },
    LONG,
  );

  test(
    "an existing file is kept unless overwrite is asked for, and then its contents are replaced",
    async () => {
      await streamUpload(host, vol.id, { path: "keep.txt", overwrite: false, body: bodyOf("one"), maxBytes: LIMIT });
      const refused = await rejectionOf(
        streamUpload(host, vol.id, { path: "keep.txt", overwrite: false, body: bodyOf("two"), maxBytes: LIMIT }),
      );
      expect(refused).toMatchObject({ status: 409, key: "file_exists" });
      expect((await readFile(host, vol.id, { path: "keep.txt" })).content).toBe("one");

      const replaced = await streamUpload(host, vol.id, {
        path: "keep.txt",
        overwrite: true,
        body: bodyOf("two"),
        maxBytes: LIMIT,
      });
      expect(replaced.overwritten).toBe(true);
      expect((await readFile(host, vol.id, { path: "keep.txt" })).content).toBe("two");
      expect(await ownerOf("keep.txt")).toBe(`${DEV_UID}:${DEV_UID}`);
    },
    LONG,
  );

  test(
    "a file downloads as its own bytes, and a folder downloads as a gzip tar of everything in it",
    async () => {
      const single = await streamDownload(host, vol.id, { path: "notes/todo.txt" });
      expect(await bytesOf(single.body)).toEqual(Buffer.from("hello\n"));

      await streamUpload(host, vol.id, {
        path: "notes/nested/deep.txt",
        overwrite: false,
        body: bodyOf("deep"),
        maxBytes: LIMIT,
      });
      const folder = await streamDownload(host, vol.id, { path: "notes" });
      expect(folder.filename).toBe("notes.tar.gz");
      expect(folder.contentType).toBe("application/gzip");
      const names = parseTar(gunzipSync(await bytesOf(folder.body))).map((entry) => entry.name);
      expect(names).toEqual(expect.arrayContaining(["notes/todo.txt", "notes/nested/deep.txt"]));
    },
    LONG,
  );

  test(
    "a path that climbs out of the volume is refused before anything is touched",
    async () => {
      const err = await rejectionOf(
        streamUpload(host, vol.id, {
          path: "../outside.txt",
          overwrite: false,
          body: bodyOf("nope"),
          maxBytes: LIMIT,
        }),
      );
      expect(err).toMatchObject({ status: 400, key: "file_path_escape" });
    },
    LONG,
  );

  test(
    "a symbolic link that leaves the volume is refused, and one that stays inside it is followed",
    async () => {
      const made = await inVolume(
        `cd ${MOUNT} && ln -s ../../../etc escape && ln -s notes inside && ln -s /etc/hostname absolute`,
      );
      expect([made.exitCode, made.logs]).toEqual([0, ""]);

      const escape = await rejectionOf(
        streamUpload(host, vol.id, {
          path: "escape/planted.txt",
          overwrite: false,
          body: bodyOf("planted"),
          maxBytes: LIMIT,
        }),
      );
      expect(escape).toMatchObject({ status: 400, key: "file_path_escape" });

      const absolute = await rejectionOf(
        streamUpload(host, vol.id, {
          path: "absolute/planted.txt",
          overwrite: false,
          body: bodyOf("planted"),
          maxBytes: LIMIT,
        }),
      );
      expect(absolute).toMatchObject({ status: 400, key: "file_path_escape" });

      const inside = await readFile(host, vol.id, { path: "inside/todo.txt" });
      expect(inside.content).toBe("hello\n");

      const listing = await listFiles(host, vol.id, { maxDepth: 1 });
      const link = listing.entries.find((entry) => entry.path === "escape");
      expect(link?.type).toBe("symlink");
      const described = await readFile(host, vol.id, { path: "escape" });
      expect([described.type, described.linkTarget]).toEqual(["symlink", "../../../etc"]);
    },
    LONG,
  );

  test(
    "a folder is made once and then reused, moved, and removed only after the server asks for confirmation",
    async () => {
      expect(await makeDirectory(host, vol.id, { path: "work/a/b" })).toMatchObject({ created: true });
      expect(await makeDirectory(host, vol.id, { path: "work/a/b" })).toMatchObject({ created: false });

      await movePath(host, vol.id, { from: "work/a", to: "work/moved" });
      const moved = await listFiles(host, vol.id, { path: "work", maxDepth: 1 });
      expect(moved.entries.map((entry) => entry.path)).toContain("work/moved");
      expect(moved.entries.map((entry) => entry.path)).not.toContain("work/a");

      const asked = await rejectionOf(deletePath(host, vol.id, { path: "work/moved", confirm: false }));
      expect(asked).toMatchObject({ status: 409, code: "confirmation_required" });
      expect(await listFiles(host, vol.id, { path: "work", maxDepth: 1 })).toMatchObject({
        entries: expect.arrayContaining([expect.objectContaining({ path: "work/moved" })]),
      });

      await deletePath(host, vol.id, { path: "work/moved", confirm: true });
      const after = await listFiles(host, vol.id, { path: "work", maxDepth: 1 });
      expect(after.entries.map((entry) => entry.path)).toEqual(["work"]);
    },
    LONG,
  );

  test(
    "a listing gives each child its size and modification time, and names the root /",
    async () => {
      const listing = await listFiles(host, vol.id, { path: "notes", maxDepth: 1 });
      const todo = listing.entries.find((entry) => entry.path === "notes/todo.txt");
      expect(todo).toMatchObject({ type: "file", size: 6 });
      expect(Date.parse(todo?.mtime ?? "")).not.toBeNaN();
      const root = await listFiles(host, vol.id, {});
      expect(root.entries.find((entry) => entry.path === "/")).toMatchObject({ type: "dir" });
    },
    LONG,
  );
});
