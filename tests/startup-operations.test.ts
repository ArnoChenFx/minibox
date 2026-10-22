import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import { type OperationContext, OWNER, type Principal } from "../src/operations/types";
import { saveBoxAsTemplate } from "../src/services/templates";
import { INIT_SESSION } from "../src/startup/command";
import type { TokenCreateInput } from "../src/tokens/model";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";
import { mint, principalOf } from "./support/tokens";

const FIRST = "echo startup-first-7c3e";
const SECOND = "echo startup-second-9a41";
const SNAPSHOT_REF = "mbtest-snap:nightly-20261022-000000";

interface BoxView {
  readonly id: string;
  readonly boxId: string;
  readonly name: string;
}

interface StartupView {
  readonly revision: number;
  readonly command: string | null;
  readonly status: string;
}

let app: App;
let runtime: FakeRuntime;
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  ({ app, runtime } = createTestApp({ labelPrefix: "mbtest" }));
  const host = app.hosts.get();
  runtime.seedImage(app.cfg.baseTemplateTag, { [host.keys.template]: "true", [host.keys.templateName]: "base" });
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

function run<T = unknown>(name: string, input: object, principal: Principal = OWNER): Promise<T> {
  return app.operations.run(name, contextFor(principal), input) as Promise<T>;
}

function refused(name: string, input: object, principal: Principal): Promise<unknown> {
  return rejectionOf(run(name, input, principal));
}

/** A token that may see every box, so a refusal is about the scope or the rule, not about which boxes it may see. */
function tokenWith(input: TokenCreateInput): Principal {
  return principalOf(app, mint(app, { boxes: { type: "all" }, ...input }).secret);
}

async function createBox(
  name: string,
  extra: { startupCommand?: string; template?: string } = {},
  principal: Principal = OWNER,
): Promise<BoxView> {
  const { box } = await run<{ box: BoxView }>("box.create", { name, cpus: 1, memoryMb: 256, ...extra }, principal);
  return box;
}

function startupOf(id: string, principal: Principal = OWNER): Promise<StartupView> {
  return run<StartupView>("box.startup.get", { id }, principal);
}

describe("startup command: reading and changing it", () => {
  test("the owner and the admin preset may read, set, remove and run a box's startup command", async () => {
    const box = await createBox("alpha", { startupCommand: FIRST });
    const admin = tokenWith({ name: "root", preset: "admin" });

    expect(await startupOf(box.id)).toMatchObject({ revision: 1, command: FIRST });
    expect(await run("box.startup.set", { id: box.id, command: SECOND, expectedRevision: "1" }, admin)).toMatchObject({
      revision: 2,
      command: SECOND,
    });
    expect(await run("box.startup.run", { id: box.id }, admin)).toMatchObject({ command: SECOND });
    expect(await run("box.startup.delete", { id: box.id, expectedRevision: "2" })).toMatchObject({
      revision: 3,
      command: null,
      status: "none",
    });
  });

  test("a token without secret:use is refused by scope on every startup operation, and nothing changes", async () => {
    const box = await createBox("alpha", { startupCommand: FIRST });
    const tokens = [
      tokenWith({ name: "operator", preset: "operator" }),
      tokenWith({ name: "readonly", preset: "readonly" }),
      tokenWith({ name: "agent", preset: "sandboxed-agent" }),
      tokenWith({ name: "exec-only", scopes: ["exec", "box:read", "box:write"] }),
    ];
    for (const token of tokens) {
      expect(await refused("box.startup.get", { id: box.id }, token)).toMatchObject({
        status: 403,
        key: "operation_forbidden",
      });
      expect(
        await refused("box.startup.set", { id: box.id, command: SECOND, expectedRevision: "1" }, token),
      ).toMatchObject({ status: 403, key: "operation_forbidden" });
      expect(await refused("box.startup.delete", { id: box.id, expectedRevision: "1" }, token)).toMatchObject({
        status: 403,
        key: "operation_forbidden",
      });
      expect(await refused("box.startup.run", { id: box.id }, token)).toMatchObject({
        status: 403,
        key: "operation_forbidden",
      });
    }
    expect(await startupOf(box.id)).toMatchObject({ revision: 1, command: FIRST });
  });

  test("a token with secret:use but not exec may read the command, and may not change or run it", async () => {
    const box = await createBox("alpha", { startupCommand: FIRST });
    const reader = tokenWith({ name: "reader", scopes: ["secret:use"] });

    expect(await startupOf(box.id, reader)).toMatchObject({ command: FIRST });
    for (const [name, input] of [
      ["box.startup.set", { id: box.id, command: SECOND, expectedRevision: "1" }],
      ["box.startup.delete", { id: box.id, expectedRevision: "1" }],
      ["box.startup.run", { id: box.id }],
    ] as const) {
      expect(await refused(name, input, reader)).toMatchObject({ status: 403, key: "startup_command_forbidden" });
    }
    expect(await startupOf(box.id)).toMatchObject({ revision: 1, command: FIRST });
  });

  test("a token with exec and secret:use may set, remove and run the command", async () => {
    const box = await createBox("alpha", { startupCommand: FIRST });
    const writer = tokenWith({ name: "writer", scopes: ["exec", "secret:use"] });

    expect(await run("box.startup.set", { id: box.id, command: SECOND, expectedRevision: "1" }, writer)).toMatchObject({
      revision: 2,
      command: SECOND,
    });
    expect(await run("box.startup.run", { id: box.id }, writer)).toMatchObject({ command: SECOND });
    expect(await run("box.startup.delete", { id: box.id, expectedRevision: "2" }, writer)).toMatchObject({
      command: null,
    });
  });
});

