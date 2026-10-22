import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";

import type { Server } from "bun";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import type { LabelKeys } from "../src/labels";
import { AppError } from "../src/lib/errors";
import { RuntimeError } from "../src/runtime";
import { startServer } from "../src/server";
import * as boxes from "../src/services/boxes";
import { reconcileHost } from "../src/services/reconcile";
import { ClaimError, ensureSpec } from "../src/specs/claim";
import { parseRevision } from "../src/specs/revision";
import { RESET_FIELDS } from "../src/specs/types";
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

const mode = (path: string) => statSync(path).mode & 0o777;

describe("spec storage", () => {
  test("a new box is a mode-600 file under a mode-700 boxes directory, with restart policy no", async () => {
    const box = await newBox("alpha");

    expect(box.boxId).toMatch(/^bx_[0-9a-z]+$/);
    expect(box.revision).toBe(1);
    expect(box.desired).toBe("running");
    expect(box.createdBy).toBe("owner");
    expect(box.pids).toBe(1024);
    expect(box.recovery).toBeNull();
    expect(box.drift).toEqual([]);
    expect(box.mounts.map((mount) => ({ path: mount.path, mode: mount.mode, role: mount.role }))).toEqual([
      { path: "/workspace", mode: "rw", role: "workspace" },
      { path: "/home/dev", mode: "rw", role: "home" },
      { path: "/opt/minibox/tools", mode: "ro", role: "tools" },
      { path: "/home/dev/.cache", mode: "rw", role: "cache" },
    ]);
    expect(box.volume).toMatch(/^vol_/);
    expect(box.env).toEqual([]);
    expect(mode(host.specs.dir())).toBe(0o700);
    expect(mode(host.specs.pathFor(box.boxId))).toBe(0o600);
    expect(readdirSync(host.specs.dir()).some((name) => name.endsWith(".tmp"))).toBe(false);

    const container = runtime.containers.get(box.id);
    expect(container?.spec.restart).toBe("no");
    expect(container?.labels).toMatchObject({
      [keys.id]: box.boxId,
      [keys.name]: "alpha",
      [keys.createdBy]: "owner",
      [keys.cpus]: "1",
      [keys.memory]: String(256 * MB),
      [keys.pids]: "1024",
    });
  });

  test("subscribers hear each write and removal after the file has changed, and a failing one does not stop the rest", async () => {
    const box = await newBox("gamma");
    const seen: string[] = [];
    const off = host.specs.subscribe((change) => {
      seen.push(change.kind === "write" ? `write ${change.spec.name}` : `remove ${change.id}`);
    });
    host.specs.subscribe(() => {
      throw new Error("listener failure");
    });
    const last = host.specs.subscribe((change) => {
      if (change.kind === "write") seen.push(`file ${host.specs.read(change.spec.id)?.revision}`);
    });

    await boxes.stopBox(host, box.boxId);
    expect(seen).toEqual(["write gamma", "file 2"]);

    await boxes.deleteBox(host, box.boxId, false);
    expect(seen).toEqual(["write gamma", "file 2", `remove ${box.boxId}`]);

    off();
    last();
    await newBox("delta");
    expect(seen).toHaveLength(3);
  });
});

