import type { App } from "../app";
import * as boxes from "../docker/boxes";
import { createSnapshot } from "../docker/snapshots";
import { AppError } from "../lib/errors";
import { json, readJson } from "../lib/http";
import { msg } from "../lib/messages";
import {
  asObject,
  type CreateBoxInput,
  optionalBoolean,
  optionalName,
  parseCreateBox,
  parseResources,
  validateTail,
} from "../lib/validation";
import { type Route, route } from "./router";

export const DEFAULT_RESOURCES = { cpus: 2, memoryMb: 4096 };

/** Reject a single box that asks for more than the host physically has. */
export async function assertCapacity(app: App, res: { cpus?: number; memoryMb?: number }): Promise<void> {
  const host = await app.monitor.snapshot();
  if (res.cpus !== undefined && res.cpus > host.cpu.cores) {
    throw new AppError(422, "insufficient_capacity", msg("cpu_over_host", { cores: host.cpu.cores }), {
      field: "cpus",
    });
  }
  if (res.memoryMb !== undefined && res.memoryMb * 1024 * 1024 > host.memory.total) {
    const gb = (host.memory.total / 1024 ** 3).toFixed(1);
    throw new AppError(422, "insufficient_capacity", msg("memory_over_host", { gb }), { field: "memoryMb" });
  }
}

/** Run an operation and record it in the activity log (success or failure). */
export async function tracked<T>(app: App, action: string, target: string, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    app.activity.add({ action, target, ok: true });
    return result;
  } catch (e) {
    app.activity.add({ action, target, ok: false, message: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

export async function createBoxFrom(app: App, input: CreateBoxInput, templateLabel?: string) {
  await assertCapacity(app, input);
  return tracked(app, "box.create", input.name, () => boxes.createBox(app.docker, { ...input, templateLabel }));
}

const nameOf = async (app: App, id: string) => (await boxes.getBox(app.docker, id)).name;

export const boxRoutes: Route[] = [
  route("GET", "/api/boxes", async ({ app, url }) =>
    json({ boxes: await boxes.listBoxes(app.docker, { withStats: url.searchParams.get("stats") !== "false" }) }),
  ),
  route("POST", "/api/boxes", async ({ app, req }) => {
    const input = parseCreateBox(await readJson(req), DEFAULT_RESOURCES);
    return json({ box: await createBoxFrom(app, input) }, 201);
  }),
  route("GET", "/api/boxes/:id", async ({ app, params }) => {
    const box = await boxes.getBox(app.docker, params.id ?? "");
    return json({ box: { ...box, stats: await boxes.getStats(app.docker, box.id).catch(() => null) } });
  }),
  route("DELETE", "/api/boxes/:id", async ({ app, params, url }) => {
    const id = params.id ?? "";
    const deleteVolume = optionalBoolean(url.searchParams.get("deleteVolume") ?? undefined, "deleteVolume");
    const name = await nameOf(app, id);
    return json(await tracked(app, "box.delete", name, () => boxes.deleteBox(app.docker, id, deleteVolume)));
  }),
  ...(["start", "stop", "restart"] as const).map((action) =>
    route("POST", `/api/boxes/:id/${action}`, async ({ app, params }) => {
      const id = params.id ?? "";
      const name = await nameOf(app, id);
      const fn = { start: boxes.startBox, stop: boxes.stopBox, restart: boxes.restartBox }[action];
      return json({ box: await tracked(app, `box.${action}`, name, () => fn(app.docker, id)) });
    }),
  ),
  route("PATCH", "/api/boxes/:id/resources", async ({ app, params, req }) => {
    const id = params.id ?? "";
    const res = parseResources(await readJson(req));
    await assertCapacity(app, res);
    const name = await nameOf(app, id);
    return json({ box: await tracked(app, "box.resources", name, () => boxes.updateResources(app.docker, id, res)) });
  }),
  route("GET", "/api/boxes/:id/logs", async ({ app, params, url }) =>
    json({ logs: await boxes.getLogs(app.docker, params.id ?? "", validateTail(url.searchParams.get("tail"))) }),
  ),
  route("GET", "/api/boxes/:id/stats", async ({ app, params }) =>
    json({ stats: await boxes.getStats(app.docker, params.id ?? "") }),
  ),
  route("POST", "/api/boxes/:id/snapshots", async ({ app, params, req }) => {
    const id = params.id ?? "";
    const body = asObject(await readJson(req));
    const name = optionalName(body.name, "name", "snapshotName");
    const boxName = await nameOf(app, id);
    return json(
      { snapshot: await tracked(app, "snapshot.create", boxName, () => createSnapshot(app.docker, id, name)) },
      201,
    );
  }),
];
