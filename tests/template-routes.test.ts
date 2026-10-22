import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { RuntimeError } from "../src/runtime";
import { silenceLogs } from "./support/app";
import { call, finishedTask, type Harness, mint, refused, startHarness } from "./support/tokens";

let harness: Harness;
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  harness = startHarness();
});

afterEach(() => {
  harness.stop();
  restoreLogs();
});

const FROM = "FROM alpine:3.20\nRUN echo built\n";
const ref = (name: string) => encodeURIComponent(`mbtest-template:${name}`);

async function createTemplate(name: string, text = FROM) {
  return call(harness.base, "/api/templates", { body: { name, source: { kind: "dockerfile", text } } });
}

describe("creating a template from a Dockerfile over REST", () => {
  test("answers 202 with a task whose log carries the build, and the template lists with its build kind", async () => {
    const started = await createTemplate("tool");
    expect(started.status).toBe(202);
    const taskId = started.json.taskId ?? "";

    const done = await finishedTask(harness.base, taskId);

    expect(done.status).toBe("succeeded");
    const view = await call(harness.base, `/api/tasks/${taskId}`);
    expect((view.json as unknown as { output?: string }).output).toContain("Successfully built");
    const listed = await call(harness.base, "/api/templates");
    expect(listed.json.templates?.find((t) => t.name === "tool")).toMatchObject({
      ref: "mbtest-template:tool",
      buildKind: "dockerfile",
      description: "Built from a Dockerfile",
    });
  });

  test("a name already taken is refused with 409 before any build starts", async () => {
    const first = await createTemplate("tool");
    await finishedTask(harness.base, first.json.taskId ?? "");
    const again = await createTemplate("tool");
    expect(refused(again)).toEqual({ status: 409, key: "template_name_taken" });
  });

  test("while a build runs, a box saved as the same name is refused instead of losing its tag to the build", async () => {
    const gate = harness.runtime.hold("buildImage");
    const started = await createTemplate("tool");
    expect(started.status).toBe(202);
    while (!harness.runtime.calls.some((c) => c.op === "buildImage")) await Bun.sleep(5);
    const made = await call(harness.base, "/api/boxes", { body: { name: "alpha", cpus: 1, memoryMb: 256 } });
    expect(made.status).toBe(201);

    const saved = await call(harness.base, `/api/boxes/${made.json.box?.boxId ?? ""}/template`, {
      body: { name: "tool" },
    });
    gate.release();

    const savedTask = saved.status === 202 ? await finishedTask(harness.base, saved.json.taskId ?? "") : null;
    expect(saved.status === 409 || savedTask?.status === "failed").toBe(true);
    expect((await finishedTask(harness.base, started.json.taskId ?? "")).status).toBe("succeeded");
  });

  test("a Dockerfile that is not one is refused with 400 on the source field", async () => {
    const reply = await createTemplate("tool", "RUN nothing\n");
    expect(reply.status).toBe(400);
    expect(reply.json.error).toMatchObject({ code: "validation_failed", details: { field: "source" } });
  });

  test("a name that is not valid is refused with 400 on the name field", async () => {
    const reply = await call(harness.base, "/api/templates", {
      body: { name: "Not Valid!", source: { kind: "dockerfile", text: FROM } },
    });
    expect(reply.status).toBe(400);
    expect(reply.json.error).toMatchObject({ code: "validation_failed", details: { field: "name" } });
  });

  test("a build that fails ends the task as failed, leaves no template, and says why", async () => {
    harness.runtime.fail("buildImage", new RuntimeError("engine", "step 2: exit code 1"));
    const started = await createTemplate("broken");

    const done = await finishedTask(harness.base, started.json.taskId ?? "");

    expect(done.status).toBe("failed");
    const listed = await call(harness.base, "/api/templates");
    expect(listed.json.templates?.map((t) => t.name)).not.toContain("broken");
  });

  test("a token, even one with every scope, may not build a template", async () => {
    const token = mint(harness.app, { name: "everything", preset: "admin" });
    const reply = await call(harness.base, "/api/templates", {
      token: token.secret,
      body: { name: "tool", source: { kind: "dockerfile", text: FROM } },
    });
    expect(reply.status).toBe(403);
  });
});

