import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import { AppError } from "../src/lib/errors";
import { OWNER, type OperationContext, type Principal } from "../src/operations/types";
import { liveBox } from "../src/services/box-view";
import { getBox } from "../src/services/boxes";
import { compileToken, presetPolicy } from "../src/tokens/model";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";
import { call, type Harness, mint, principalOf, startHarness } from "./support/tokens";

const SECRET_VALUE = "sekret-7f3a-value";
const ROTATED_VALUE = "rotated-9c1e-value";
const PLAIN_VALUE = "plain-greeting-value";

interface BoxResult {
  box: {
    id: string;
    boxId: string;
    name: string;
    running: boolean;
    revision: number;
    env: { name: string; value?: string; secretRef?: string }[];
  };
}

interface SecretResult {
  secret: { name: string; boxes: string[] };
  created: boolean;
}

let app: App;
let runtime: FakeRuntime;
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  const created = createTestApp({ labelPrefix: "mbtest" });
  app = created.app;
  runtime = created.runtime;
  const keys = app.hosts.get().keys;
  runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
});

afterEach(() => restoreLogs());

function contextFor(principal: Principal): OperationContext {
  return {
    host: app.hosts.get(),
    principal,
    source: "rest",
    events: app.events,
    tokens: app.tokens,
    execs: app.execs,
    terminals: app.terminals,
  };
}

function run<T = BoxResult>(name: string, input: object, principal: Principal = OWNER): Promise<T> {
  return app.operations.run(name, contextFor(principal), input) as Promise<T>;
}

function setSecret(name: string, value: string): void {
  app.hosts.get().secrets.set(name, value, new Date().toISOString());
}

function createInput(name: string, env: object[]) {
  return { name, cpus: 1, memoryMb: 256, env };
}

function containerEnv(id: string): string[] | undefined {
  return runtime.containers.get(id)?.spec.env;
}

describe("create with env", () => {
  test("a plain entry is stored on the spec and reaches the container", async () => {
    const { box } = await run("box.create", createInput("alpha", [{ name: "GREETING", value: PLAIN_VALUE }]));
    expect(box.env).toEqual([{ name: "GREETING", value: PLAIN_VALUE }]);
    expect(containerEnv(box.id)).toEqual([`GREETING=${PLAIN_VALUE}`]);
  });

  test("a secret entry is injected into the container, and the spec and labels keep only its name", async () => {
    setSecret("vault", SECRET_VALUE);
    const { box } = await run("box.create", createInput("alpha", [{ name: "TOKEN", secretRef: "vault" }]));
    expect(containerEnv(box.id)).toEqual([`TOKEN=${SECRET_VALUE}`]);
    expect(box.env).toEqual([{ name: "TOKEN", secretRef: "vault" }]);
    expect(JSON.stringify(box)).not.toContain(SECRET_VALUE);
    const spec = app.hosts.get().specs.read(box.boxId);
    expect(spec?.env).toEqual([{ name: "TOKEN", secretRef: "vault" }]);
    expect(JSON.stringify(spec)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(runtime.containers.get(box.id)?.labels)).not.toContain(SECRET_VALUE);
  });

  test("a secret that is not set refuses the create before any volume, container or spec is made", async () => {
    const error = await rejectionOf(run("box.create", createInput("alpha", [{ name: "TOKEN", secretRef: "absent" }])));
    expect(error).toMatchObject({ status: 400, key: "env_secret_missing" });
    expect(runtime.callsTo("createContainer")).toEqual([]);
    expect(runtime.volumes.size).toBe(0);
    expect(app.hosts.get().specs.list()).toEqual([]);
  });

  test("an entry that names both a value and a secret, or neither, or repeats a name, is refused", async () => {
    const invalid: object[][] = [
      [{ name: "A", value: "x", secretRef: "vault" }],
      [{ name: "A" }],
      [
        { name: "A", value: "x" },
        { name: "A", value: "y" },
      ],
      [{ name: "9BAD", value: "x" }],
      [{ name: "A", secretRef: "bad name" }],
      [{ name: "A", value: "line\nbreak" }],
    ];
    for (const env of invalid) {
      const error = await rejectionOf(run("box.create", createInput("alpha", env)));
      expect({ env, error: (error as AppError).key }).toEqual({ env, error: "env_invalid" });
    }
    expect(app.hosts.get().specs.list()).toEqual([]);
  });

  test("the create event names the env entries and never their values", async () => {
    setSecret("vault", SECRET_VALUE);
    const before = app.events.head();
    await run(
      "box.create",
      createInput("alpha", [
        { name: "TOKEN", secretRef: "vault" },
        { name: "GREETING", value: PLAIN_VALUE },
      ]),
    );
    const events = JSON.stringify(app.events.after(before, {}, 20));
    expect(events).toContain('"env":["TOKEN","GREETING"]');
    expect(events).not.toContain(SECRET_VALUE);
    expect(events).not.toContain(PLAIN_VALUE);
  });
});

