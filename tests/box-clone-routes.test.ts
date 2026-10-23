import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { HelperResult, HelperSpec } from "../src/runtime";
import { silenceLogs } from "./support/app";
import { call, finishedTask, type Harness, mint, refused, startHarness } from "./support/tokens";

let harness: Harness;
let restoreLogs: () => void;
let clones: HelperSpec[];
let answer: (spec: HelperSpec) => HelperResult;

beforeEach(() => {
  restoreLogs = silenceLogs();
  harness = startHarness();
  clones = [];
  answer = () => ({ exitCode: 0, logs: "Cloning into '/workspace'...\n" });
  harness.runtime.helperHandler = (spec) => {
    if (spec.cmd[2]?.includes("credential.helper=")) {
      clones.push(spec);
      return answer(spec);
    }
    return { exitCode: 0, logs: "" };
  };
});

afterEach(() => {
  harness.stop();
  restoreLogs();
});

const repo = { url: "https://github.com/org/app.git", branch: "main" };

async function boxNames(): Promise<string[]> {
  const listed = await call(harness.base, "/api/boxes");
  return (listed.json.boxes ?? []).map((box) => box.name);
}

describe("creating a box with a repository", () => {
  test("answers 201 with a clone task that clones into /workspace, and the box is running on the clone's success", async () => {
    const created = await call(harness.base, "/api/boxes", {
      body: { name: "alpha", cpus: 1, memoryMb: 256, repo },
    });

    expect(created.status).toBe(201);
    const taskId = created.json.clone?.taskId ?? "";
    expect(taskId).not.toBe("");
    expect(created.json.setup?.taskId).toBe(taskId);
    expect((await finishedTask(harness.base, taskId)).status).toBe("succeeded");
    expect(clones).toHaveLength(1);
    expect(clones[0]?.mounts?.[0]).toMatchObject({ target: "/workspace", mode: "rw" });
    expect(clones[0]?.cmd.slice(5, 7)).toEqual([repo.url, "main"]);
  });

  test("a box created without a repository has no clone and starts no clone task", async () => {
    const created = await call(harness.base, "/api/boxes", { body: { name: "plain", cpus: 1, memoryMb: 256 } });
    expect(created.status).toBe(201);
    expect(created.json.clone).toBeUndefined();
    expect(created.json.setup).toBeUndefined();
    expect(clones).toEqual([]);
  });

  test("the clone runs on the first create only: restarting the box clones nothing", async () => {
    const created = await call(harness.base, "/api/boxes", { body: { name: "alpha", cpus: 1, memoryMb: 256, repo } });
    await finishedTask(harness.base, created.json.clone?.taskId ?? "");
    const boxId = created.json.box?.boxId ?? "";

    const restarted = await call(harness.base, `/api/boxes/${boxId}/restart`, { method: "POST" });

    expect(restarted.status).toBe(200);
    expect(clones).toHaveLength(1);
  });

  test("a clone that fails leaves the box in place and fails the task with clone_failed", async () => {
    answer = () => ({ exitCode: 128, logs: "fatal: repository 'https://github.com/org/app.git/' not found\n" });
    const created = await call(harness.base, "/api/boxes", { body: { name: "alpha", cpus: 1, memoryMb: 256, repo } });

    const done = await finishedTask(harness.base, created.json.clone?.taskId ?? "");

    expect(done.status).toBe("failed");
    expect(done.error?.key).toBe("clone_failed");
    expect(await boxNames()).toContain("alpha");
  });

  test("a clone's output never shows the secret it was given", async () => {
    harness.app.hosts.get().secrets.set("gh-token", "ghp_do_not_show", "2026-10-22T00:00:00.000Z");
    answer = () => ({ exitCode: 0, logs: "remote: auth ghp_do_not_show\n" });
    const created = await call(harness.base, "/api/boxes", {
      body: { name: "alpha", cpus: 1, memoryMb: 256, repo: { ...repo, secretRef: "gh-token" } },
    });

    const taskId = created.json.clone?.taskId ?? "";
    await finishedTask(harness.base, taskId);
    const view = await call(harness.base, `/api/tasks/${taskId}`);

    expect((view.json as unknown as { output?: string }).output).toContain("[secret]");
    expect(JSON.stringify(view.json)).not.toContain("ghp_do_not_show");
  });

  test("a repository secret that is not set is refused with 400, and no box is created", async () => {
    const before = await boxNames();

    const reply = await call(harness.base, "/api/boxes", {
      body: { name: "alpha", cpus: 1, memoryMb: 256, repo: { ...repo, secretRef: "missing" } },
    });

    expect(reply.status).toBe(400);
    expect(reply.json.error).toMatchObject({ code: "validation_failed", details: { field: "repo" } });
    expect(await boxNames()).toEqual(before);
  });

  test("a box whose mounts give no writable /workspace is refused with 400 on the repo field", async () => {
    const reply = await call(harness.base, "/api/boxes", {
      body: { name: "alpha", cpus: 1, memoryMb: 256, repo, mounts: [] },
    });
    expect(reply.status).toBe(400);
    expect(reply.json.error?.key).toBe("repo_needs_workspace");
  });

  test("a repository URL with a password in it is refused with 400, and the password is not echoed", async () => {
    const reply = await call(harness.base, "/api/boxes", {
      body: { name: "alpha", cpus: 1, memoryMb: 256, repo: { url: "https://user:hunter2@github.com/org/app.git" } },
    });
    expect(reply.status).toBe(400);
    expect(reply.json.error?.key).toBe("repo_url_credentials");
    expect(JSON.stringify(reply.json)).not.toContain("hunter2");
  });

  test("a token without secret:use may not clone with a secret, and one with it may", async () => {
    harness.app.hosts.get().secrets.set("gh-token", "ghp_example", "2026-10-22T00:00:00.000Z");
    const plain = mint(harness.app, { name: "operator", preset: "operator" });
    const admin = mint(harness.app, { name: "admin", preset: "admin" });

    const refusedReply = await call(harness.base, "/api/boxes", {
      token: plain.secret,
      body: { name: "by-operator", cpus: 1, memoryMb: 256, repo: { ...repo, secretRef: "gh-token" } },
    });
    expect(refused(refusedReply)).toEqual({ status: 403, key: "secret_reference_forbidden" });

    const allowed = await call(harness.base, "/api/boxes", {
      token: admin.secret,
      body: { name: "by-admin", cpus: 1, memoryMb: 256, repo: { ...repo, secretRef: "gh-token" } },
    });
    expect(allowed.status).toBe(201);
    expect(allowed.json.clone?.taskId).toBeDefined();
  });

  test("a token may clone a public repository without a secret", async () => {
    const plain = mint(harness.app, { name: "operator", preset: "operator" });
    const reply = await call(harness.base, "/api/boxes", {
      token: plain.secret,
      body: { name: "public", cpus: 1, memoryMb: 256, repo: { url: "https://github.com/org/public.git" } },
    });
    expect(reply.status).toBe(201);
  });
});
