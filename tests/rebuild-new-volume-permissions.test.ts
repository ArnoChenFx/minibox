import { afterAll, afterEach, expect, test } from "bun:test";

import { silenceLogs } from "./support/app";
import { call, type Harness, mint, refused, startHarness } from "./support/tokens";
const restore = silenceLogs();
afterAll(restore);
const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.stop();
});

interface MountView {
  readonly volume: string;
  readonly path: string;
  readonly mode: "rw" | "ro";
}

/** Rebuilds a box the token made itself, keeping its mounts and adding one of a volume name that has no record yet. */
async function rebuildWithNewVolume(h: Harness, token?: string) {
  const created = await call(h.base, "/api/boxes", { token, body: { name: "box" } });
  expect(created.status).toBe(201);
  const box = created.json.box as { id: string; revision: number };
  const view = (await call(h.base, `/api/boxes/${box.id}`, { token })).json.box as unknown as { mounts: MountView[] };
  const keep = view.mounts.map(({ volume, path, mode }) => ({ volume, path, mode }));
  return call(h.base, `/api/boxes/${box.id}/rebuild`, {
    token,
    body: { mounts: [...keep, { volume: "brand-new-vol", path: "/data", mode: "rw" }], confirm: true },
    headers: { "if-match": String(box.revision) },
  });
}

const brandNew = (h: Harness) =>
  h.app.hosts
    .get()
    .volumes.list()
    .find((volume) => volume.name === "brand-new-vol");

test("a box-scoped token rebuilding with a new volume name is refused as volume administration, and nothing is made", async () => {
  const h = startHarness();
  harnesses.push(h);
  const operator = mint(h.app, { name: "operator", preset: "operator" });
  const before = h.runtime.calls.length;
  const reply = await rebuildWithNewVolume(h, operator.secret);
  expect(refused(reply)).toEqual({ status: 403, key: "storage_admin_required" });
  expect(brandNew(h)).toBeUndefined();
  expect(
    h.runtime.calls
      .slice(before)
      .some((c) => c.op === "createVolume" && JSON.stringify(c.args).includes("brand-new-vol")),
  ).toBe(false);
});

test("an unmodified admin token and the owner may still rebuild with a new volume name", async () => {
  for (const preset of ["admin", null] as const) {
    const h = startHarness();
    harnesses.push(h);
    const token = preset ? mint(h.app, { name: "admin", preset }).secret : undefined;
    expect((await rebuildWithNewVolume(h, token)).status).toBe(200);
    expect(brandNew(h)).toBeDefined();
  }
});

test("creating a box with a volume name that has no record is 404 volume_not_found for every caller, and makes nothing", async () => {
  for (const preset of ["operator", "admin", null] as const) {
    const h = startHarness();
    harnesses.push(h);
    const token = preset ? mint(h.app, { name: preset, preset }).secret : undefined;
    const before = h.runtime.calls.length;
    const reply = await call(h.base, "/api/boxes", {
      token,
      body: { name: "box", mounts: [{ volume: "no-such-vol", path: "/data", mode: "rw" }] },
    });
    // A create never makes a volume from a name, so the missing name is reported, not refused as volume administration.
    expect({ preset, ...refused(reply) }).toEqual({ preset, status: 404, key: "volume_not_found" });
    expect(h.app.hosts.get().specs.list()).toHaveLength(0);
    expect(
      h.app.hosts
        .get()
        .volumes.list()
        .some((volume) => volume.name === "no-such-vol"),
    ).toBe(false);
    expect(h.runtime.calls.slice(before).some((c) => c.op === "createVolume" || c.op === "createContainer")).toBe(
      false,
    );
  }
});