describe("rebuild and update with env", () => {
  test("a rotated secret is applied by an empty rebuild, and the spec keeps only its name", async () => {
    setSecret("vault", SECRET_VALUE);
    const { box } = await run("box.create", createInput("alpha", [{ name: "TOKEN", secretRef: "vault" }]));
    const request = { id: box.id, confirm: true, expectedRevision: "1" };
    expect(await rejectionOf(run("box.rebuild", request))).toMatchObject({ status: 400, key: "rebuild_empty" });

    setSecret("vault", ROTATED_VALUE);
    expect(containerEnv(box.id)).toEqual([`TOKEN=${SECRET_VALUE}`]);
    const preview = await rejectionOf(run("box.rebuild", { ...request, confirm: false }));
    expect(preview).toMatchObject({ status: 409, code: "confirmation_required", key: "rebuild_confirm_required" });
    expect(JSON.stringify((preview as AppError).details)).toContain("secret TOKEN: new value");
    expect(JSON.stringify((preview as AppError).details)).not.toContain(ROTATED_VALUE);

    const rebuilt = await run("box.rebuild", request);
    expect(containerEnv(rebuilt.box.id)).toEqual([`TOKEN=${ROTATED_VALUE}`]);
    expect(app.hosts.get().specs.read(box.boxId)?.env).toEqual([{ name: "TOKEN", secretRef: "vault" }]);
    expect(JSON.stringify(rebuilt)).not.toContain(ROTATED_VALUE);
  });

  test("a secret set again to the value its box holds is not a change, so an empty rebuild is still refused", async () => {
    setSecret("vault", SECRET_VALUE);
    const { box } = await run("box.create", createInput("alpha", [{ name: "TOKEN", secretRef: "vault" }]));
    setSecret("vault", SECRET_VALUE);
    expect(await rejectionOf(run("box.rebuild", { id: box.id, confirm: true, expectedRevision: "1" }))).toMatchObject({
      status: 400,
      key: "rebuild_empty",
    });
  });

  test("an empty rebuild of a box whose secret was deleted is refused with its missing-secret key", async () => {
    setSecret("vault", SECRET_VALUE);
    const { box } = await run("box.create", createInput("alpha", [{ name: "TOKEN", secretRef: "vault" }]));
    await run("secret.delete", { name: "vault", force: true });
    expect(await rejectionOf(run("box.rebuild", { id: box.id, confirm: true, expectedRevision: "1" }))).toMatchObject({
      status: 400,
      key: "env_secret_missing",
    });
    expect(containerEnv(box.id)).toEqual([`TOKEN=${SECRET_VALUE}`]);
  });

  test("a rebuild that names a secret which is not set is refused with 400, not with a preview", async () => {
    const { box } = await run("box.create", createInput("alpha", []));
    const error = await rejectionOf(
      run("box.rebuild", {
        id: box.id,
        confirm: false,
        expectedRevision: "1",
        env: [{ name: "TOKEN", secretRef: "absent" }],
      }),
    );
    expect(error).toMatchObject({ status: 400, key: "env_secret_missing" });
  });

  test("the rebuild preview names a secret reference but never its value", async () => {
    setSecret("vault", SECRET_VALUE);
    const { box } = await run("box.create", createInput("alpha", []));
    const error = await rejectionOf(
      run("box.rebuild", {
        id: box.id,
        confirm: false,
        expectedRevision: "1",
        env: [
          { name: "TOKEN", secretRef: "vault" },
          { name: "GREETING", value: PLAIN_VALUE },
        ],
      }),
    );
    expect(error).toMatchObject({ status: 409, key: "rebuild_confirm_required" });
    const preview = JSON.stringify((error as AppError).details);
    expect(preview).toContain("vault");
    expect(preview).not.toContain(SECRET_VALUE);
  });

  test("an in-place update that does not rebuild leaves the env and the container alone", async () => {
    setSecret("vault", SECRET_VALUE);
    const { box } = await run("box.create", createInput("alpha", [{ name: "TOKEN", secretRef: "vault" }]));
    const renamed = await run("box.update", { id: box.id, name: "renamed", expectedRevision: "1" });
    expect(renamed.box.name).toBe("renamed");
    expect(renamed.box.env).toEqual([{ name: "TOKEN", secretRef: "vault" }]);
    expect(containerEnv(box.id)).toEqual([`TOKEN=${SECRET_VALUE}`]);
  });
});

