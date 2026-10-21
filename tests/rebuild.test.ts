import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { Server } from "bun";

import type { App } from "../src/app";
import type { AuditNote } from "../src/events/types";
import type { HostCtx } from "../src/host/registry";
import type { LabelKeys } from "../src/labels";
import { AppError } from "../src/lib/errors";
import { RuntimeError } from "../src/runtime";
import { startServer } from "../src/server";
import * as boxes from "../src/services/boxes";
import { rebuildBox } from "../src/services/rebuild";
import { nameFromContainer } from "../src/specs/claim";
import type { TerminalData } from "../src/ws/terminal";
import { createTestApp, rejectionOf, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

const MB = 1024 * 1024;

let runtime: FakeRuntime;
let app: App;
let host: HostCtx;
let keys: LabelKeys;
let restoreLogs: () => void;

beforeAll(() => {
  restoreLogs = silenceLogs();
});
afterAll(() => restoreLogs());

beforeEach(() => {
  const created = createTestApp({ labelPrefix: "mbtest" });
  app = created.app;
  runtime = created.runtime;
  host = app.hosts.get();
  keys = host.keys;
  runtime.seedImage(host.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
});

const newBox = (name: string) => boxes.createBox(host, { name, cpus: 1, memoryMb: 256 });
const formal = (id: string) => `mbtest-${id}`;
const short = (id: string) => id.replace(/^sha256:/, "").slice(0, 12);

/** The template changes a refused rebuild previews. Fails unless the call is refused for want of confirm. */
async function previewChanges(promise: Promise<unknown>): Promise<{ field: string; from: string; to: string }[]> {
  const error = await rejectionOf(promise);
  expect(error).toBeInstanceOf(AppError);
  if (!(error instanceof AppError)) throw new Error("expected AppError");
  expect(error).toMatchObject({ status: 409, code: "confirmation_required", key: "rebuild_confirm_required" });
  return (error.details as { preview: { changes: { field: string; from: string; to: string }[] } }).preview.changes;
}

describe("rebuild preview", () => {
  test("a change without confirm returns the docker diff and does not create a container", async () => {
    const box = await newBox("alpha");
    runtime.seedDiff(box.id, [{ path: "/etc/motd", kind: "modified" }]);
    const creates = runtime.callsTo("createContainer").length;

    const error = await rejectionOf(rebuildBox(host, box.id, box.revision, { profile: "strict" }, false));

    expect(error).toBeInstanceOf(AppError);
    if (!(error instanceof AppError)) throw new Error("expected AppError");
    expect(error).toMatchObject({
      status: 409,
      code: "confirmation_required",
      key: "rebuild_confirm_required",
    });
    const preview = error.details as {
      preview: {
        diff: unknown;
        keeps: string[];
        loses: string[];
        changes: { field: string; from: string; to: string }[];
        containerName: { from: string; to: string };
        revision: { current: number; next: number };
      };
    };
    expect(preview.preview.diff).toEqual([{ path: "/etc/motd", kind: "modified" }]);
    expect(preview.preview.keeps).toEqual(["volumes", "id", "name", "history"]);
    expect(preview.preview.loses).toEqual(["writableLayer", "processes", "ip"]);
    expect(preview.preview.containerName).toEqual({ from: "mbtest-alpha", to: formal(box.boxId) });
    expect(preview.preview.revision).toEqual({ current: 1, next: 2 });
    expect(preview.preview.changes).toContainEqual({ field: "profile", from: "standard", to: "strict" });
    expect(preview.preview.changes).toContainEqual({
      field: "containerName",
      from: "mbtest-alpha",
      to: formal(box.boxId),
    });
    expect(host.specs.read(box.boxId)?.revision).toBe(1);
    expect(host.specs.read(box.boxId)?.profile).toBe("standard");
    expect(runtime.callsTo("createContainer")).toHaveLength(creates);
    expect(runtime.containers.size).toBe(1);
  });

  test("a diff that cannot be read fails the preview instead of showing an empty one", async () => {
    const box = await newBox("alpha");
    runtime.fail("containerDiff", new RuntimeError("engine", "docker diff failed", "docker diff failed"));
    const creates = runtime.callsTo("createContainer").length;

    const error = await rejectionOf(rebuildBox(host, box.id, box.revision, { profile: "strict" }, false));

    expect(error).toBeInstanceOf(RuntimeError);
    expect(error).toMatchObject({ kind: "engine" });
    expect(runtime.callsTo("createContainer")).toHaveLength(creates);
    expect(runtime.containers.get(box.id)?.name).toBe("mbtest-alpha");
    expect(host.specs.read(box.boxId)?.revision).toBe(1);
  });

  test("an identical request and a missing image are refused before a container is created", async () => {
    const box = await newBox("alpha");
    const same = await rejectionOf(rebuildBox(host, box.id, box.revision, { profile: "standard" }, true));
    expect(same).toMatchObject({ status: 400, key: "rebuild_empty" });

    const missing = await rejectionOf(rebuildBox(host, box.id, box.revision, { template: "missing:1" }, false));
    expect(missing).toMatchObject({ status: 400, key: "template_image_missing", details: { field: "template" } });
    expect(runtime.callsTo("containerDiff")).toHaveLength(0);
    expect(runtime.containers.size).toBe(1);
  });

  test("a stale If-Match is a 412", async () => {
    const box = await newBox("alpha");
    const error = await rejectionOf(rebuildBox(host, box.id, box.revision + 5, { profile: "strict" }, true));
    expect(error).toMatchObject({ status: 412, key: "revision_mismatch" });
    expect(runtime.containers.size).toBe(1);
  });
});

describe("rebuild swap", () => {
  test("confirm renames to prefix-id, keeps the volume and the stable id, and drops the old container", async () => {
    const box = await newBox("alpha");
    const rebuilt = await rebuildBox(host, box.boxId, box.revision, { profile: "strict" }, true);

    expect(rebuilt.boxId).toBe(box.boxId);
    expect(rebuilt.name).toBe("alpha");
    expect(rebuilt.id).not.toBe(box.id);
    expect(rebuilt.containerName).toBe(formal(box.boxId));
    expect(rebuilt.profile).toBe("strict");
    expect(rebuilt.revision).toBe(2);
    expect(rebuilt.volume).toBe(box.volume);
    expect(rebuilt.running).toBe(true);
    expect(rebuilt.drift).toEqual([]);
    expect(rebuilt.env).toEqual([]);
    expect(runtime.containers.has(box.id)).toBe(false);
    expect(runtime.containers.size).toBe(1);

    const container = runtime.containers.get(rebuilt.id);
    expect(container?.name).toBe(formal(box.boxId));
    expect(container?.labels[keys.id]).toBe(box.boxId);
    expect(container?.labels[keys.name]).toBe("alpha");
    expect(container?.labels[keys.profile]).toBe("strict");
    expect(container?.spec.restart).toBe("no");
    expect(container?.spec.mounts).toContainEqual({ source: box.volume, target: "/workspace", mode: "rw" });
    expect(container?.cpus).toBe(1);
    expect(container?.memoryBytes).toBe(256 * MB);
    expect(container?.pidsLimit).toBe(1024);
    expect(runtime.volumes.has(box.volume)).toBe(true);

    const spec = host.specs.read(box.boxId);
    expect(spec?.history).toHaveLength(1);
    expect(spec?.history[0]).toMatchObject({
      revision: 1,
      spec: { profile: "standard", containerName: "mbtest-alpha" },
    });
    expect(spec?.history[0]?.spec).not.toHaveProperty("history");
    expect(spec?.containerId).toBe(rebuilt.id);
  });

  test("a failed start restores the old container, the spec and a volume this attempt created", async () => {
    const box = await newBox("alpha");
    const volumesBefore = [...runtime.volumes.keys()].toSorted();
    const recordsBefore = host.volumes.list().map((volume) => volume.id);
    runtime.fail("startContainer", new RuntimeError("engine", "boom", "boom"));
    const error = await rejectionOf(
      rebuildBox(
        host,
        box.id,
        box.revision,
        {
          profile: "strict",
          mounts: [
            { volume: box.volume, path: "/workspace", mode: "rw" },
            { volume: "extra", path: "/data", mode: "ro" },
          ],
        },
        true,
      ),
    );

    expect(error).toBeInstanceOf(RuntimeError);
    expect(error).toMatchObject({ kind: "engine" });
    const owned = [...runtime.containers.values()].filter((container) => container.labels[keys.id] === box.boxId);
    expect(owned).toHaveLength(1);
    expect(owned[0]?.name).toBe("mbtest-alpha");
    expect(owned[0]?.running).toBe(true);
    expect(host.specs.read(box.boxId)?.revision).toBe(1);
    expect(host.specs.read(box.boxId)?.profile).toBe("standard");
    expect(host.specs.read(box.boxId)?.containerId).toBe(box.id);
    expect(host.volumes.resolve("extra", host.host.id)).toBeNull();
    expect([...runtime.volumes.keys()].toSorted()).toEqual(volumesBefore);
    expect(host.volumes.list().map((volume) => volume.id)).toEqual(recordsBefore);
    expect(runtime.volumes.has(box.volume)).toBe(true);
  });

  test("a network other than the box network is refused before the swap starts", async () => {
    const box = await newBox("alpha");
    const creates = runtime.callsTo("createContainer").length;
    const error = await rejectionOf(rebuildBox(host, box.id, box.revision, { network: "missingnet" }, true));
    expect(error).toMatchObject({ status: 403, key: "network_not_managed", params: { network: "missingnet" } });
    expect(runtime.callsTo("createContainer")).toHaveLength(creates);
    expect(runtime.containers.get(box.id)?.name).toBe("mbtest-alpha");
    expect(runtime.containers.get(box.id)?.running).toBe(true);
    expect(host.specs.read(box.boxId)?.network).toBe(host.security.network);
    expect(host.specs.read(box.boxId)?.revision).toBe(1);
  });

  test("mounts, env and template are applied, and a removed volume is kept", async () => {
    const box = await newBox("alpha");
    runtime.seedImage("other:1");
    const rebuilt = await rebuildBox(
      host,
      box.id,
      box.revision,
      {
        template: "other:1",
        mounts: [{ volume: "extra", path: "/data", mode: "ro" }],
        env: [
          { name: "FOO", value: "bar" },
          { name: "TOKEN", secretRef: "vault" },
        ],
      },
      true,
    );

    const extra = host.volumes.resolve("extra", host.host.id);
    if (!extra) throw new Error("expected a record for extra");
    expect(extra).toMatchObject({ name: "extra", ownership: "independent", role: null, engineName: extra.id });
    expect(rebuilt.template).toBe("other:1");
    expect(rebuilt.image).toBe("other:1");
    expect(rebuilt.network).toBe("mbtest-boxes");
    expect(rebuilt.mounts.map(({ volume, path, mode }) => ({ volume, path, mode }))).toEqual([
      { volume: extra.engineName, path: "/data", mode: "ro" },
    ]);
    expect(rebuilt.env).toEqual([
      { name: "FOO", value: "bar" },
      { name: "TOKEN", secretRef: "vault" },
    ]);
    expect(rebuilt.drift).toEqual([]);
    expect(runtime.volumes.has(box.volume)).toBe(true);
    expect(runtime.volumes.has(extra.engineName)).toBe(true);
    const container = runtime.containers.get(rebuilt.id);
    expect(container?.spec.env).toEqual(["FOO=bar"]);
    expect(container?.spec.mounts).toEqual([{ source: extra.engineName, target: "/data", mode: "ro" }]);
    expect(JSON.stringify(container?.labels)).not.toContain("bar");
    expect(JSON.stringify(container?.labels)).not.toContain("vault");
  });

  test("the swap stops the old container with the host's configured stop timeout", async () => {
    const custom = createTestApp({ labelPrefix: "mbtest", stopTimeoutSec: 12 });
    const customHost = custom.app.hosts.get();
    custom.runtime.seedImage(customHost.baseTemplateTag, { [customHost.keys.template]: "true" });
    const box = await boxes.createBox(customHost, { name: "alpha", cpus: 1, memoryMb: 256 });
    await rebuildBox(customHost, box.id, box.revision, { profile: "strict" }, true);
    expect(custom.runtime.callsTo("stopContainer").map((call) => call.args[1])).toEqual([{ timeoutSec: 12 }]);
  });

  test("a stopped box is started as a health check and then stopped again", async () => {
    const running = await newBox("alpha");
    const stopped = await boxes.stopBox(host, running.id);
    const rebuilt = await rebuildBox(host, stopped.boxId, stopped.revision, { profile: "strict" }, true);
    expect(rebuilt.running).toBe(false);
    expect(rebuilt.desired).toBe("stopped");
    expect(rebuilt.revision).toBe(stopped.revision + 1);
    expect(runtime.containers.get(rebuilt.id)?.running).toBe(false);
  });

  test("a second rebuild keeps the id name, and an in-place rename is put back on the next rebuild", async () => {
    const box = await newBox("alpha");
    const first = await rebuildBox(host, box.id, box.revision, { profile: "strict" }, true);
    const renamed = await boxes.updateBox(host, first.boxId, first.revision, { name: "beta" });
    expect(renamed.containerName).toBe("mbtest-beta");

    const preview = await rejectionOf(rebuildBox(host, renamed.boxId, renamed.revision, { profile: "relaxed" }, false));
    if (!(preview instanceof AppError)) throw new Error("expected AppError");
    const changes = (preview.details as { preview: { changes: { field: string }[] } }).preview.changes;
    expect(changes.map((change) => change.field)).toContain("containerName");

    const second = await rebuildBox(host, renamed.boxId, renamed.revision, { profile: "relaxed" }, true);
    expect(second.name).toBe("beta");
    expect(second.containerName).toBe(formal(second.boxId));
    expect(second.profile).toBe("relaxed");

    const again = await rejectionOf(
      rebuildBox(host, second.boxId, second.revision, { env: [{ name: "FOO", value: "bar" }] }, false),
    );
    if (!(again instanceof AppError)) throw new Error("expected AppError");
    const next = (again.details as { preview: { changes: { field: string }[]; containerName: { to: string } } })
      .preview;
    expect(next.changes.map((change) => change.field)).not.toContain("containerName");
    expect(next.containerName.to).toBe(formal(second.boxId));
  });

  test("a running leftover with the scratch name blocks the rebuild", async () => {
    const box = await newBox("alpha");
    runtime.seedContainer({
      image: host.baseTemplateTag,
      name: `${formal(box.boxId)}-new`,
      running: true,
      labels: { [keys.box]: "true", [keys.name]: "stranger", [keys.id]: "bx_otherbox" },
    });
    const error = await rejectionOf(rebuildBox(host, box.id, box.revision, { profile: "strict" }, true));
    expect(error).toMatchObject({ status: 409, key: "rebuild_name_conflict" });
    expect(runtime.containers.get(box.id)?.name).toBe("mbtest-alpha");
    expect(host.specs.read(box.boxId)?.revision).toBe(1);
  });

  test("a stopped leftover from this box is removed", async () => {
    const box = await newBox("alpha");
    const leftover = runtime.seedContainer({
      image: host.baseTemplateTag,
      name: `${formal(box.boxId)}-new`,
      running: false,
      labels: { [keys.box]: "true", [keys.name]: "alpha", [keys.id]: box.boxId },
    });
    await rebuildBox(host, box.id, box.revision, { profile: "strict" }, true);
    expect(runtime.containers.has(leftover)).toBe(false);
  });

  test("a lost spec after a rebuild keeps the current name and does not rename the container", async () => {
    const box = await newBox("alpha");
    const rebuilt = await rebuildBox(host, box.id, box.revision, { profile: "strict" }, true);
    host.specs.remove(rebuilt.boxId);
    const renames = runtime.callsTo("renameContainer").length;

    const recovered = await boxes.getBox(host, rebuilt.id);
    expect(recovered.name).toBe("alpha");
    expect(recovered.boxId).toBe(rebuilt.boxId);
    expect(recovered.containerName).toBe(formal(rebuilt.boxId));
    expect(runtime.containers.get(recovered.id)?.name).toBe(formal(rebuilt.boxId));
    expect(runtime.callsTo("renameContainer")).toHaveLength(renames);
  });
});

describe("rebuild onto a moved tag", () => {
  test("a moved tag is a template change in the preview, and nothing is created", async () => {
    const box = await newBox("alpha");
    const running = runtime.containers.get(box.id)?.imageId ?? "";
    const moved = runtime.moveTag(host.baseTemplateTag);
    const creates = runtime.callsTo("createContainer").length;

    const changes = await previewChanges(
      rebuildBox(host, box.id, box.revision, { template: host.baseTemplateTag }, false),
    );
    expect(changes).toContainEqual({
      field: "template",
      from: `${host.baseTemplateTag} (${short(running)})`,
      to: `${host.baseTemplateTag} (${short(moved)})`,
    });
    expect(runtime.callsTo("createContainer")).toHaveLength(creates);
    expect(runtime.containers.get(box.id)?.running).toBe(true);
    expect(host.specs.read(box.boxId)?.template.digest).toBe(running);
  });

  test("confirm runs the new container from the moved image and keeps the tag as the template", async () => {
    const box = await newBox("alpha");
    const moved = runtime.moveTag(host.baseTemplateTag);

    const rebuilt = await rebuildBox(host, box.boxId, box.revision, { template: host.baseTemplateTag }, true);

    expect(rebuilt.template).toBe(host.baseTemplateTag);
    expect(rebuilt.image).toBe(host.baseTemplateTag);
    expect(rebuilt.revision).toBe(2);
    expect(rebuilt.drift).toEqual([]);
    expect(runtime.containers.get(rebuilt.id)?.imageId).toBe(moved);
    expect(runtime.containers.get(rebuilt.id)?.labels[keys.digest]).toBe(moved);
    expect(runtime.containers.has(box.id)).toBe(false);
    expect(host.specs.read(box.boxId)?.template).toEqual({
      ref: host.baseTemplateTag,
      image: host.baseTemplateTag,
      digest: moved,
    });
  });

  test("once the box runs the moved image, the same request is rebuild_empty", async () => {
    const box = await newBox("alpha");
    runtime.moveTag(host.baseTemplateTag);
    const rebuilt = await rebuildBox(host, box.boxId, box.revision, { template: host.baseTemplateTag }, true);

    const again = await rejectionOf(
      rebuildBox(host, rebuilt.boxId, rebuilt.revision, { template: host.baseTemplateTag }, true),
    );
    expect(again).toMatchObject({ status: 400, key: "rebuild_empty" });
    expect(host.specs.read(box.boxId)?.revision).toBe(2);
  });

  test("a template named in the request is the change, and the moved tag is not listed", async () => {
    const box = await newBox("alpha");
    runtime.moveTag(host.baseTemplateTag);
    runtime.seedImage("other:1");

    const changes = await previewChanges(rebuildBox(host, box.id, box.revision, { template: "other:1" }, false));
    expect(changes.filter((change) => change.field === "template")).toEqual([
      { field: "template", from: host.baseTemplateTag, to: "other:1" },
    ]);
  });

  test("a tag that was removed is not a move, so the same request changes nothing", async () => {
    const box = await newBox("alpha");
    await runtime.removeImage(host.baseTemplateTag, { force: true });

    const error = await rejectionOf(rebuildBox(host, box.id, box.revision, { template: host.baseTemplateTag }, true));
    expect(error).toMatchObject({ status: 400, key: "rebuild_empty" });
    expect(runtime.containers.get(box.id)?.running).toBe(true);
    expect(host.specs.read(box.boxId)?.revision).toBe(1);
  });

  test("a box made from a snapshot follows no tag, so a moved snapshot tag changes nothing", async () => {
    const snapshot = "mbtest-snap:nightly";
    runtime.seedImage(snapshot, { [keys.snapshot]: "true" });
    const box = await boxes.createBox(host, {
      name: "alpha",
      image: snapshot,
      templateLabel: `snapshot:${snapshot}`,
      cpus: 1,
      memoryMb: 256,
    });
    runtime.moveTag(snapshot, { [keys.snapshot]: "true" });

    const error = await rejectionOf(rebuildBox(host, box.id, box.revision, { template: `snapshot:${snapshot}` }, true));
    expect(error).toMatchObject({ status: 400, key: "rebuild_empty" });
    expect(runtime.callsTo("createContainer")).toHaveLength(1);
  });

  test("a tag that moves again while the new container is created is refused and rolled back", async () => {
    const box = await newBox("alpha");
    runtime.moveTag(host.baseTemplateTag);
    const create = runtime.createContainer.bind(runtime);
    spyOn(runtime, "createContainer").mockImplementationOnce(async (spec) => {
      runtime.moveTag(host.baseTemplateTag);
      return create(spec);
    });

    const error = await rejectionOf(rebuildBox(host, box.id, box.revision, { template: host.baseTemplateTag }, true));
    expect(error).toMatchObject({ status: 502, key: "docker_error" });
    expect(runtime.containers.size).toBe(1);
    expect(runtime.containers.get(box.id)?.running).toBe(true);
    expect(host.specs.read(box.boxId)?.containerId).toBe(box.id);
    expect(host.specs.read(box.boxId)?.revision).toBe(1);
  });
});

describe("rebuild history and names", () => {
  test("in-place updates keep the newest 20 revisions", async () => {
    let box = await newBox("alpha");
    for (let i = 0; i < 21; i++) {
      box = await boxes.updateBox(host, box.boxId, box.revision, { cpus: i % 2 === 0 ? 2 : 1 });
    }
    const history = host.specs.read(box.boxId)?.history ?? [];
    expect(history).toHaveLength(20);
    expect(history[0]?.revision).toBe(box.revision - 1);
    expect(history.at(-1)?.revision).toBe(box.revision - 20);
  });

  test("a container named with the stable id keeps the name label", () => {
    expect(nameFromContainer("mbtest", "mbtest-bx_abcdefgh", "alpha", "bx_abcdefgh")).toBe("alpha");
    expect(nameFromContainer("mbtest", "mbtest-bx_abcdefgh", "alpha")).toBe("bx_abcdefgh");
    expect(nameFromContainer("mbtest", "mbtest-bx_abcdefgh", "alpha", "bx_zzzzzzzz")).toBe("bx_abcdefgh");
    expect(nameFromContainer("mbtest", "mbtest-bx_abcdefgh", 'dev"$HOME', "bx_abcdefgh")).toBe('dev"$HOME');
  });
});

describe("rebuild over HTTP", () => {
  test("preview is a 409, confirm returns the new box, and a differing PATCH does not apply labels", async () => {
    const box = await newBox("alpha");
    runtime.seedDiff(box.id, [{ path: "/etc/motd", kind: "modified" }]);
    const server: Server<TerminalData> = startServer(app);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const headers = {
        authorization: `Bearer ${TEST_KEY}`,
        "content-type": "application/json",
        "if-match": String(box.revision),
      };
      const missing = await fetch(`${base}/api/boxes/${box.id}/rebuild`, {
        method: "POST",
        headers: { authorization: headers.authorization, "content-type": headers["content-type"] },
        body: JSON.stringify({ profile: "strict" }),
      });
      expect(missing.status).toBe(428);

      const beforePreview = app.activity.list().length;
      const preview = await fetch(`${base}/api/boxes/${box.id}/rebuild`, {
        method: "POST",
        headers,
        body: JSON.stringify({ profile: "strict" }),
      });
      expect(preview.status).toBe(409);
      const previewBody = (await preview.json()) as {
        error: { code: string; details: { preview: { diff: unknown } } };
      };
      expect(previewBody.error.code).toBe("confirmation_required");
      expect(previewBody.error.details.preview.diff).toEqual([{ path: "/etc/motd", kind: "modified" }]);
      expect(app.activity.list()).toHaveLength(beforePreview);

      const patched = await fetch(`${base}/api/boxes/${box.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ labels: { team: "lab" }, profile: "strict" }),
      });
      expect(patched.status).toBe(409);
      expect(host.specs.read(box.boxId)?.labels).toEqual({});

      const applied = await fetch(`${base}/api/boxes/${box.id}/rebuild`, {
        method: "POST",
        headers,
        body: JSON.stringify({ profile: "strict", confirm: true }),
      });
      expect(applied.status).toBe(200);
      expect(applied.headers.get("etag")).toBe('"2"');
      const body = (await applied.json()) as { box: { id: string; boxId: string; profile: string; env: unknown[] } };
      expect(body.box.profile).toBe("strict");
      expect(body.box.boxId).toBe(box.boxId);
      expect(body.box.env).toEqual([]);
      expect(body.box.id).not.toBe(box.id);
      expect(app.activity.list()[0]).toMatchObject({ action: "box.rebuild", target: "alpha", ok: true });

      const old = await fetch(`${base}/api/boxes/${box.id}`, { headers: { authorization: headers.authorization } });
      expect(old.status).toBe(404);
      const byName = await fetch(`${base}/api/boxes/alpha`, { headers: { authorization: headers.authorization } });
      expect(byName.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("an env value is not stored on the audit event", async () => {
    const box = await newBox("alpha");
    const before = app.events.head();
    await app.operations.run(
      "box.rebuild",
      { host, principal: { type: "owner", id: "owner", name: "owner" }, source: "rest", events: app.events },
      {
        id: box.id,
        confirm: true,
        expectedRevision: "1",
        env: [{ name: "TOKEN", value: "supersecret", secretRef: "vault" }],
      },
    );
    const [event] = app.events.after(before, {}, 10);
    expect(event?.detail).toMatchObject({ env: ["TOKEN"], confirm: true });
    expect(JSON.stringify(event)).not.toContain("supersecret");
    expect(JSON.stringify(event)).not.toContain("vault");
  });
});

describe("rebuild aligns the workspace root", () => {
  const DEV_LABELS = { "minibox.template.uid": "1000", "minibox.template.gid": "1000" };
  const ROOT = { uid: 0, gid: 0 };
  const DEV = { uid: 1000, gid: 1000 };
  /** A box from a dev template whose workspace root is owned by root, as a volume left by an earlier box is. */
  async function rootOwnedBox() {
    runtime.seedImage("dev:1", DEV_LABELS);
    const box = await boxes.createBox(host, { name: "alpha", cpus: 1, memoryMb: 256, image: "dev:1" });
    runtime.seedVolumeOwner(box.volume, ROOT);
    return box;
  }

  test("a rebuild sets the root to the template's owner after the old container stops and before it is renamed", async () => {
    const box = await rootOwnedBox();
    const notes: AuditNote[] = [];
    const before = runtime.calls.length;

    await rebuildBox(host, box.boxId, box.revision, { profile: "strict" }, true, (note) => notes.push(note));

    const ops = runtime.ops().slice(before);
    expect(ops.indexOf("stopContainer")).toBeGreaterThan(-1);
    expect(ops.indexOf("volumeRootOwner")).toBeGreaterThan(ops.indexOf("stopContainer"));
    expect(ops.indexOf("setVolumeRootOwner")).toBeGreaterThan(ops.indexOf("volumeRootOwner"));
    expect(ops.indexOf("renameContainer")).toBeGreaterThan(ops.indexOf("setVolumeRootOwner"));
    expect(runtime.volumeOwners.get(box.volume)).toEqual(DEV);
    expect(notes.map((note) => [note.op, note.status])).toEqual([["volume.chown", "ok"]]);
  });

  test("a rollback puts the owner back through the old container's image, before the old container starts again", async () => {
    const box = await rootOwnedBox();
    const oldImage = runtime.containers.get(box.id)?.imageId;
    const newImage = runtime.seedImage("dev:2", DEV_LABELS);
    const notes: AuditNote[] = [];
    runtime.fail("startContainer", new RuntimeError("engine", "boom", "boom"));
    const before = runtime.calls.length;

    const error = await rejectionOf(
      rebuildBox(host, box.boxId, box.revision, { template: "dev:2" }, true, (note) => notes.push(note)),
    );

    expect(error).toMatchObject({ kind: "engine" });
    expect(runtime.callsTo("setVolumeRootOwner").map((call) => call.args)).toEqual([
      [box.volume, DEV, newImage],
      [box.volume, ROOT, oldImage],
    ]);
    const ops = runtime.ops().slice(before);
    expect(ops.lastIndexOf("setVolumeRootOwner")).toBeLessThan(ops.lastIndexOf("startContainer"));
    expect(runtime.volumeOwners.get(box.volume)).toEqual(ROOT);
    expect(runtime.containers.get(box.id)).toMatchObject({ name: "mbtest-alpha", running: true });
    expect(host.specs.read(box.boxId)).toMatchObject({ revision: 1, containerId: box.id });
    expect(notes.map((note) => note.op)).toEqual(["volume.chown", "volume.chown_undo"]);
  });

  test("a failed alignment rolls the rebuild back and leaves the root and the old container as they were", async () => {
    const box = await rootOwnedBox();
    const notes: AuditNote[] = [];
    runtime.fail("setVolumeRootOwner", new RuntimeError("engine", "chown failed", "chown failed"));

    const error = await rejectionOf(
      rebuildBox(host, box.boxId, box.revision, { profile: "strict" }, true, (note) => notes.push(note)),
    );

    expect(error).toMatchObject({ kind: "engine" });
    expect(runtime.callsTo("setVolumeRootOwner")).toHaveLength(1);
    expect(runtime.volumeOwners.get(box.volume)).toEqual(ROOT);
    expect(runtime.containers.get(box.id)).toMatchObject({ name: "mbtest-alpha", running: true });
    const owned = [...runtime.containers.values()].filter((c) => c.labels[keys.id] === box.boxId);
    expect(owned.map((c) => c.id)).toEqual([box.id]);
    expect(host.specs.read(box.boxId)).toMatchObject({ revision: 1, containerId: box.id });
    expect(notes.map((note) => [note.op, note.status])).toEqual([["volume.chown", "error"]]);
  });

  test("a rebuild onto a read-only workspace makes no owner calls", async () => {
    const box = await rootOwnedBox();
    const before = runtime.calls.length;

    await rebuildBox(
      host,
      box.boxId,
      box.revision,
      { mounts: [{ volume: box.volume, path: "/workspace", mode: "ro" }] },
      true,
    );

    const ops = runtime.ops().slice(before);
    expect(ops).not.toContain("volumeRootOwner");
    expect(ops).not.toContain("setVolumeRootOwner");
    expect(runtime.volumeOwners.get(box.volume)).toEqual(ROOT);
  });

  test("a rebuild from a template that names no owner reads and changes no workspace root", async () => {
    const box = await newBox("alpha");
    const before = runtime.calls.length;

    await rebuildBox(host, box.boxId, box.revision, { profile: "strict" }, true);

    const ops = runtime.ops().slice(before);
    expect(ops).not.toContain("volumeRootOwner");
    expect(ops).not.toContain("setVolumeRootOwner");
  });
});
