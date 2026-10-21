import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { Server } from "bun";

import type { App } from "../src/app";
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
    expect(rebuilt.volume).toBe("mbtest-ws-alpha");
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
    expect(container?.spec.mounts).toEqual([{ source: "mbtest-ws-alpha", target: "/workspace", mode: "rw" }]);
    expect(container?.cpus).toBe(1);
    expect(container?.memoryBytes).toBe(256 * MB);
    expect(container?.pidsLimit).toBe(1024);
    expect(runtime.volumes.has("mbtest-ws-alpha")).toBe(true);

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
    runtime.fail("startContainer", new RuntimeError("engine", "boom", "boom"));
    const error = await rejectionOf(
      rebuildBox(
        host,
        box.id,
        box.revision,
        {
          profile: "strict",
          mounts: [
            { volume: "mbtest-ws-alpha", path: "/workspace", mode: "rw" },
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
    expect(runtime.volumes.has("extra")).toBe(false);
    expect(runtime.volumes.has("mbtest-ws-alpha")).toBe(true);
  });

  test("a missing network rolls the swap back", async () => {
    const box = await newBox("alpha");
    const error = await rejectionOf(rebuildBox(host, box.id, box.revision, { network: "missingnet" }, true));
    expect(error).toBeInstanceOf(RuntimeError);
    expect(error).toMatchObject({ kind: "not_found" });
    expect(runtime.containers.get(box.id)?.name).toBe("mbtest-alpha");
    expect(runtime.containers.get(box.id)?.running).toBe(true);
    expect(host.specs.read(box.boxId)?.network).toBe(host.security.network);
    expect(host.specs.read(box.boxId)?.revision).toBe(1);
  });

  test("mounts, env, network and template are applied, and a removed volume is kept", async () => {
    const box = await newBox("alpha");
    runtime.seedImage("other:1");
    const rebuilt = await rebuildBox(
      host,
      box.id,
      box.revision,
      {
        template: "other:1",
        network: "bridge",
        mounts: [{ volume: "extra", path: "/data", mode: "ro" }],
        env: [
          { name: "FOO", value: "bar" },
          { name: "TOKEN", secretRef: "vault" },
        ],
      },
      true,
    );

    expect(rebuilt.template).toBe("other:1");
    expect(rebuilt.image).toBe("other:1");
    expect(rebuilt.network).toBe("bridge");
    expect(rebuilt.mounts).toEqual([{ volume: "extra", path: "/data", mode: "ro" }]);
    expect(rebuilt.env).toEqual([
      { name: "FOO", value: "bar" },
      { name: "TOKEN", secretRef: "vault" },
    ]);
    expect(rebuilt.drift).toEqual([]);
    expect(runtime.volumes.has("mbtest-ws-alpha")).toBe(true);
    expect(runtime.volumes.has("extra")).toBe(true);
    const container = runtime.containers.get(rebuilt.id);
    expect(container?.spec.env).toEqual(["FOO=bar"]);
    expect(container?.spec.mounts).toEqual([{ source: "extra", target: "/data", mode: "ro" }]);
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

    const again = await rejectionOf(rebuildBox(host, second.boxId, second.revision, { network: "bridge" }, false));
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