describe("startup command: giving a box one at create", () => {
  test("a create with a startup command needs exec and secret:use, and a refused create makes no box", async () => {
    const operator = tokenWith({ name: "operator", preset: "operator" });
    const secretOnly = tokenWith({ name: "secret-only", scopes: ["box:write", "secret:use"] });

    for (const token of [operator, secretOnly]) {
      expect(
        await refused("box.create", { name: "agent-box", cpus: 1, memoryMb: 256, startupCommand: FIRST }, token),
      ).toMatchObject({ status: 403, key: "startup_command_forbidden" });
    }
    expect(app.hosts.get().specs.list()).toEqual([]);
    expect(runtime.callsTo("createContainer")).toEqual([]);
  });

  test("a create without a startup command needs neither, and the box starts with none", async () => {
    const operator = tokenWith({ name: "operator", preset: "operator" });
    const box = await createBox("plain", {}, operator);

    expect(await startupOf(box.id)).toMatchObject({ command: null, status: "none" });
  });

  test("an admin token creates a box with a startup command, and the command is kept", async () => {
    const admin = tokenWith({ name: "root", preset: "admin" });
    const box = await createBox("admin-box", { startupCommand: FIRST }, admin);

    expect(await startupOf(box.id)).toMatchObject({ command: FIRST });
  });

  test("a box made from a template or a snapshot does not inherit its source's startup command", async () => {
    const source = await createBox("source", { startupCommand: FIRST });
    const saved = await saveBoxAsTemplate(app.hosts.get(), source.boxId, { name: "gold" }, "owner");
    const fromTemplate = await createBox("from-template", { template: saved.ref });

    const keys = app.hosts.get().keys;
    runtime.seedImage(SNAPSHOT_REF, { [keys.snapshot]: "true", [keys.snapshotOf]: "source" });
    const fromSnapshot = await run<{ box: BoxView }>("snapshot.fork", { name: "from-snapshot", ref: SNAPSHOT_REF });

    expect(await startupOf(fromTemplate.id)).toMatchObject({ command: null, status: "none" });
    expect(await startupOf(fromSnapshot.box.id)).toMatchObject({ command: null, status: "none" });
    expect(await startupOf(source.id)).toMatchObject({ command: FIRST });
  });
});