describe("start and restart", () => {
  test("a stopped box whose secret was deleted by force does not start until the secret is set again", async () => {
    setSecret("vault", SECRET_VALUE);
    const { box } = await run("box.create", createInput("alpha", [{ name: "TOKEN", secretRef: "vault" }]));
    await run("box.action", { id: box.id, action: "stop" });
    await run("secret.delete", { name: "vault", force: true });

    const error = await rejectionOf(run("box.action", { id: box.id, action: "start" }));
    expect(error).toMatchObject({ status: 409, key: "env_secret_missing" });
    expect(runtime.containers.get(box.id)?.running).toBe(false);

    setSecret("vault", ROTATED_VALUE);
    const started = await run("box.action", { id: box.id, action: "start" });
    expect(started.box.running).toBe(true);
  });

  test("a restart is refused with 409 while the secret a box names is not set", async () => {
    setSecret("vault", SECRET_VALUE);
    const { box } = await run("box.create", createInput("alpha", [{ name: "TOKEN", secretRef: "vault" }]));
    await run("secret.delete", { name: "vault", force: true });
    const error = await rejectionOf(run("box.action", { id: box.id, action: "restart" }));
    expect(error).toMatchObject({ status: 409, key: "env_secret_missing" });
    expect(runtime.containers.get(box.id)?.running).toBe(true);
  });
});

describe("secret store operations", () => {
  test("a secret is set, replaced, listed and deleted, and no answer or event carries its value", async () => {
    const before = app.events.head();
    const set = await run<SecretResult>("secret.set", { name: "vault", value: SECRET_VALUE });
    expect(set).toMatchObject({ created: true, secret: { name: "vault", boxes: [] } });
    const replaced = await run<SecretResult>("secret.set", { name: "vault", value: ROTATED_VALUE });
    expect(replaced.created).toBe(false);

    const listed = await run<{ secrets: { name: string; boxes: string[] }[] }>("secret.list", {});
    expect(listed.secrets).toEqual([expect.objectContaining({ name: "vault", boxes: [] })]);

    const answers = JSON.stringify([set, replaced, listed]);
    expect(answers).not.toContain(SECRET_VALUE);
    expect(answers).not.toContain(ROTATED_VALUE);
    const events = JSON.stringify([app.events.after(before, {}, 20), app.activity.list()]);
    expect(events).not.toContain(SECRET_VALUE);
    expect(events).not.toContain(ROTATED_VALUE);
  });

  test("a name or value that breaks the rules is refused with its own key", async () => {
    expect(await rejectionOf(run("secret.set", { name: "bad name!", value: "x" }))).toMatchObject({
      status: 400,
      key: "secret_name_invalid",
    });
    expect(await rejectionOf(run("secret.set", { name: "vault", value: "" }))).toMatchObject({
      status: 400,
      key: "secret_value_invalid",
    });
    expect(await rejectionOf(run("secret.set", { name: "vault", value: "a\tb" }))).toMatchObject({
      status: 400,
      key: "secret_value_invalid",
    });
  });

  test("deleting a secret that a box uses is refused without force, and the answer names the box", async () => {
    setSecret("vault", SECRET_VALUE);
    await run("box.create", createInput("alpha", [{ name: "TOKEN", secretRef: "vault" }]));
    const refused = await rejectionOf(run("secret.delete", { name: "vault", force: false }));
    expect(refused).toMatchObject({ status: 409, key: "secret_in_use", details: { boxes: ["alpha"] } });
    expect(app.hosts.get().secrets.meta("vault")).not.toBeNull();
  });

  test("with force, the secret is deleted and the answer lists the boxes that still referred to it", async () => {
    setSecret("vault", SECRET_VALUE);
    await run("box.create", createInput("alpha", [{ name: "TOKEN", secretRef: "vault" }]));
    const forced = await run<{ name: string; boxes: string[] }>("secret.delete", { name: "vault", force: true });
    expect(forced).toEqual({ name: "vault", boxes: ["alpha"] });
    expect(app.hosts.get().secrets.meta("vault")).toBeNull();
  });

  test("deleting a secret that does not exist is a 404 with its own key", async () => {
    expect(await rejectionOf(run("secret.delete", { name: "nope", force: false }))).toMatchObject({
      status: 404,
      key: "secret_not_found",
    });
  });

  test("the box detail and the live box carry the secret's name only, and the plain value on the spec", async () => {
    setSecret("vault", SECRET_VALUE);
    const { box } = await run(
      "box.create",
      createInput("alpha", [
        { name: "TOKEN", secretRef: "vault" },
        { name: "GREETING", value: PLAIN_VALUE },
      ]),
    );
    const detail = await run("box.get", { id: box.id });
    expect(detail.box.env).toEqual([
      { name: "TOKEN", secretRef: "vault" },
      { name: "GREETING", value: PLAIN_VALUE },
    ]);
    expect(JSON.stringify(detail)).not.toContain(SECRET_VALUE);

    const live = liveBox(await getBox(app.hosts.get(), box.id));
    expect(live.env).toEqual([{ name: "TOKEN" }, { name: "GREETING" }]);
    expect(JSON.stringify(live)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(live)).not.toContain(PLAIN_VALUE);
  });
});