describe("claim and old routes", () => {
  test("an existing container is claimed without a rename or a label change", async () => {
    const id = runtime.seedContainer({
      image: host.baseTemplateTag,
      name: "mbtest-legacy",
      running: true,
      restart: "unless-stopped",
      cpus: 1,
      memoryBytes: 128 * MB,
      labels: { [keys.box]: "true", [keys.name]: "legacy", [keys.template]: "old:1" },
    });
    const labels = { ...runtime.containers.get(id)?.labels };

    const box = await boxes.getBox(host, id);
    expect(box.name).toBe("legacy");
    expect(box.containerName).toBe("mbtest-legacy");
    expect(box.desired).toBe("running");
    expect(box.recovery).toMatchObject({
      source: "claim",
      needsReset: [...RESET_FIELDS, "createdBy"],
      observedRestart: "unless-stopped",
    });
    expect(runtime.containers.get(id)?.name).toBe("mbtest-legacy");
    expect(runtime.containers.get(id)?.labels).toEqual(labels);
    expect(runtime.callsTo("renameContainer")).toHaveLength(0);
    expect(runtime.callsTo("updateContainer")).toHaveLength(0);

    expect((await boxes.getBox(host, "mbtest-legacy")).boxId).toBe(box.boxId);
    expect((await boxes.getBox(host, box.boxId)).id).toBe(id);
    expect((await boxes.getBox(host, "legacy")).id).toBe(id);
  });

  test("a deleted box's container is not claimed back, even by a read taken before the deletion", async () => {
    const box = await newBox("retired");
    const stale = await runtime.inspectContainer(box.id);

    await boxes.deleteBox(host, box.boxId, false);
    await expect(ensureSpec(host, stale)).rejects.toBeInstanceOf(ClaimError);
    expect(host.specs.list()).toEqual([]);
    expect(host.specs.findByContainer(box.id, box.containerName)).toBeNull();
  });

  test("a lost spec is restored from labels, and mutable fields need to be set again", async () => {
    const box = await newBox("alpha");
    const container = runtime.containers.get(box.id);
    if (!container) throw new Error("box missing");
    container.cpus = 4;
    host.specs.remove(box.boxId);

    const recovered = await boxes.getBox(host, box.id);
    expect(recovered.boxId).toBe(box.boxId);
    expect(recovered.cpus).toBe(4);
    expect(recovered.recovery).toMatchObject({
      source: "degraded",
      needsReset: [...RESET_FIELDS],
    });
    expect(recovered.recovery?.needsReset).not.toContain("createdBy");
    expect(host.specs.read(box.boxId)?.createdResources.cpus).toBe(1);
    expect(host.specs.read(box.boxId)?.resources.cpus).toBe(4);
    expect(container.labels[keys.id]).toBe(box.boxId);
    expect(container.name).toBe("mbtest-alpha");
  });

  test("a container whose id label already belongs to another spec gets a new id", async () => {
    const box = await newBox("alpha");
    const other = runtime.seedContainer({
      image: host.baseTemplateTag,
      name: "mbtest-other",
      running: true,
      labels: { [keys.box]: "true", [keys.name]: "other", [keys.id]: box.boxId },
    });

    const claimed = await boxes.getBox(host, other);
    expect(claimed.boxId).not.toBe(box.boxId);
    expect(host.specs.read(box.boxId)?.containerId).toBe(box.id);
    expect(runtime.containers.get(other)?.labels[keys.id]).toBe(box.boxId);
  });

  test("two containers that would share a name do not fail the whole list", async () => {
    runtime.seedContainer({
      image: host.baseTemplateTag,
      name: "mbtest-dup",
      labels: { [keys.box]: "true", [keys.name]: "dup" },
    });
    runtime.seedContainer({
      image: host.baseTemplateTag,
      name: "plain-dup",
      labels: { [keys.box]: "true", [keys.name]: "dup" },
    });

    expect((await boxes.listBoxes(host)).map((box) => box.name)).toEqual(["dup"]);
  });

  test("an illegal name label is kept, and a renamed container keeps the suffix", async () => {
    const quoted = runtime.seedContainer({
      image: host.baseTemplateTag,
      name: "mbtest-dev",
      labels: { [keys.box]: "true", [keys.name]: 'dev"$HOME' },
    });
    expect((await boxes.getBox(host, quoted)).name).toBe('dev"$HOME');

    const renamed = runtime.seedContainer({
      image: host.baseTemplateTag,
      name: "mbtest-beta",
      labels: { [keys.box]: "true", [keys.name]: "alpha" },
    });
    const box = await boxes.getBox(host, renamed);
    expect(box.name).toBe("beta");
    expect(host.specs.read(box.boxId)?.createdName).toBe("alpha");
  });
});

