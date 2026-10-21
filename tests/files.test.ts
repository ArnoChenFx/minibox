import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { HostCtx } from "../src/host/registry";
import { AppError } from "../src/lib/errors";
import type { OperationContext, Principal } from "../src/operations/types";
import { copyFiles, downloadArchive, listFiles, readFile, uploadArchive, writeFile } from "../src/services/files";
import { jailPath } from "../src/services/files-path";
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