describe("the secret:use scope", () => {
  test("only the admin preset holds secret:use", () => {
    expect(presetPolicy("admin").scopes).toContain("secret:use");
    expect(presetPolicy("operator").scopes).not.toContain("secret:use");
    expect(presetPolicy("sandboxed-agent").scopes).not.toContain("secret:use");
    expect(presetPolicy("readonly").scopes).not.toContain("secret:use");
    expect(compileToken({ name: "scoped", scopes: ["box:write", "secret:use"] }).scopes).toContain("secret:use");
  });

  test("an operator token cannot create a box that names a secret, but can create one with plain values", async () => {
    setSecret("vault", SECRET_VALUE);
    const operator = principalOf(app, mint(app, { name: "op", preset: "operator" }).secret);
    const refused = await rejectionOf(
      run("box.create", createInput("agent-box", [{ name: "TOKEN", secretRef: "vault" }]), operator),
    );
    expect(refused).toMatchObject({ status: 403, key: "secret_reference_forbidden" });
    expect(app.hosts.get().specs.list()).toEqual([]);

    const plain = await run("box.create", createInput("agent-box", [{ name: "MODE", value: "dev" }]), operator);
    expect(plain.box.env).toEqual([{ name: "MODE", value: "dev" }]);
  });

  test("an admin token creates a box with a secret, and the container gets its value", async () => {
    setSecret("vault", SECRET_VALUE);
    const admin = principalOf(app, mint(app, { name: "root", preset: "admin" }).secret);
    const { box } = await run("box.create", createInput("admin-box", [{ name: "TOKEN", secretRef: "vault" }]), admin);
    expect(containerEnv(box.id)).toEqual([`TOKEN=${SECRET_VALUE}`]);
  });

  test("an operator token that can see a box with a secret cannot rebuild it, even to change only its profile", async () => {
    setSecret("vault", SECRET_VALUE);
    const { box } = await run("box.create", createInput("alpha", [{ name: "TOKEN", secretRef: "vault" }]));
    const operator = principalOf(
      app,
      mint(app, { name: "op", preset: "operator", boxes: { type: "ids", ids: [box.boxId] } }).secret,
    );
    const refused = await rejectionOf(
      run("box.rebuild", { id: box.id, profile: "strict", confirm: true, expectedRevision: "1" }, operator),
    );
    expect(refused).toMatchObject({ status: 403, key: "secret_reference_forbidden" });
    expect(runtime.containers.get(box.id)?.running).toBe(true);
  });

  test("an operator token may still update a box with a secret in place, since that is not a rebuild", async () => {
    setSecret("vault", SECRET_VALUE);
    const { box } = await run("box.create", createInput("alpha", [{ name: "TOKEN", secretRef: "vault" }]));
    const operator = principalOf(
      app,
      mint(app, { name: "op", preset: "operator", boxes: { type: "ids", ids: [box.boxId] } }).secret,
    );
    const renamed = await run("box.update", { id: box.id, name: "renamed", expectedRevision: "1" }, operator);
    expect(renamed.box.name).toBe("renamed");
  });
});

