import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";

import type { Server } from "bun";

import type { App } from "../src/app";
import type { LabelKeys } from "../src/labels";
import { RuntimeError, type RuntimeErrorKind } from "../src/runtime";
import { startServer } from "../src/server";
import { assertCapacity } from "../src/services/capacity";
import type { TerminalData } from "../src/ws/terminal";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

const MB = 1024 * 1024;

let app: App;
let runtime: FakeRuntime;
let keys: LabelKeys;
let server: Server<TerminalData>;
let base: string;
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  ({ app, runtime } = createTestApp({ labelPrefix: "mbtest" }));
  keys = app.hosts.get().keys;
  runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  app.sessions.stop();
  server.stop(true);
  restoreLogs();
});

type ErrorBody = {
  code: string;
  message: string;
  key?: string;
  params?: Record<string, unknown>;
  details?: Record<string, unknown>;
};

function api(path: string, init: RequestInit = {}, { authed = true } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (authed) headers.set("authorization", `Bearer ${TEST_KEY}`);
  return fetch(`${base}${path}`, { ...init, headers });
}

const get = (path: string) => api(path);
const post = (path: string, body: unknown = {}) =>
  api(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
const del = (path: string) => api(path, { method: "DELETE" });
const enc = encodeURIComponent;

async function errorOf(res: Response): Promise<ErrorBody> {
  return ((await res.json()) as { error: ErrorBody }).error;
}

async function createBox(name: string): Promise<{ id: string; name: string; revision: number }> {
  const res = await post("/api/boxes", { name, cpus: 1, memoryMb: 256 });
  expect(res.status).toBe(201);
  return ((await res.json()) as { box: { id: string; name: string; revision: number } }).box;
}

describe("access and routing", () => {
  test("API routes need the access key, health does not", async () => {
    const res = await api("/api/boxes", {}, { authed: false });
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toMatchObject({ code: "unauthorized", key: "unauthorized" });
    expect((await api("/api/health", {}, { authed: false })).status).toBe(200);
  });

  test("unknown paths and wrong methods get their own errors", async () => {
    expect(await errorOf(await get("/api/nope"))).toMatchObject({ code: "not_found", key: "api_not_found" });
    const wrong = await api("/api/boxes", { method: "PUT" });
    expect(wrong.status).toBe(405);
    expect(await errorOf(wrong)).toMatchObject({ code: "method_not_allowed" });
  });

  test("malformed JSON is rejected before the engine is called", async () => {
    const res = await api("/api/boxes", {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ code: "bad_request", key: "invalid_json" });
    expect(runtime.calls).toEqual([]);
  });

  test("health reports Docker reachability and stays public", async () => {
    const up = await api("/api/health", {}, { authed: false });
    expect(up.status).toBe(200);
    expect(await up.json()).toEqual({ ok: true, docker: true });

    runtime.down = true;
    const down = await api("/api/health", {}, { authed: false });
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ ok: true, docker: false });
  });

  test("metrics report Docker as unavailable instead of failing", async () => {
    runtime.down = true;
    const res = await get("/api/host/metrics");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ docker: { available: false }, boxes: { total: 0 } });
  });

  test("a cross-site write is refused with 403 before the engine is called", async () => {
    const res = await api("/api/boxes", {
      method: "POST",
      body: JSON.stringify({ name: "evil", cpus: 1, memoryMb: 256 }),
      headers: { "content-type": "application/json", origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatchObject({ code: "forbidden", key: "origin_forbidden" });
    expect(runtime.calls).toEqual([]);
  });

  test("a form-encoded write is refused with 415 before the engine is called", async () => {
    const res = await api(`/api/boxes/${enc("anything")}/stop`, {
      method: "POST",
      body: "name=alpha",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(415);
    expect(await errorOf(res)).toMatchObject({ code: "unsupported_media_type", key: "unsupported_media_type" });
    expect(runtime.calls).toEqual([]);
  });
});

describe("box validation and error mapping", () => {
  test("invalid input is a 400 that names the field, and the engine is never called", async () => {
    const badName = await post("/api/boxes", { name: "bad name!", cpus: 1, memoryMb: 256 });
    expect(badName.status).toBe(400);
    expect(await errorOf(badName)).toMatchObject({ code: "validation_failed", details: { field: "name" } });

    const badCpus = await post("/api/boxes", { name: "ok", cpus: 500, memoryMb: 256 });
    expect(await errorOf(badCpus)).toMatchObject({ code: "validation_failed", details: { field: "cpus" } });

    const badResources = await api(`/api/boxes/${enc("anything")}/resources`, {
      method: "PATCH",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(await errorOf(badResources)).toMatchObject({ code: "validation_failed" });
    expect(runtime.calls).toEqual([]);
  });

  test("a duplicate name is a 409 with a translation key", async () => {
    await createBox("alpha");
    const res = await post("/api/boxes", { name: "alpha", cpus: 1, memoryMb: 256 });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({ code: "conflict", key: "box_exists", params: { name: "alpha" } });
  });

  test("a missing template image is a 400 that names the template field", async () => {
    const res = await post("/api/boxes", { name: "beta", template: "ghost:1", cpus: 1, memoryMb: 256 });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({
      code: "validation_failed",
      key: "template_image_missing",
      details: { field: "template" },
    });
  });

  test("a box larger than the host is refused before the engine is called", async () => {
    await expect(assertCapacity(app.hosts.get(), { cpus: os.cpus().length + 1 })).rejects.toMatchObject({
      status: 422,
      code: "insufficient_capacity",
      details: { field: "cpus" },
    });
    await expect(
      assertCapacity(app.hosts.get(), { memoryMb: Math.ceil(os.totalmem() / MB) + 1024 }),
    ).rejects.toMatchObject({
      status: 422,
      details: { field: "memoryMb" },
    });
    expect(runtime.callsTo("createContainer")).toHaveLength(0);
  });

  test("boxes are only visible through their MiniBox labels", async () => {
    const plainId = runtime.seedContainer({ image: app.cfg.baseTemplateTag, name: "plain" });
    expect(await errorOf(await get(`/api/boxes/${plainId}`))).toMatchObject({
      code: "not_found",
      key: "box_not_found",
    });
    expect(await (await get("/api/boxes")).json()).toEqual({ boxes: [] });
  });

  test.each<[RuntimeErrorKind, number, string, string | undefined]>([
    ["not_found", 404, "not_found", "docker_not_found"],
    ["conflict", 409, "conflict", "docker_conflict"],
    ["invalid", 400, "docker_error", undefined],
    ["unavailable", 503, "docker_unavailable", "docker_unavailable"],
    ["engine", 502, "docker_error", "docker_error"],
  ])("engine %s errors become HTTP %d (%s)", async (kind, status, code, key) => {
    runtime.fail("listContainers", new RuntimeError(kind, `(raw) ${kind}`, `engine says ${kind}`));
    const res = await get("/api/boxes");
    expect(res.status).toBe(status);
    const body = await errorOf(res);
    expect(body.code).toBe(code);
    expect(body.key).toBe(key);
    if (kind === "invalid") expect(body.message).toBe("engine says invalid");
    if (kind === "engine") expect(body.params).toEqual({ detail: "engine says engine" });
  });

  test("an unreachable engine is a 503 on every data route", async () => {
    runtime.down = true;
    for (const path of ["/api/boxes", "/api/templates", "/api/snapshots"]) {
      const res = await get(path);
      expect(res.status).toBe(503);
      expect(await errorOf(res)).toMatchObject({ code: "docker_unavailable" });
    }
  });
});

describe("system", () => {
  test("reports the box security settings that new boxes are created with", async () => {
    const { config } = (await (await get("/api/system")).json()) as { config: Record<string, unknown> };
    expect(config).toMatchObject({
      boxProfile: "standard",
      boxPidsLimit: 1024,
      containerRuntime: null,
      boxNetwork: "mbtest-boxes",
    });
  });
});

describe("box routes", () => {
  test("a box can choose its profile, and an unknown profile is refused before the engine is called", async () => {
    const res = await post("/api/boxes", { name: "alpha", cpus: 1, memoryMb: 256, profile: "strict" });
    expect(res.status).toBe(201);
    const { box } = (await res.json()) as { box: Record<string, unknown> };
    expect(box).toMatchObject({ profile: "strict", network: "mbtest-boxes" });
    expect(runtime.containers.get(String(box.id))?.spec.hardening).toMatchObject({ noNewPrivileges: true });

    const before = runtime.calls.length;
    const bad = await post("/api/boxes", { name: "beta", cpus: 1, memoryMb: 256, profile: "paranoid" });
    expect(bad.status).toBe(400);
    expect(await errorOf(bad)).toMatchObject({
      code: "validation_failed",
      key: "profile_invalid",
      details: { field: "profile" },
    });
    expect(runtime.calls.length).toBe(before);
  });

  test("create returns 201 with the box and the labels it was created with", async () => {
    const res = await post("/api/boxes", { name: "alpha", cpus: 1, memoryMb: 256 });
    expect(res.status).toBe(201);
    const { box } = (await res.json()) as { box: Record<string, unknown> };
    expect(box).toMatchObject({ name: "alpha", running: true, cpus: 1, memory: 256 * MB });
    const container = runtime.containers.get(String(box.id));
    expect(container?.labels).toMatchObject({ [keys.box]: "true", [keys.name]: "alpha" });
  });

  test("delete reports the result and removes the volume when asked", async () => {
    const box = await createBox("alpha");
    const res = await del(`/api/boxes/${box.id}?deleteVolume=true`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "alpha", volumeDeleted: true });
    expect(runtime.containers.size).toBe(0);
    expect(runtime.volumes.size).toBe(0);
  });

  test("resources can be changed on a box", async () => {
    const box = await createBox("alpha");
    const res = await api(`/api/boxes/${box.id}/resources`, {
      method: "PATCH",
      body: JSON.stringify({ cpus: 2 }),
      headers: { "content-type": "application/json", "if-match": String(box.revision) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(`"${box.revision + 1}"`);
    expect(await res.json()).toMatchObject({ box: { cpus: 2, memory: 256 * MB } });
  });

  test("a box can be snapshotted, restored and promoted, and the results are listed", async () => {
    const box = await createBox("alpha");

    const snapRes = await post(`/api/boxes/${box.id}/snapshots`, { name: "nightly" });
    expect(snapRes.status).toBe(201);
    const { snapshot } = (await snapRes.json()) as { snapshot: { ref: string; source: string } };
    expect(snapshot).toMatchObject({ source: "alpha" });
    expect(await (await get("/api/snapshots")).json()).toMatchObject({
      snapshots: [{ ref: snapshot.ref, source: "alpha" }],
    });

    const restored = await post(`/api/snapshots/${enc(snapshot.ref)}/boxes`, {
      name: "restored",
      cpus: 1,
      memoryMb: 256,
    });
    expect(restored.status).toBe(201);
    expect(await restored.json()).toMatchObject({ box: { name: "restored", template: `snapshot:${snapshot.ref}` } });

    const promoted = await post(`/api/snapshots/${enc(snapshot.ref)}/promote`, {
      name: "gold",
      description: "Gold image",
    });
    expect(promoted.status).toBe(201);
    expect(await promoted.json()).toMatchObject({ template: { ref: "mbtest-template:gold", name: "gold" } });

    const templates = (await (await get("/api/templates")).json()) as {
      templates: { ref: string }[];
      baseTemplate: string;
    };
    expect(templates.baseTemplate).toBe(app.cfg.baseTemplateTag);
    expect(templates.templates.map((t) => t.ref)).toContain("mbtest-template:gold");

    expect((await del(`/api/templates/${enc("mbtest-template:gold")}`)).status).toBe(200);
  });

  test("an unused snapshot can be deleted and disappears from the list", async () => {
    const box = await createBox("alpha");
    const { snapshot } = (await (await post(`/api/boxes/${box.id}/snapshots`, { name: "spare" })).json()) as {
      snapshot: { ref: string };
    };
    expect((await del(`/api/snapshots/${enc(snapshot.ref)}`)).status).toBe(200);
    expect(await (await get("/api/snapshots")).json()).toEqual({ snapshots: [] });
  });

  test("promoting something that is not a snapshot is a 404", async () => {
    runtime.seedImage("plain:1");
    const res = await post(`/api/snapshots/${enc("plain:1")}/promote`, { name: "nope" });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toMatchObject({ key: "snapshot_not_found" });
  });
});
