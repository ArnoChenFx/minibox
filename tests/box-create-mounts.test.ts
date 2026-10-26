import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import pkg from "../package.json";
import type { ExecutorHooks } from "../src/operations/executor";
import { renderOpenApi } from "../src/operations/openapi";
import { OPERATIONS } from "../src/operations/registry";
import type { OperationContext } from "../src/operations/types";
import { parseInput } from "../src/operations/validation";
import type { BoxMount } from "../src/specs/types";
import { type CreateMount, isRoleMount, mountPointOf, rolesToCreate } from "../src/volumes/create-mounts";
import { findSharedTools } from "../src/volumes/engine";
import { poolForRole } from "../src/volumes/pools";
import { ROLE_MOUNT, VOLUME_ROLES } from "../src/volumes/types";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";
import { call, startHarness, type Harness } from "./support/tokens";

const restoreLogs = silenceLogs();
afterEach(() => restoreLogs());

/** The parsed input of `box.create`, so a test reads the mounts the way the operation does. */
const createOperation = OPERATIONS.find((operation) => operation.name === "box.create");
if (!createOperation) throw new Error("box.create is not in the registry");

const parsedMounts = (mounts: unknown): CreateMount[] | undefined =>
  (parseInput(createOperation.input, { name: "alpha", mounts }) as { mounts?: CreateMount[] }).mounts;

describe("the mounts a create asks for", () => {
  test("a mount of a volume keeps the shape a create always took", () => {
    expect(parsedMounts([{ volume: "vol_a", path: "/data", mode: "ro" }])).toEqual([
      { volume: "vol_a", path: "/data", mode: "ro" },
    ]);
  });

  test("a mount of a role names only the role, and the role fixes its own path and mode", () => {
    const parsed = parsedMounts([{ role: "workspace" }, { role: "tools" }]);
    expect(parsed).toEqual([{ role: "workspace" }, { role: "tools" }]);
    if (!parsed) throw new Error("the mounts were refused");
    expect(parsed.map((mount) => mountPointOf(mount))).toEqual([ROLE_MOUNT.workspace, ROLE_MOUNT.tools]);
    expect(rolesToCreate(parsed)).toEqual(["workspace", "tools"]);
  });

  test("a role mount may repeat the role's own path and mode, and no other", () => {
    expect(parsedMounts([{ role: "cache", path: "/home/dev/.cache", mode: "rw" }])).toEqual([{ role: "cache" }]);
    expect(() => parsedMounts([{ role: "cache", path: "/scratch" }])).toThrow("/scratch");
    expect(() => parsedMounts([{ role: "tools", mode: "rw" }])).toThrow("read-write");
    expect(() => parsedMounts([{ role: "tools", mode: "ro" }])).not.toThrow();
  });

  test("a role is listed once, because a box mounts one volume of each role", () => {
    expect(() => parsedMounts([{ role: "home" }, { role: "home" }])).toThrow("home");
  });

  test("a mount that names both a volume and a role, or neither, is refused", () => {
    expect(() => parsedMounts([{ volume: "vol_a", role: "home", path: "/data", mode: "rw" }])).toThrow(
      "names either an existing volume",
    );
    expect(() => parsedMounts([{ path: "/data", mode: "rw" }])).toThrow("names either an existing volume");
  });

  test("a role name the volume model does not know is refused", () => {
    expect(() => parsedMounts([{ role: "scratch" }])).toThrow("names either an existing volume");
  });

  test("two mounts at one path are refused, whether a role or a volume names it", () => {
    expect(() => parsedMounts([{ role: "workspace" }, { volume: "vol_a", path: "/workspace", mode: "rw" }])).toThrow(
      "/workspace",
    );
  });

  test("the mount of a volume still needs a valid path and mode", () => {
    expect(() => parsedMounts([{ volume: "vol_a", path: "data", mode: "rw" }])).toThrow("names either an existing");
    expect(() => parsedMounts([{ volume: "vol_a", path: "/data", mode: "rx" }])).toThrow("names either an existing");
    expect(() => parsedMounts([{ volume: "vol_a", path: "/data" }])).toThrow("names either an existing");
  });

  test("an empty list is a box with no mounts, and no list at all keeps the default roles", () => {
    expect(parsedMounts([])).toEqual([]);
    expect(parseInput(createOperation.input, { name: "alpha" }).mounts).toBeUndefined();
  });

  test("every role the volume model has can be created, and a role mount carries no volume", () => {
    for (const name of VOLUME_ROLES) {
      const parsed = parsedMounts([{ role: name }]);
      if (!parsed) throw new Error(`${name} was refused`);
      const [mount] = parsed;
      if (!mount) throw new Error(`${name} was dropped`);
      expect(isRoleMount(mount)).toBe(true);
      expect("volume" in mount).toBe(false);
    }
  });
});