describe("in-place updates", () => {
  test("cpus, pids and a rename do not change container labels", async () => {
    const box = await newBox("alpha");
    const labels = { ...runtime.containers.get(box.id)?.labels };

    const updated = await boxes.updateBox(host, box.id, box.revision, { cpus: 2, pids: 256, name: "beta" });
    const container = runtime.containers.get(box.id);
    expect(updated).toMatchObject({
      name: "beta",
      cpus: 2,
      pids: 256,
      revision: box.revision + 1,
      volume: box.volume,
      containerName: "mbtest-beta",
    });
    expect(container?.labels).toEqual(labels);
    expect(container?.name).toBe("mbtest-beta");
    expect(container?.spec.hostname).toBe("alpha");
    expect(labels[keys.name]).toBe("alpha");
    const history = host.specs.read(box.boxId)?.history;
    expect(history).toHaveLength(1);
    expect(history?.[0]).toMatchObject({ revision: box.revision, spec: { name: "alpha" } });
    expect(history?.[0]?.spec).not.toHaveProperty("history");
  });

  test("an idle timeout stays in the spec and does not call docker update", async () => {
    const box = await newBox("alpha");
    const before = runtime.callsTo("updateContainer").length;

    const updated = await boxes.updateBox(host, box.boxId, box.revision, { idleTimeoutSec: 30, ttlSec: null });
    expect(updated.idleTimeoutSec).toBe(30);
    expect(updated.ttlSec).toBeNull();
    expect(runtime.callsTo("updateContainer").length).toBe(before);
  });

  test("a stale revision is rejected and a missing If-Match is a 428", async () => {
    const box = await newBox("alpha");
    const stale = await rejectionOf(boxes.updateBox(host, box.id, box.revision + 5, { cpus: 2 }));
    expect(stale).toMatchObject({
      status: 412,
      code: "precondition_failed",
      key: "revision_mismatch",
      details: { revision: box.revision, expected: box.revision + 5 },
    });
    expect(runtime.containers.get(box.id)?.cpus).toBe(1);

    const server: Server<TerminalData> = startServer(app);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const headers = { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/json" };
      const missing = await fetch(`${base}/api/boxes/${box.id}/resources`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ cpus: 2 }),
      });
      expect(missing.status).toBe(428);
      expect(await missing.json()).toMatchObject({
        error: { code: "precondition_required", key: "revision_required" },
      });

      runtime.seedImage("other:1");
      const quoted = await fetch(`${base}/api/boxes/${box.id}`, {
        method: "PATCH",
        headers: { ...headers, "if-match": `W/"${box.revision}"` },
        body: JSON.stringify({ labels: { team: "lab" }, template: "other:1" }),
      });
      expect(quoted.status).toBe(409);
      const denied = (await quoted.json()) as { error: { code: string; details?: { preview?: unknown } } };
      expect(denied.error.code).toBe("confirmation_required");
      expect(denied.error.details?.preview).toBeTruthy();
      expect(runtime.callsTo("containerDiff").length).toBeGreaterThan(0);
      expect(host.specs.read(box.boxId)?.labels).toEqual({});
      expect(runtime.containers.get(box.id)?.spec.image).toBe(host.baseTemplateTag);

      const applied = await fetch(`${base}/api/boxes/${box.id}`, {
        method: "PATCH",
        headers: { ...headers, "if-match": String(box.revision) },
        body: JSON.stringify({ labels: { team: "lab" } }),
      });
      expect(applied.status).toBe(200);

      const again = await fetch(`${base}/api/boxes/${box.id}/resources`, {
        method: "PATCH",
        headers: { ...headers, "if-match": String(box.revision) },
        body: JSON.stringify({ cpus: 2 }),
      });
      expect(again.status).toBe(412);
    } finally {
      server.stop(true);
    }
  });

  test("two updates with the same revision: one applies and the other is rejected", async () => {
    const box = await newBox("alpha");
    const [first, second] = await Promise.allSettled([
      boxes.updateBox(host, box.id, box.revision, { cpus: 2 }),
      boxes.updateBox(host, box.id, box.revision, { cpus: 3 }),
    ]);
    const outcomes = [first, second].map((result) => result.status);
    expect(outcomes.toSorted()).toEqual(["fulfilled", "rejected"]);
    const rejected = [first, second].find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(AppError);
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ status: 412 });
    const cpus = runtime.containers.get(box.id)?.cpus;
    expect(cpus === 2 || cpus === 3).toBe(true);
    expect(host.specs.read(box.boxId)?.revision).toBe(box.revision + 1);
  });

  test("parseRevision accepts a bare, quoted or weak tag", () => {
    expect(parseRevision(undefined)).toBe("missing");
    expect(parseRevision("  ")).toBe("missing");
    expect(parseRevision("0")).toBe("invalid");
    expect(parseRevision("1")).toBe(1);
    expect(parseRevision('"12"')).toBe(12);
    expect(parseRevision('W/"3"')).toBe(3);
  });
});

