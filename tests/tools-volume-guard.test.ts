import { afterAll, afterEach, expect, test } from "bun:test";

import { findSharedTools } from "../src/volumes/engine";
import { silenceLogs } from "./support/app";
import { call, finishedTask, mint, refused, startHarness, type Harness } from "./support/tokens";
const restore = silenceLogs();
afterAll(restore);
const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.stop();
});

const harness = () => {
  const h = startHarness();
  harnesses.push(h);
  return h;
};

const toolsMount = (h: Harness, box: string) =>
  h.app.hosts
    .get()
    .specs.list()
    .find((spec) => spec.name === box)
    ?.mounts.find((mount) => mount.path === "/opt/minibox/tools")?.volume;

test("no token may create a tools volume, not even an unmodified admin token, and nothing reaches the engine", async () => {
  const h = harness();
  const admin = mint(h.app, { name: "admin", preset: "admin" });
  const before = h.runtime.calls.length;
  const preview = await call(h.base, "/api/volumes", {
    token: admin.secret,
    body: { name: "token-tools", pool: "local", role: "tools" },
  });
  expect(refused(preview)).toEqual({ status: 403, key: "volume_tools_create_forbidden" });
  const reply = await call(h.base, "/api/volumes", {
    token: admin.secret,
    body: { name: "token-tools", pool: "local", role: "tools", confirm: true },
  });
  expect(refused(reply)).toEqual({ status: 403, key: "volume_tools_create_forbidden" });
  expect(h.runtime.calls.slice(before).some((c) => c.op === "createVolume")).toBe(false);
  expect(h.app.hosts.get().volumes.list()).toHaveLength(0);
  // A general volume is still the admin token's to make.
  expect(
    (await call(h.base, "/api/volumes", { token: admin.secret, body: { name: "notes", confirm: true } })).status,
  ).toBe(201);
});

test("the owner may still create a tools volume", async () => {
  const h = harness();
  const reply = await call(h.base, "/api/volumes", {
    body: { name: "owner-tools", pool: "local", role: "tools", confirm: true },
  });
  expect(reply.status).toBe(201);
  expect(h.app.hosts.get().volumes.read(reply.json.volume!.id)?.role).toBe("tools");
});

test("boxes keep the managed tools volume when a spare tools volume sits in the same pool", async () => {
  const h = harness();
  expect((await call(h.base, "/api/boxes", { body: { name: "first" } })).status).toBe(201);
  const managed = toolsMount(h, "first");
  expect(managed).toBeDefined();
  const spare = await call(h.base, "/api/volumes", {
    body: { name: "aaa-spare-tools", pool: "local", role: "tools", confirm: true },
  });
  expect(spare.status).toBe(201);
  const host = h.app.hosts.get();
  expect(findSharedTools(host, "local")?.engineName).toBe(managed!);
  expect((await call(h.base, "/api/boxes", { body: { name: "second" } })).status).toBe(201);
  expect(toolsMount(h, "second")).toBe(managed!);
});

test("a spare tools volume can be deleted by name, singly or in a batch, while the shared one is refused", async () => {
  const h = harness();
  expect((await call(h.base, "/api/boxes", { body: { name: "first" } })).status).toBe(201);
  const host = h.app.hosts.get();
  const shared = findSharedTools(host, "local")!;
  const makeSpare = async (name: string) => {
    const reply = await call(h.base, "/api/volumes", { body: { name, pool: "local", role: "tools", confirm: true } });
    expect(reply.status).toBe(201);
    return reply.json.volume!.id as string;
  };

  // Single delete by the owner, straight past the trash.
  const one = await makeSpare("spare-one");
  const single = await call(h.base, `/api/volumes/${one}?confirm=true&skipTrash=true`, { method: "DELETE" });
  expect(single.status).toBe(200);
  expect(host.volumes.read(one)).toBeNull();

  // Batch delete by the owner.
  const two = await makeSpare("spare-two");
  const batch = await call(h.base, "/api/volumes/delete", {
    body: { ids: [two, shared.id], confirm: true },
  });
  const settled = batch.status === 202 ? await finishedTask(h.base, batch.json.taskId as string) : batch.json;
  expect(JSON.stringify(settled)).toContain("volume_shared_tools");
  expect(host.volumes.read(two)).toBeNull();
  expect(host.volumes.read(shared.id)).not.toBeNull();

  // The shared one is still refused on its own, even with skipTrash.
  const refusedShared = await call(h.base, `/api/volumes/${shared.id}?confirm=true&skipTrash=true`, {
    method: "DELETE",
  });
  expect(refusedShared.status).toBe(409);
  expect(refusedShared.json.error?.key).toBe("volume_shared_tools");
});

test("prune never removes a tools volume, spare or shared", async () => {
  const h = harness();
  const spare = await call(h.base, "/api/volumes", {
    body: { name: "spare-tools", pool: "local", role: "tools", confirm: true },
  });
  expect(spare.status).toBe(201);
  const pruned = await call(h.base, "/api/volumes/prune", { body: { confirm: true } });
  const settled = pruned.status === 202 ? await finishedTask(h.base, pruned.json.taskId as string) : pruned.json;
  expect(JSON.stringify(settled)).not.toContain(spare.json.volume!.id as string);
  expect(h.app.hosts.get().volumes.read(spare.json.volume!.id as string)).not.toBeNull();
});

test("an admin token refused a volume outside its grants is told so, not that it did not create the volume", async () => {
  const h = harness();
  const created = await call(h.base, "/api/volumes", { body: { name: "owner-notes", confirm: true } });
  expect(created.status).toBe(201);
  // An unmodified admin token may batch delete, but only the volumes its grants cover; the owner's own volume is not one.
  const narrowed = mint(h.app, { name: "admin", preset: "admin" });
  const batch = await call(h.base, "/api/volumes/delete", {
    token: narrowed.secret,
    body: { ids: [created.json.volume!.id], confirm: true },
  });
  const text = JSON.stringify(
    batch.status === 202 ? await finishedTask(h.base, batch.json.taskId as string) : batch.json,
  );
  expect(text).toContain("volume_delete_forbidden");
  expect(text).toContain("outside this credential's resource grants");
  expect(text).not.toContain("you created");
  expect(h.app.hosts.get().volumes.read(created.json.volume!.id as string)).not.toBeNull();
});