describe("creating a box from role mounts", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = startHarness();
  });

  afterEach(() => harness.stop());

  const host = () => harness.app.hosts.get();

  /** The mounts of the created box, as the spec holds them: engine volume names, paths and modes. */
  const createdMounts = async (name: string, mounts: unknown): Promise<BoxMount[]> => {
    const reply = await call(harness.base, "/api/boxes", {
      body: { name, cpus: 1, memoryMb: 256, mounts },
    });
    expect(reply.status).toBe(201);
    const boxId = reply.json.box?.boxId ?? "";
    const spec = host().specs.read(boxId);
    if (!spec) throw new Error(`no spec for ${name}`);
    return spec.mounts;
  };

  const volumesNamed = async () =>
    host()
      .volumes.list()
      .map((volume) => volume.name);

  test("only the roles the list names get a volume", async () => {
    const mounts = await createdMounts("alpha", [{ role: "workspace" }, { role: "cache" }]);
    expect(mounts.map((mount) => mount.path).toSorted()).toEqual(["/home/dev/.cache", "/workspace"]);
    expect(mounts.every((mount) => mount.volume !== "mbtest-tools-local")).toBe(true);
    const names = await volumesNamed();
    expect(names).toEqual(expect.arrayContaining(["alpha-workspace", "alpha-cache"]));
    expect(names.some((name) => name.startsWith("alpha-home"))).toBe(false);
    expect(names.some((name) => name.includes("tools"))).toBe(false);
  });

  test("the tools role mounts the host's shared tools volume and creates one when there is none", async () => {
    const first = await createdMounts("alpha", [{ role: "tools" }]);
    const tools = findSharedTools(host(), poolForRole(host().volumes.readPools(), "tools").name);
    if (!tools) throw new Error("the tools role created no shared tools volume");
    expect(tools.ownership).toBe("independent");
    expect(first).toEqual([{ volume: tools.engineName, path: ROLE_MOUNT.tools.path, mode: ROLE_MOUNT.tools.mode }]);

    const second = await createdMounts("beta", [{ role: "tools" }]);
    expect(second).toEqual(first);
    const shared = host()
      .volumes.list()
      .filter((volume) => volume.role === "tools");
    expect(shared).toHaveLength(1);
    expect(shared[0]?.engineName).toBe(tools.engineName);
  });

  test("a list that mixes a role with an existing volume mounts both", async () => {
    const created = await call(harness.base, "/api/volumes", {
      body: { name: "notes", pool: "local", role: null, confirm: true },
    });
    expect(created.status).toBe(201);
    const notesId = created.json.volume?.id ?? "";
    const mounts = await createdMounts("alpha", [
      { role: "workspace" },
      { volume: notesId, path: "/srv/notes", mode: "ro" },
    ]);
    const notes = host().volumes.read(notesId);
    if (!notes) throw new Error("the notes volume is missing");
    expect(mounts).toEqual([
      { volume: expect.stringMatching(/^vol_/), path: ROLE_MOUNT.workspace.path, mode: "rw" },
      { volume: notes.engineName, path: "/srv/notes", mode: "ro" },
    ]);
  });

  test("a volume mount in a mixed list still passes the attachment rules a new box is held to", async () => {
    await createdMounts("beta", [{ role: "workspace" }]);
    const betaWorkspace = host()
      .volumes.list()
      .find((volume) => volume.name === "beta-workspace");
    if (!betaWorkspace) throw new Error("beta has no workspace record");
    const reply = await call(harness.base, "/api/boxes", {
      body: {
        name: "alpha",
        cpus: 1,
        memoryMb: 256,
        mounts: [{ role: "cache" }, { volume: betaWorkspace.id, path: "/workspace", mode: "rw" }],
      },
    });
    // The workspace volume belongs to a live box, so attaching it is refused even beside a role mount.
    expect(reply.status).toBe(403);
    expect(reply.json.error).toMatchObject({ code: "forbidden", key: "volume_in_use" });
    expect(host().specs.findByName("alpha")).toBeNull();
    // The cache volume the create made is taken back, so a refused create leaves nothing behind.
    expect(
      host()
        .volumes.list()
        .map((volume) => volume.name),
    ).toEqual(["beta-workspace"]);
  });

  test("a mount that names both a volume and a role is refused, and nothing is created", async () => {
    const reply = await call(harness.base, "/api/boxes", {
      body: {
        name: "alpha",
        cpus: 1,
        memoryMb: 256,
        mounts: [{ volume: "vol_a", role: "workspace", path: "/workspace", mode: "rw" }],
      },
    });
    expect(reply.status).toBe(400);
    expect(reply.json.error).toMatchObject({ code: "validation_failed", key: "mount_create_invalid" });
    expect(host().specs.findByName("alpha")).toBeNull();
    expect(await volumesNamed()).toEqual([]);
  });

  test("every role a create names needs volume:write, and the tools role needs volume:attach once the shared volume exists", async () => {
    const hooks: Partial<ExecutorHooks> = { authorize: (request) => request.scope !== "volume:write" };
    const denied = createTestApp({ labelPrefix: "mbtest" }, new FakeRuntime(), hooks);
    denied.runtime.seedImage(denied.app.hosts.get().baseTemplateTag, {});
    const ctx: OperationContext = {
      host: denied.app.hosts.get(),
      principal: { type: "owner", id: "owner", name: "owner" },
      source: "rest",
      events: denied.app.events,
      tokens: denied.app.tokens,
    };
    try {
      // A create with only the cache role makes a volume, so it needs volume:write and nothing else.
      const writeDenied = await rejectionOf(
        denied.app.operations.run("box.create", ctx, {
          name: "alpha",
          cpus: 1,
          memoryMb: 256,
          mounts: [{ role: "cache" }],
        }),
      );
      expect(writeDenied).toMatchObject({ status: 403, key: "volume_create_forbidden" });
      expect(denied.runtime.containers.size).toBe(0);
      expect(denied.app.hosts.get().volumes.list()).toEqual([]);
    } finally {
      denied.app.hosts.get().sampler.stop();
      denied.app.throttle.stop();
      denied.app.sessions.stop();
      denied.app.tokens.stop();
      denied.app.events.close();
    }

    // The same create with volume:write allowed and volume:attach refused passes, because no shared tools volume exists.
    const attachOnly: Partial<ExecutorHooks> = { authorize: (request) => request.scope !== "volume:attach" };
    const second = createTestApp({ labelPrefix: "mbtest" }, new FakeRuntime(), attachOnly);
    second.runtime.seedImage(second.app.hosts.get().baseTemplateTag, {});
    const secondCtx: OperationContext = {
      host: second.app.hosts.get(),
      principal: { type: "owner", id: "owner", name: "owner" },
      source: "rest",
      events: second.app.events,
      tokens: second.app.tokens,
    };
    try {
      await second.app.operations.run("box.create", secondCtx, {
        name: "beta",
        cpus: 1,
        memoryMb: 256,
        mounts: [{ role: "tools" }],
      });
      expect(
        second.app.hosts
          .get()
          .volumes.list()
          .filter((volume) => volume.role === "tools"),
      ).toHaveLength(1);
      // A second box's tools role mounts the volume that now exists, so it needs volume:attach and is refused.
      const attachDenied = await rejectionOf(
        second.app.operations.run("box.create", secondCtx, {
          name: "gamma",
          cpus: 1,
          memoryMb: 256,
          mounts: [{ role: "tools" }],
        }),
      );
      expect(attachDenied).toMatchObject({ status: 403, key: "volume_attach_forbidden" });
    } finally {
      second.app.hosts.get().sampler.stop();
      second.app.throttle.stop();
      second.app.sessions.stop();
      second.app.tokens.stop();
      second.app.events.close();
    }
  });
});

/** The mounts property of a create, as docs/openapi.json describes it. */
function documentedMounts(): { description?: string; items?: { description?: string } } | undefined {
  const doc = JSON.parse(renderOpenApi(OPERATIONS, pkg.version)) as {
    paths: Record<
      string,
      { post?: { requestBody?: { content: Record<string, { schema: Record<string, unknown> }> } } }
    >;
  };
  const schema = doc.paths["/api/boxes"]?.post?.requestBody?.content["application/json"]?.schema;
  const properties = schema?.properties as
    | Record<string, { description?: string; items?: { description?: string } }>
    | undefined;
  return properties?.mounts;
}

describe("the mount list of a create in the OpenAPI document", () => {
  test("it says a role the list omits is not created, and what each entry holds", () => {
    const mounts = documentedMounts();
    expect(mounts?.description).toContain("A role the list omits is not created");
    expect(mounts?.items?.description).toContain("{ role }");
    expect(mounts?.description).toContain("/opt/minibox/tools");
  });
});
