import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { HostCtx } from "../src/host/registry";
import type { HelperSpec } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { newBoxId } from "../src/specs/revision";
import { createRestoredVolume, provisionDefaultMounts } from "../src/volumes/provision";
import { ROLE_MOUNT } from "../src/volumes/types";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";

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

const helperSpecs = (): HelperSpec[] => runtime.callsTo("runHelper").map((call) => call.args[0] as HelperSpec);

describe("volumes restored for a box", () => {
  test("an owned volume records its box and is handed to no one", async () => {
    const owner = newBoxId();
    const volume = await createRestoredVolume(
      host,
      { name: "fork-workspace", role: "workspace", owner, createdBy: "owner" },
      new Set(),
    );

    expect(volume).toMatchObject({
      name: "fork-workspace",
      role: "workspace",
      ownership: "owned",
      ownerBoxId: owner,
      pool: "local",
      createdBy: "owner",
    });
    expect(host.volumes.read(volume.id)).toEqual(volume);
    expect(runtime.volumes.get(volume.engineName)?.labels).toMatchObject({
      [host.keys.box]: "true",
      [host.keys.role]: "workspace",
    });
    expect(runtime.volumeOwners.has(volume.engineName)).toBe(false);
    expect(helperSpecs()).toEqual([]);
  });

  test("a volume with no owner is independent", async () => {
    const volume = await createRestoredVolume(
      host,
      { name: "shared-copy", role: null, owner: null, createdBy: null },
      new Set(),
    );

    expect(volume).toMatchObject({ ownership: "independent", ownerBoxId: null, role: null });
  });

  test("a name already taken gets the next free name", async () => {
    const first = await createRestoredVolume(
      host,
      { name: "dup", role: "workspace", owner: newBoxId(), createdBy: null },
      new Set(),
    );
    const second = await createRestoredVolume(
      host,
      { name: "dup", role: "workspace", owner: newBoxId(), createdBy: null },
      new Set(),
    );

    expect(first.name).toBe("dup");
    expect(second.name).toBe("dup-local");
  });

  test("a restored workspace is mounted as it is, and the other roles are made for the new box", async () => {
    const owner = newBoxId();
    const known = new Set<string>();
    const restored = await createRestoredVolume(
      host,
      { name: "fork-workspace", role: "workspace", owner, createdBy: "owner" },
      known,
    );

    const mounts = await provisionDefaultMounts(
      host,
      { id: owner, name: "fork", createdBy: "owner" },
      known,
      undefined,
      new Map([["workspace", restored]]),
    );

    const byPath = new Map(mounts.map((mount) => [mount.path, mount]));
    expect(mounts).toHaveLength(4);
    expect(byPath.get(ROLE_MOUNT.workspace.path)).toEqual({
      volume: restored.engineName,
      path: "/workspace",
      mode: "rw",
    });
    const owned = host.volumes.list().filter((volume) => volume.ownerBoxId === owner);
    expect(owned.map((volume) => volume.role).toSorted()).toEqual(["cache", "home", "workspace"]);
    expect(byPath.get(ROLE_MOUNT.tools.path)).toMatchObject({ mode: "ro" });
    const chowned = helperSpecs()
      .filter((spec) => spec.cmd.join(" ").includes("chown"))
      .flatMap((spec) => (spec.mounts ?? []).map((mount) => mount.source));
    const fresh = mounts.map((mount) => mount.volume).filter((volume) => volume !== restored.engineName);
    expect(chowned.toSorted()).toEqual(fresh.toSorted());
    expect(runtime.volumeOwners.has(restored.engineName)).toBe(false);
  });

  test("a restored volume the engine no longer has is refused, not recreated empty", async () => {
    const owner = newBoxId();
    const restored = await createRestoredVolume(
      host,
      { name: "fork-workspace", role: "workspace", owner, createdBy: "owner" },
      new Set(),
    );
    await runtime.removeVolume(restored.engineName);

    const error = await rejectionOf(
      provisionDefaultMounts(
        host,
        { id: owner, name: "fork", createdBy: "owner" },
        new Set(),
        undefined,
        new Map([["workspace", restored]]),
      ),
    );

    expect(error).toMatchObject({
      status: 409,
      code: "conflict",
      key: "volume_missing",
      params: { volume: restored.name },
    });
    expect(runtime.volumes.has(restored.engineName)).toBe(false);
  });
});

describe("box ids reserved before a create", () => {
  test("a box takes the id it was given", async () => {
    const id = newBoxId();

    const created = await boxes.createBox(host, { id, name: "reserved", cpus: 1, memoryMb: 256 });

    expect(created.boxId).toBe(id);
    expect(host.specs.read(id)?.name).toBe("reserved");
  });

  test("an id already in use is refused, and the box that holds it is kept", async () => {
    const id = newBoxId();
    await boxes.createBox(host, { id, name: "held", cpus: 1, memoryMb: 256 });

    const error = await rejectionOf(boxes.createBox(host, { id, name: "clash", cpus: 1, memoryMb: 256 }));

    expect(error).toMatchObject({ status: 409, code: "conflict", key: "box_id_taken", params: { id } });
    expect(host.specs.read(id)?.name).toBe("held");
    expect(host.specs.findByName("clash")).toBeNull();
  });

  test("an id that is not a box id is refused before the engine is asked for anything", async () => {
    const error = await rejectionOf(boxes.createBox(host, { id: "not-a-box", name: "bad", cpus: 1, memoryMb: 256 }));

    expect(String(error)).toContain("refusing a box id not-a-box");
    expect(runtime.callsTo("createContainer")).toEqual([]);
  });
});
