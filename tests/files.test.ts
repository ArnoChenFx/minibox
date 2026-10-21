import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { HostCtx } from "../src/host/registry";
import { AppError } from "../src/lib/errors";
import type { OperationContext, Principal } from "../src/operations/types";
import { copyFiles, downloadArchive, listFiles, readFile, uploadArchive, writeFile } from "../src/services/files";
import { jailPath, resolveSymlinkInVolume, symlinkTargetEscapes } from "../src/services/files-path";
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

  test("symlinkTargetEscapes detects absolute and .. escapes", () => {
    expect(symlinkTargetEscapes("/minibox-volume", "escape", "/tmp")).toBe(true);
    expect(symlinkTargetEscapes("/minibox-volume", "escape", "/minibox-volume/ok")).toBe(false);
    expect(symlinkTargetEscapes("/minibox-volume", "a/link", "../..")).toBe(true);
    expect(symlinkTargetEscapes("/minibox-volume", "a/link", "../b")).toBe(false);
    // Physical base after following an earlier in-volume link: foo at volume root with target "..".
    expect(symlinkTargetEscapes("/minibox-volume", "foo", "..")).toBe(true);
    expect(symlinkTargetEscapes("/minibox-volume", "deep/link/foo", "..")).toBe(false); // lexical-only would miss it
  });

  test("resolveSymlinkInVolume returns mount-relative target or null on escape", () => {
    expect(resolveSymlinkInVolume("/minibox-volume", "deep/link", "..")).toBe("");
    expect(resolveSymlinkInVolume("/minibox-volume", "foo", "..")).toBeNull();
    expect(resolveSymlinkInVolume("/minibox-volume", "a/link", "../b")).toBe("b");
    expect(resolveSymlinkInVolume("/minibox-volume", "escape", "/minibox-volume/ok")).toBe("ok");
    expect(resolveSymlinkInVolume("/minibox-volume", "escape", "/minibox-volume")).toBe("");
    expect(resolveSymlinkInVolume("/minibox-volume", "escape", "/tmp")).toBeNull();
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
    const { firstFileData } = await import("../src/services/files-tar");
    const first = firstFileData(Buffer.from(tar));
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
