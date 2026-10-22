import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HostCtx } from "../src/host/registry";
import { createLocalHost } from "../src/host/registry";
import type { TokenPrincipal } from "../src/operations/types";
import { RuntimeError } from "../src/runtime";
import { SpecStore } from "../src/specs/store";
import { VolumeStore } from "../src/volumes/store";
import { rejectionOf, silenceLogs } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";
import {
  call,
  finishedTask,
  type Harness,
  mint,
  principalOf,
  refused,
  type Reply,
  startHarness,
} from "./support/tokens";

let harness: Harness;
let restoreLogs: () => void;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  restoreLogs = silenceLogs();
  harness = startHarness();
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  harness.stop();
  restoreLogs();
});

async function createBox(token: string, name: string, extra: Record<string, unknown> = {}) {
  return call(harness.base, "/api/boxes", { token, body: { name, cpus: 1, memoryMb: 256, ...extra } });
}

function takeAs(boxId: string, token?: string) {
  return call(harness.base, `/api/boxes/${boxId}/checkpoints`, { method: "POST", body: {}, token });
}

/** How a take ends: `succeeded`, or the key of its refusal, whether the refusal came at once or from its task. */
async function outcomeOf(reply: Reply): Promise<string> {
  if (reply.status !== 202) return reply.json.error?.key ?? String(reply.status);
  const taskId = reply.json.taskId ?? "";
  const done = await finishedTask(harness.base, taskId);
  if (done.status === "succeeded") return "succeeded";
  return (await call(harness.base, `/api/tasks/${taskId}`)).json.error?.key ?? done.status;
}

function tokenMade(boxId: string, tokenId: string) {
  return harness.app.hosts
    .get()
    .checkpoints.list()
    .filter((record) => record.boxId === boxId && record.createdBy === tokenId);
}