describe("startup command: the minibox-init session", () => {
  test("a token without secret:use does not see the init session in a box's session list", async () => {
    const box = await createBox("alpha", { startupCommand: FIRST });
    await run("session.start", { id: box.id, name: "work" });
    const operator = tokenWith({ name: "operator", preset: "operator" });

    const ownerSees = (await run<{ sessions: { name: string }[] }>("session.list", { id: box.id })).sessions;
    const operatorSees = (await run<{ sessions: { name: string }[] }>("session.list", { id: box.id }, operator))
      .sessions;

    expect(ownerSees.map((session) => session.name)).toEqual(expect.arrayContaining([INIT_SESSION, "work"]));
    expect(operatorSees.map((session) => session.name)).toEqual(["work"]);
  });

  test("reading, typing into, starting or closing the init session is refused to a token without secret:use", async () => {
    const box = await createBox("alpha", { startupCommand: FIRST });
    const operator = tokenWith({ name: "operator", preset: "operator" });

    expect(await refused("session.read", { id: box.id, name: INIT_SESSION }, operator)).toMatchObject({
      status: 403,
      key: "startup_session_forbidden",
    });
    expect(await refused("session.send", { id: box.id, name: INIT_SESSION, text: "ls\n" }, operator)).toMatchObject({
      status: 403,
      key: "startup_session_forbidden",
    });
    expect(await refused("session.close", { id: box.id, name: INIT_SESSION }, operator)).toMatchObject({
      status: 403,
      key: "startup_session_forbidden",
    });
    expect(await refused("session.start", { id: box.id, name: INIT_SESSION }, operator)).toMatchObject({
      status: 403,
      key: "startup_session_forbidden",
    });
  });

  test("the owner and the admin preset may read the init session", async () => {
    const box = await createBox("alpha", { startupCommand: FIRST });
    const admin = tokenWith({ name: "root", preset: "admin" });

    expect(await run("session.read", { id: box.id, name: INIT_SESSION })).toMatchObject({ session: INIT_SESSION });
    expect(await run("session.read", { id: box.id, name: INIT_SESSION }, admin)).toMatchObject({
      session: INIT_SESSION,
    });
  });

  test("the init session is refused by its name, while another session of the same box still reads", async () => {
    const box = await createBox("alpha", { startupCommand: FIRST });
    await run("session.start", { id: box.id, name: "work" });
    const operator = tokenWith({ name: "operator", preset: "operator" });

    expect(await run("session.read", { id: box.id, name: "work" }, operator)).toMatchObject({ session: "work" });
    expect(await refused("session.read", { id: box.id, name: INIT_SESSION }, operator)).toMatchObject({
      key: "startup_session_forbidden",
    });
  });
});

describe("startup command: what the event log and the box views keep", () => {
  test("the command text is kept out of the event log, the box views and the activity feed", async () => {
    const secret = "echo startup-text-never-logged-5f1a";
    const box = await createBox("alpha", { startupCommand: secret });
    await run("box.startup.set", { id: box.id, command: `${secret} && echo two`, expectedRevision: "1" });
    await run("box.startup.run", { id: box.id });
    expect(JSON.stringify(await startupOf(box.id))).toContain("startup-text-never-logged");
    await run("box.startup.delete", { id: box.id, expectedRevision: "2" });

    const events = app.events.list({}, { limit: 500 }).events;
    const ops = events.map((event) => event.op);
    expect(ops).toEqual(
      expect.arrayContaining(["box.create", "box.startup.set", "box.startup.run", "box.startup.delete"]),
    );
    expect(JSON.stringify(events)).not.toContain("startup-text-never-logged");
    expect(JSON.stringify(await run("box.get", { id: box.id }))).not.toContain("startup-text-never-logged");
    expect(JSON.stringify(await run("box.list", {}))).not.toContain("startup-text-never-logged");
  });
});