describe("drift and the reconciler", () => {
  test("drift comes from inspect versus the spec and is not repaired", async () => {
    const box = await newBox("alpha");
    const container = runtime.containers.get(box.id);
    if (!container) throw new Error("box missing");
    container.cpus = 3;
    container.spec = { ...container.spec, network: "bridge" };

    const drifted = await boxes.getBox(host, box.id);
    expect(drifted.drift).toContainEqual({ field: "cpus", expected: "1", actual: "3" });
    expect(drifted.drift).toContainEqual({ field: "network", expected: host.security.network, actual: "bridge" });

    const report = await reconcileHost(host);
    expect(report.started).toEqual([]);
    expect(report.stopped).toEqual([]);
    expect(runtime.containers.get(box.id)?.cpus).toBe(3);
    expect(runtime.containers.get(box.id)?.spec.network).toBe("bridge");
    expect((await boxes.getBox(host, box.id)).drift.map((item) => item.field)).toEqual(
      expect.arrayContaining(["cpus", "network"]),
    );
  });

  test("a desired-running box is started and a desired-stopped box is stopped, without a revision bump", async () => {
    const running = await newBox("alpha");
    await runtime.stopContainer(running.id, { timeoutSec: 1 });
    const started = await reconcileHost(host);
    expect(started.started).toEqual([running.boxId]);
    expect((await boxes.getBox(host, running.boxId)).running).toBe(true);
    expect(host.specs.read(running.boxId)?.revision).toBe(running.revision);

    const stopped = await boxes.stopBox(host, running.boxId);
    expect(stopped.desired).toBe("stopped");
    expect(stopped.revision).toBe(running.revision + 1);
    await runtime.startContainer(running.id);
    const halted = await reconcileHost(host);
    expect(halted.stopped).toEqual([running.boxId]);
    expect((await boxes.getBox(host, running.boxId)).running).toBe(false);
    expect(host.specs.read(running.boxId)?.revision).toBe(stopped.revision);

    const again = await boxes.stopBox(host, running.boxId);
    expect(again.revision).toBe(stopped.revision);
  });

  test("restart policy is forced to no and a running box stays running", async () => {
    const id = runtime.seedContainer({
      image: host.baseTemplateTag,
      name: "mbtest-legacy",
      running: true,
      restart: "unless-stopped",
      cpus: 1,
      memoryBytes: 128 * MB,
      labels: { [keys.box]: "true", [keys.name]: "legacy" },
    });

    const report = await reconcileHost(host);
    expect(report.restartReset).toHaveLength(1);
    expect(report.stopped).toEqual([]);
    expect(report.started).toEqual([]);
    expect(runtime.containers.get(id)?.running).toBe(true);
    expect((await runtime.inspectContainer(id)).restart).toBe("no");
    expect(host.specs.read(report.restartReset[0] ?? "")?.revision).toBe(1);
    expect(runtime.containers.get(id)?.labels[keys.id]).toBeUndefined();
  });

  test("a box that fails to start is reported and logged, and the boxes after it still start", async () => {
    const first = await newBox("alpha");
    const second = await newBox("beta");
    await runtime.stopContainer(first.id, { timeoutSec: 1 });
    await runtime.stopContainer(second.id, { timeoutSec: 1 });
    runtime.fail("startContainer", new RuntimeError("engine", "image was removed", "image was removed"));
    const errors = spyOn(console, "error");
    errors.mockClear();

    const report = await reconcileHost(host);

    expect(report.failed).toEqual([{ id: first.boxId, error: "image was removed" }]);
    expect(report.started).toEqual([second.boxId]);
    expect((await boxes.getBox(host, first.boxId)).running).toBe(false);
    expect((await boxes.getBox(host, second.boxId)).running).toBe(true);
    const logged = errors.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>);
    expect(logged).toContainEqual(
      expect.objectContaining({ msg: "box.reconcile_box_failed", id: first.boxId, error: "image was removed" }),
    );
  });

  test("a container that cannot be claimed is reported, and the containers after it are still claimed", async () => {
    runtime.seedContainer({
      image: host.baseTemplateTag,
      name: "mbtest-broken",
      labels: { [keys.box]: "true", [keys.name]: "broken" },
    });
    runtime.seedContainer({
      image: host.baseTemplateTag,
      name: "mbtest-legacy",
      labels: { [keys.box]: "true", [keys.name]: "legacy" },
    });
    const write = host.specs.write.bind(host.specs);
    host.specs.write = (spec) => {
      if (spec.containerName === "mbtest-broken") throw new Error("disk full");
      write(spec);
    };

    const report = await reconcileHost(host);

    expect(report.failed).toEqual([{ id: "mbtest-broken", error: "disk full" }]);
    expect(report.claimed).toHaveLength(1);
    expect(host.specs.findByName("legacy")?.containerName).toBe("mbtest-legacy");
    expect(host.specs.findByName("broken")).toBeNull();
  });
});