/** A second host with its own engine and stores, registered beside the local one. */
function addEdgeHost(): { host: HostCtx; runtime: FakeRuntime } {
  const runtime = new FakeRuntime();
  const dir = mkdtempSync(join(tmpdir(), "minibox-edge-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const host = createLocalHost(harness.app.cfg, runtime, new SpecStore(dir), new VolumeStore(dir));
  host.host.id = "edge";
  host.host.name = "Edge";
  harness.app.hosts.add(host);
  const keys = host.keys;
  runtime.seedImage(harness.app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  return { host, runtime };
}

/** The context an operation runs in when a token calls it on a given host, as the server builds it. */
function contextOn(host: HostCtx, principal: TokenPrincipal) {
  return {
    host,
    principal,
    source: "rest" as const,
    events: harness.app.events,
    tokens: harness.app.tokens,
    execs: harness.app.execs,
    terminals: harness.app.terminals,
  };
}

describe("box count, TTL and profile limits", () => {
  test("two creates that race for the last box slot cannot both succeed", async () => {
    const token = mint(harness.app, { name: "single", preset: "operator", quotas: { maxBoxes: 1 } });
    const [first, second] = await Promise.all([createBox(token.secret, "one"), createBox(token.secret, "two")]);
    expect([first.status, second.status].toSorted()).toEqual([201, 403]);
    const loser = first.status === 403 ? first : second;
    expect(refused(loser)).toEqual({ status: 403, key: "quota_boxes" });
    const listed = await call(harness.base, "/api/boxes", { token: token.secret });
    expect(listed.json.boxes).toHaveLength(1);
  });

  test("a TTL cap is stored when a create or an update omits the TTL or clears it, and a longer one is refused", async () => {
    const token = mint(harness.app, { name: "capped", preset: "operator", quotas: { maxTtlSec: 3600 } });
    const omitted = await createBox(token.secret, "omitted");
    expect(omitted.json.box?.ttlSec).toBe(3600);
    const cleared = await createBox(token.secret, "cleared", { ttlSec: null });
    expect(cleared.json.box?.ttlSec).toBe(3600);
    expect(refused(await createBox(token.secret, "long", { ttlSec: 7200 }))).toEqual({
      status: 403,
      key: "quota_ttl",
    });

    const id = cleared.json.box?.id ?? "";
    const patch = (body: unknown, revision: number) =>
      call(harness.base, `/api/boxes/${id}`, {
        method: "PATCH",
        token: token.secret,
        body,
        headers: { "if-match": String(revision) },
      });
    const reset = await patch({ ttlSec: null }, 1);
    expect(reset.status).toBe(200);
    expect(reset.json.box?.ttlSec).toBe(3600);
    expect(refused(await patch({ ttlSec: 7200 }, 2))).toEqual({ status: 403, key: "quota_ttl" });
    const shorter = await patch({ ttlSec: 1800 }, 2);
    expect(shorter.json.box?.ttlSec).toBe(1800);
  });

  test("a token creates, rebuilds and forks only with standard or strict profiles, and never lowers a box's profile", async () => {
    const token = mint(harness.app, { name: "profiled", preset: "operator" });
    expect(refused(await createBox(token.secret, "relaxed", { profile: "relaxed" }))).toEqual({
      status: 403,
      key: "profile_not_allowed",
    });

    const strict = await createBox(token.secret, "strict-box", { profile: "strict" });
    expect(strict.status).toBe(201);
    expect(strict.json.box?.profile).toBe("strict");
    const id = strict.json.box?.id ?? "";
    const rebuild = (body: unknown) =>
      call(harness.base, `/api/boxes/${id}/rebuild`, {
        token: token.secret,
        body,
        headers: { "if-match": "1" },
      });
    expect(refused(await rebuild({ profile: "standard" }))).toEqual({ status: 403, key: "profile_not_allowed" });
    expect(refused(await rebuild({ profile: "relaxed" }))).toEqual({ status: 403, key: "profile_not_allowed" });

    const keys = harness.app.hosts.get().keys;
    harness.runtime.seedImage("mbtest-snapshot:own", {
      [keys.snapshot]: "true",
      [keys.createdBy]: token.id,
    });
    const fork = await call(harness.base, "/api/snapshots/mbtest-snapshot%3Aown/boxes", {
      token: token.secret,
      body: { name: "copy", cpus: 1, memoryMb: 256, profile: "relaxed" },
    });
    expect(refused(fork)).toEqual({ status: 403, key: "profile_not_allowed" });
  });
});

describe("boxes on every host", () => {
  test("a box on another host counts toward the token's limit", async () => {
    const edge = addEdgeHost();
    const token = mint(harness.app, {
      name: "roamer",
      preset: "operator",
      hosts: { type: "all" },
      quotas: { maxBoxes: 2 },
    });
    const principal = principalOf(harness.app, token.secret);

    expect((await createBox(token.secret, "near")).status).toBe(201);
    await harness.app.operations.run("box.create", contextOn(edge.host, principal), {
      name: "far",
      cpus: 1,
      memoryMb: 256,
    });
    expect(edge.host.specs.list().map((spec) => spec.name)).toEqual(["far"]);

    const error = await rejectionOf(
      harness.app.operations.run("box.create", contextOn(edge.host, principal), {
        name: "third",
        cpus: 1,
        memoryMb: 256,
      }),
    );
    expect(error).toMatchObject({ key: "quota_boxes" });
  });

  test("revoking a token with deleteCreated deletes its boxes on every host", async () => {
    const edge = addEdgeHost();
    const token = mint(harness.app, { name: "roamer", preset: "operator", hosts: { type: "all" } });
    const principal = principalOf(harness.app, token.secret);
    expect((await createBox(token.secret, "near")).status).toBe(201);
    await harness.app.operations.run("box.create", contextOn(edge.host, principal), {
      name: "far",
      cpus: 1,
      memoryMb: 256,
    });

    const revoked = await call(harness.base, `/api/tokens/${token.id}?deleteCreated=true`, { method: "DELETE" });
    expect(revoked.status).toBe(200);
    expect((revoked.json.deletedBoxes ?? []).toSorted()).toEqual(["far", "near"]);
    expect(revoked.json.failedBoxes).toEqual([]);
    expect(edge.host.specs.list()).toEqual([]);
    expect(edge.runtime.callsTo("removeContainer").length).toBeGreaterThan(0);
  });

  test("a box that cannot be deleted is reported with its host, and the token's other boxes still go", async () => {
    const edge = addEdgeHost();
    const token = mint(harness.app, { name: "roamer", preset: "operator", hosts: { type: "all" } });
    const principal = principalOf(harness.app, token.secret);
    expect((await createBox(token.secret, "near")).status).toBe(201);
    await harness.app.operations.run("box.create", contextOn(edge.host, principal), {
      name: "far",
      cpus: 1,
      memoryMb: 256,
    });
    edge.runtime.fail("removeContainer", new RuntimeError("engine", "engine refused", "engine refused"));

    const revoked = await call(harness.base, `/api/tokens/${token.id}?deleteCreated=true`, { method: "DELETE" });
    expect(revoked.status).toBe(200);
    expect(revoked.json.deletedBoxes).toEqual(["near"]);
    expect(revoked.json.failedBoxes).toEqual([
      expect.objectContaining({ name: "far", hostId: "edge", message: expect.any(String) }),
    ]);
    expect(edge.host.specs.list().map((spec) => spec.name)).toEqual(["far"]);
    const owner = await call(harness.base, "/api/boxes");
    expect(owner.json.boxes?.map((box) => box.name)).toEqual([]);
  });
});

describe("checkpoint count limit", () => {
  test("a token's own checkpoints stop at its limit, and the refusal starts no task", async () => {
    const token = mint(harness.app, { name: "snapper", preset: "operator", quotas: { maxCheckpoints: 2 } });
    const boxId = (await createBox(token.secret, "alpha")).json.box?.boxId ?? "";

    expect(await outcomeOf(await takeAs(boxId, token.secret))).toBe("succeeded");
    expect(await outcomeOf(await takeAs(boxId, token.secret))).toBe("succeeded");
    expect(refused(await takeAs(boxId, token.secret))).toEqual({ status: 403, key: "quota_checkpoints" });
    expect(tokenMade(boxId, token.id)).toHaveLength(2);
  });

  test("the owner's checkpoints, and the safety point a token's rollback takes, do not count toward its limit", async () => {
    const token = mint(harness.app, { name: "limited", preset: "operator", quotas: { maxCheckpoints: 1 } });
    const boxId = (await createBox(token.secret, "alpha")).json.box?.boxId ?? "";
    const owned = await call(harness.base, `/api/boxes/${boxId}/checkpoints`, { method: "POST", body: {} });
    const target = (await finishedTask(harness.base, owned.json.taskId ?? "")).result?.checkpoint?.id ?? "";
    const revision = harness.app.hosts.get().specs.read(boxId)?.revision ?? 0;

    const rolled = await call(harness.base, `/api/boxes/${boxId}/rollback`, {
      method: "POST",
      token: token.secret,
      body: { checkpoint: target, confirm: true },
      headers: { "if-match": String(revision) },
    });
    expect(rolled.status).toBe(202);
    expect((await finishedTask(harness.base, rolled.json.taskId ?? "")).status).toBe("succeeded");

    expect(await outcomeOf(await takeAs(boxId, token.secret))).toBe("succeeded");
    expect(await outcomeOf(await takeAs(boxId, token.secret))).toBe("quota_checkpoints");
  });

  test("two takes that race for a token's last place cannot both succeed, even on different boxes", async () => {
    const token = mint(harness.app, { name: "racer", preset: "operator", quotas: { maxCheckpoints: 1 } });
    const first = (await createBox(token.secret, "alpha")).json.box?.boxId ?? "";
    const second = (await createBox(token.secret, "beta")).json.box?.boxId ?? "";

    const replies = await Promise.all([takeAs(first, token.secret), takeAs(second, token.secret)]);
    const outcomes = await Promise.all(replies.map(outcomeOf));

    expect(outcomes.toSorted()).toEqual(["quota_checkpoints", "succeeded"]);
    expect(
      harness.app.hosts
        .get()
        .checkpoints.list()
        .filter((record) => record.createdBy === token.id),
    ).toHaveLength(1);
  });

  test("the sandboxed-agent preset allows twenty checkpoints", () => {
    const agent = mint(harness.app, { name: "agent", preset: "sandboxed-agent" });
    expect(principalOf(harness.app, agent.secret).grants.quotas.maxCheckpoints).toBe(20);
  });

  test("a checkpoint limit must be a whole number of at least one", async () => {
    for (const value of [0, 1.5]) {
      const reply = await call(harness.base, "/api/tokens", {
        body: { name: `bad-${String(value).replace(".", "-")}`, preset: "operator", quotas: { maxCheckpoints: value } },
      });
      expect(reply.status).toBe(400);
      expect(reply.json.error?.code).toBe("validation_failed");
    }
  });
});
