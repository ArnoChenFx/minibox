import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { HostCtx } from "../src/host/registry";
import { createVolume } from "../src/services/volumes";
import { silenceLogs, TEST_KEY } from "./support/app";
import { call, type Harness, mint, refused, startHarness } from "./support/tokens";

/**
 * The file and exec rules an agent token is held to, checked at the entries that enforce them: `exec.run` behind
 * POST /api/boxes/:id/exec, and the volume file operations behind /api/volumes/:id/files. An exec token reads, writes
 * and execs on every mount of a box it may use. Without exec, `files:read` reads and `files:write` writes, and neither
 * execs. File access follows the volume's grant, and exec follows the box's.
 */

let harness: Harness;
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  harness = startHarness();
});

afterEach(() => {
  harness.stop();
  restoreLogs();
});

const host = (): HostCtx => harness.app.hosts.get();

async function ownerBox(name: string): Promise<{ id: string; boxId: string }> {
  const reply = await call(harness.base, "/api/boxes", { body: { name, cpus: 1, memoryMb: 256 } });
  expect(reply.status).toBe(201);
  const box = reply.json.box;
  if (!box) throw new Error("the create reply has no box");
  return { id: box.id, boxId: box.boxId };
}

/** The workspace volume a box was created with, as the volume record the file API takes. */
function workspaceOf(boxId: string): { id: string; name: string } {
  const spec = host().specs.read(boxId);
  const workspace = spec?.mounts.find((mount) => mount.path === "/workspace");
  if (!workspace) throw new Error("the box has no workspace mount");
  const record = host().volumes.findByEngine(host().host.id, workspace.volume);
  if (!record) throw new Error("the workspace mount has no volume record");
  return { id: record.id, name: record.name };
}

const filePath = (volumeId: string, path: string) =>
  `/api/volumes/${volumeId}/files/content?path=${encodeURIComponent(path)}`;

function execAs(token: string | undefined, boxId: string) {
  return call(harness.base, `/api/boxes/${boxId}/exec`, { token, body: { argv: ["true"] } });
}

function readAs(token: string, volumeId: string, path: string) {
  return call(harness.base, filePath(volumeId, path), { token });
}

function writeAs(token: string | undefined, volumeId: string, path: string, content: string) {
  return call(harness.base, `/api/volumes/${volumeId}/files/content`, {
    token,
    method: "PUT",
    body: { path, content },
  });
}

describe("the owner's file and exec access", () => {
  test("the owner reads, writes and execs on a box it made", async () => {
    const box = await ownerBox("owned");
    const workspace = workspaceOf(box.boxId);

    expect((await writeAs(undefined, workspace.id, "a.txt", "hello")).status).toBe(200);
    const read = await readAs(TEST_KEY, workspace.id, "a.txt");
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({ content: "hello" });
    expect((await execAs(undefined, box.boxId)).status).toBe(200);
  });
});

describe("an exec token on a box it may use", () => {
  test("reads and writes every mount of the box, and execs in it", async () => {
    const box = await ownerBox("owned");
    const workspace = workspaceOf(box.boxId);
    const exec = mint(harness.app, { name: "exec", scopes: ["exec"], boxes: { type: "all" } });

    expect((await writeAs(exec.secret, workspace.id, "a.txt", "from exec")).status).toBe(200);
    const read = await readAs(exec.secret, workspace.id, "a.txt");
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({ content: "from exec" });
    expect((await execAs(exec.secret, box.boxId)).status).toBe(200);
  });

  test("cannot exec in a box another principal made, and its volume is out of reach without a grant", async () => {
    const box = await ownerBox("theirs");
    const workspace = workspaceOf(box.boxId);
    const mineOnly = mint(harness.app, {
      name: "mine-only",
      scopes: ["exec"],
      boxes: { type: "created-by-me" },
      volumes: { type: "list", ids: [] },
    });

    expect(refused(await execAs(mineOnly.secret, box.boxId))).toEqual({ status: 403, key: "box_out_of_scope" });
    expect(refused(await readAs(mineOnly.secret, workspace.id, "a.txt"))).toEqual({
      status: 403,
      key: "volume_not_granted",
    });
    expect(refused(await writeAs(mineOnly.secret, workspace.id, "a.txt", "nope"))).toEqual({
      status: 403,
      key: "volume_not_granted",
    });
  });
});

describe("a files:read token on a box it may use", () => {
  test("reads a mount but is refused a write and an exec", async () => {
    const box = await ownerBox("owned");
    const workspace = workspaceOf(box.boxId);
    expect((await writeAs(undefined, workspace.id, "a.txt", "owner wrote this")).status).toBe(200);

    const reader = mint(harness.app, {
      name: "reader",
      scopes: ["files:read"],
      boxes: { type: "all" },
      volumes: { type: "all" },
    });
    const read = await readAs(reader.secret, workspace.id, "a.txt");
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({ content: "owner wrote this" });

    expect(refused(await writeAs(reader.secret, workspace.id, "b.txt", "nope"))).toEqual({
      status: 403,
      key: "operation_forbidden",
    });
    expect(refused(await execAs(reader.secret, box.boxId))).toEqual({ status: 403, key: "operation_forbidden" });
  });
});

describe("a files:write token without exec", () => {
  test("writes a mount but is refused a read and an exec", async () => {
    const box = await ownerBox("owned");
    const workspace = workspaceOf(box.boxId);
    const writer = mint(harness.app, {
      name: "writer",
      scopes: ["files:write"],
      boxes: { type: "all" },
      volumes: { type: "all" },
    });

    expect((await writeAs(writer.secret, workspace.id, "b.txt", "from writer")).status).toBe(200);
    expect(refused(await readAs(writer.secret, workspace.id, "b.txt"))).toEqual({
      status: 403,
      key: "operation_forbidden",
    });
    expect(refused(await execAs(writer.secret, box.boxId))).toEqual({ status: 403, key: "operation_forbidden" });
  });
});

describe("a volume the token may not see", () => {
  test("neither reads nor writes it, even with both file scopes", async () => {
    const shared = await createVolume(host(), { name: "private", role: null, createdBy: "owner" });
    const other = mint(harness.app, {
      name: "other-token",
      scopes: ["files:read", "files:write"],
      boxes: { type: "all" },
      volumes: { type: "list", ids: [] },
    });

    expect(refused(await readAs(other.secret, shared.id, "a.txt"))).toEqual({
      status: 403,
      key: "volume_not_granted",
    });
    expect(refused(await writeAs(other.secret, shared.id, "a.txt", "nope"))).toEqual({
      status: 403,
      key: "volume_not_granted",
    });
  });
});