describe("rebuilding a declared template over REST", () => {
  test("answers 202, and the task succeeds with a new image under the same name", async () => {
    const created = await createTemplate("tool");
    await finishedTask(harness.base, created.json.taskId ?? "");
    const before = (await harness.runtime.inspectImage("mbtest-template:tool")).id;

    const started = await call(harness.base, `/api/templates/${ref("tool")}/rebuild`, { method: "POST" });

    expect(started.status).toBe(202);
    expect((await finishedTask(harness.base, started.json.taskId ?? "")).status).toBe("succeeded");
    expect((await harness.runtime.inspectImage("mbtest-template:tool")).id).not.toBe(before);
  });

  test("a template the recipe did not build is refused with 400 before any task starts", async () => {
    const keys = harness.app.hosts.get().keys;
    harness.runtime.seedImage("mbtest-template:saved", { [keys.template]: "true", [keys.templateName]: "saved" });
    const reply = await call(harness.base, `/api/templates/${ref("saved")}/rebuild`, { method: "POST" });
    expect(reply.status).toBe(400);
    expect(reply.json.error?.key).toBe("template_not_declared");
  });

  test("a token may not rebuild a template", async () => {
    const created = await createTemplate("tool");
    await finishedTask(harness.base, created.json.taskId ?? "");
    const token = mint(harness.app, { name: "everything", preset: "admin" });
    const reply = await call(harness.base, `/api/templates/${ref("tool")}/rebuild`, {
      method: "POST",
      token: token.secret,
    });
    expect(reply.status).toBe(403);
  });
});

describe("pulling an image over REST", () => {
  test("answers 202, the task pulls the image and logs its layers", async () => {
    const started = await call(harness.base, "/api/images/pull", { body: { ref: "alpine:3.20" } });
    expect(started.status).toBe(202);

    const done = await finishedTask(harness.base, started.json.taskId ?? "");

    expect(done.status).toBe("succeeded");
    const view = await call(harness.base, `/api/tasks/${started.json.taskId}`);
    expect((view.json as unknown as { output?: string }).output).toContain("Pull complete");
    await harness.runtime.inspectImage("alpine:3.20");
  });

  test("a MiniBox image is refused with 400 before any pull", async () => {
    const reply = await call(harness.base, "/api/images/pull", { body: { ref: "mbtest-template:gold" } });
    expect(reply.status).toBe(400);
    expect(reply.json.error?.key).toBe("template_image_missing");
    expect(harness.runtime.callsTo("pullImage")).toEqual([]);
  });

  test("a reference the registry does not hold fails the task with image_not_found", async () => {
    harness.runtime.unpullable.add("nope:404");
    const started = await call(harness.base, "/api/images/pull", { body: { ref: "nope:404" } });

    const done = await finishedTask(harness.base, started.json.taskId ?? "");

    expect(done.status).toBe("failed");
    expect(done.error).toMatchObject({ key: "image_not_found" });
  });

  test("a token may not pull an image", async () => {
    const token = mint(harness.app, { name: "everything", preset: "admin" });
    const reply = await call(harness.base, "/api/images/pull", { token: token.secret, body: { ref: "alpine:3.20" } });
    expect(reply.status).toBe(403);
  });

  test("a reference that is not an image name is refused with 400 on the ref field", async () => {
    const reply = await call(harness.base, "/api/images/pull", { body: { ref: "has space" } });
    expect(reply.status).toBe(400);
    expect(reply.json.error).toMatchObject({ code: "validation_failed", details: { field: "ref" } });
  });
});