describe("snapshots and system images", () => {
  test("a snapshot of a box that names a secret is refused before anything is committed or queued", async () => {
    setSecret("vault", SECRET_VALUE);
    const { box } = await run("box.create", createInput("alpha", [{ name: "TOKEN", secretRef: "vault" }]));
    const error = await rejectionOf(
      app.operations.run("snapshot.create", contextFor(OWNER), { id: box.boxId, name: "nightly" }),
    );
    expect(error).toMatchObject({ status: 409, key: "secret_in_image", params: { env: "TOKEN", name: "vault" } });
    expect(runtime.callsTo("commitContainer")).toEqual([]);
    expect(app.tasks.list({ limit: 10 })).toEqual([]);
    expect(JSON.stringify(error)).not.toContain(SECRET_VALUE);
  });

  test("a checkpoint with a system image of a box that names a secret is refused before any backup starts", async () => {
    setSecret("vault", SECRET_VALUE);
    const { box } = await run("box.create", createInput("alpha", [{ name: "TOKEN", secretRef: "vault" }]));
    const error = await rejectionOf(
      run("checkpoint.create", {
        id: box.boxId,
        label: "before",
        include: { system: true, volumes: [] },
      }),
    );
    expect(error).toMatchObject({ status: 409, key: "secret_in_image" });
    expect(runtime.callsTo("commitContainer")).toEqual([]);
    expect(app.tasks.list({ limit: 10 })).toEqual([]);
  });

  test("a checkpoint without a system image is still taken for that box, and commits no image", async () => {
    setSecret("vault", SECRET_VALUE);
    const { box } = await run("box.create", createInput("alpha", [{ name: "TOKEN", secretRef: "vault" }]));
    const started = await run<{ taskId: string }>("checkpoint.create", {
      id: box.boxId,
      label: "before",
      include: { system: false, volumes: [] },
    });
    await app.tasks.done(started.taskId);
    expect(app.tasks.get(started.taskId, { output: false })?.status).toBe("succeeded");
    expect(runtime.callsTo("commitContainer")).toEqual([]);
  });
});

describe("REST", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = startHarness();
  });

  afterEach(() => harness.stop());

  test("PUT /api/secrets/:name stores a value that no read returns", async () => {
    const put = await call(harness.base, "/api/secrets/vault", { method: "PUT", body: { value: SECRET_VALUE } });
    expect(put.status).toBe(200);
    const list = await call(harness.base, "/api/secrets");
    expect(list.status).toBe(200);
    expect(JSON.stringify(put.json)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(list.json)).not.toContain(SECRET_VALUE);
    expect((list.json as unknown as { secrets: { name: string }[] }).secrets.map((s) => s.name)).toEqual(["vault"]);
  });

  test("a create that names a missing secret answers 400 with its key and the env field", async () => {
    const res = await call(harness.base, "/api/boxes", {
      body: { name: "alpha", env: [{ name: "TOKEN", secretRef: "absent" }] },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({ code: "validation_failed", key: "env_secret_missing" });
    expect(res.json.error?.details).toEqual({ field: "env" });
  });

  test("a token without secret:use is refused with 403 secret_reference_forbidden", async () => {
    setSecret("vault", SECRET_VALUE);
    const minted = mint(harness.app, { name: "op", preset: "operator" });
    const res = await call(harness.base, "/api/boxes", {
      token: minted.secret,
      body: { name: "agent", env: [{ name: "TOKEN", secretRef: "vault" }] },
    });
    expect(res.status).toBe(403);
    expect(res.json.error).toMatchObject({ code: "forbidden", key: "secret_reference_forbidden" });
  });

  test("a token cannot reach the secret routes at all", async () => {
    const minted = mint(harness.app, { name: "admin", preset: "admin" });
    const res = await call(harness.base, "/api/secrets", { token: minted.secret });
    expect(res.status).toBe(403);
  });

  function setSecret(name: string, value: string): void {
    harness.app.hosts.get().secrets.set(name, value, new Date().toISOString());
  }
});
