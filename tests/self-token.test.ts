import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { questionsPath, selfTokensPath } from "../src/data-dir";
import { AppError } from "../src/lib/errors";
import { RuntimeError } from "../src/runtime";
import { SELF_QUOTA } from "../src/tokens/self-policy";
import { SelfTokenStore } from "../src/tokens/self-store";
import { silenceLogs } from "./support/app";
import { bootCluster, boxOn, type Cluster } from "./support/cluster";
import { selfTokenFileOf, selfTokenOf } from "./support/self";
import { type Body, call, finishedTask, type Harness, startHarness } from "./support/tokens";

const BOX = "bx_01arz3ndektsv4rrffq69g5fav";
const OTHER = "bx_01brz3ndektsv4rrffq69g5fav";

type BoxView = NonNullable<Body["box"]> & { selfToken?: boolean };

describe("the self token store", () => {
  let dir: string;
  let restoreLogs: () => void;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "self-token-store-"));
    restoreLogs = silenceLogs();
  });
  afterEach(() => {
    restoreLogs();
    rmSync(dir, { recursive: true, force: true });
  });

  const open = (now: () => number = Date.now) => new SelfTokenStore({ file: join(dir, "self-tokens.json"), now });

  test("a token authenticates as its own box, and nothing else authenticates", () => {
    const store = open();
    const secret = store.issue(BOX, "alpha");
    expect(secret.startsWith("mbx_")).toBe(true);
    expect(store.authenticate(secret)).toEqual({ type: "box-self", id: BOX, name: "alpha" });
    expect(store.authenticate(`${secret}x`)).toBeNull();
    expect(store.authenticate("")).toBeNull();
  });

  test("issuing again replaces the token: the old one stops, and its watchers hear it", () => {
    const store = open();
    const first = store.issue(BOX, "alpha");
    let ended = 0;
    store.watch(BOX, () => {
      ended += 1;
    });
    const second = store.issue(BOX, "alpha");
    expect(ended).toBe(1);
    expect(store.authenticate(first)).toBeNull();
    expect(store.authenticate(second)?.id).toBe(BOX);
  });

  test("revoking ends the token once, and tells its watchers", () => {
    const store = open();
    const secret = store.issue(BOX, "alpha");
    let ended = 0;
    store.watch(BOX, () => {
      ended += 1;
    });
    expect(store.revoke(BOX)).toBe(true);
    expect(store.revoke(BOX)).toBe(false);
    expect(ended).toBe(1);
    expect(store.has(BOX)).toBe(false);
    expect(store.authenticate(secret)).toBeNull();
  });

  test("a watch on a box with no token fires at once, and a stopped watch stays quiet", () => {
    const store = open();
    let fired = 0;
    store.watch(OTHER, () => {
      fired += 1;
    });
    expect(fired).toBe(1);

    const secret = store.issue(BOX, "alpha");
    let ended = 0;
    const stop = store.watch(BOX, () => {
      ended += 1;
    });
    stop();
    store.revoke(BOX);
    expect(ended).toBe(0);
    expect(store.authenticate(secret)).toBeNull();
  });

  test("the file keeps only the hash, and a restart keeps the token working", () => {
    const store = open();
    const secret = store.issue(BOX, "alpha");
    const text = readFileSync(join(dir, "self-tokens.json"), "utf8");
    expect(text).not.toContain(secret);
    expect(text).not.toContain(secret.slice("mbx_".length));
    expect(open().authenticate(secret)?.id).toBe(BOX);
  });

  test("a token past its rate limit is refused with 429 until the window ends", () => {
    let now = 1_000_000;
    const store = open(() => now);
    const secret = store.issue(BOX, "alpha");
    const limit = SELF_QUOTA.rateLimit ?? 0;
    for (let i = 0; i < limit; i += 1) expect(store.authenticate(secret)?.id).toBe(BOX);
    let refusal: unknown;
    try {
      store.authenticate(secret);
    } catch (e) {
      refusal = e;
    }
    expect(refusal).toBeInstanceOf(AppError);
    expect(refusal).toMatchObject({ status: 429, code: "too_many_requests", key: "token_rate_limited" });
    now += (SELF_QUOTA.rateWindowSec ?? 60) * 1000;
    expect(store.authenticate(secret)?.id).toBe(BOX);
  });

  test("an unreadable file is logged and the store starts with no tokens", () => {
    writeFileSync(join(dir, "self-tokens.json"), "not json");
    expect(open().has(BOX)).toBe(false);
  });
});

describe("a box's self token through its lifecycle", () => {
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

  async function createBox(name: string, extra: Record<string, unknown> = {}): Promise<BoxView> {
    const res = await call(harness.base, "/api/boxes", { body: { name, cpus: 1, memoryMb: 256, ...extra } });
    expect(res.status).toBe(201);
    return res.json.box as BoxView;
  }

  const whoAmI = (token: string) => call(harness.base, "/api/self", { token });
  const boxView = async (id: string) => (await call(harness.base, `/api/boxes/${id}`)).json.box as BoxView;
  const act = (id: string, action: string) => call(harness.base, `/api/boxes/${id}/${action}`, { method: "POST" });

  test("a box created with selfToken holds its token in a 0600 file for its agent, not in its environment", async () => {
    const box = await createBox("alpha", { selfToken: true });
    const file = await selfTokenFileOf(harness.runtime, box.id);
    expect(file.secret.startsWith("mbx_")).toBe(true);
    expect(file.mode).toBe(0o600);
    expect(file.uid).toBe(1000);
    expect((await whoAmI(file.secret)).json).toMatchObject({ boxId: box.boxId, name: "alpha" });

    expect((await harness.runtime.inspectEnv(box.id)).join("\n")).not.toContain(file.secret);
    const container = harness.runtime.containers.get(box.id);
    expect(container?.spec.tmpfs).toEqual({
      "/run/minibox": "rw,noexec,nosuid,nodev,size=1m,mode=0700,uid=1000,gid=1000",
    });
    expect(JSON.stringify(container?.spec)).not.toContain(file.secret);
    expect(box.selfToken).toBe(true);
  });

  test("a box created without selfToken gets no token and no file", async () => {
    const box = await createBox("plain");
    expect(harness.app.selfTokens.has(box.boxId)).toBe(false);
    expect(await whoAmI("mbx_none").then((res) => res.status)).toBe(401);
    await expect(selfTokenOf(harness.runtime, box.id)).rejects.toThrow();
    expect(box.selfToken).toBeFalsy();
  });

  test("a stop revokes the token, and the next start gives the box a new one", async () => {
    const box = await createBox("alpha", { selfToken: true });
    const old = await selfTokenOf(harness.runtime, box.id);
    expect((await act(box.id, "stop")).status).toBe(200);
    expect(refusedOf(await whoAmI(old))).toEqual({ status: 401, key: "unauthorized" });

    expect((await act(box.id, "start")).status).toBe(200);
    const fresh = await selfTokenOf(harness.runtime, box.id);
    expect(fresh).not.toBe(old);
    expect((await whoAmI(fresh)).status).toBe(200);
    expect((await whoAmI(old)).status).toBe(401);
  });

  test("a restart rotates the token: the old one is refused and the new one works", async () => {
    const box = await createBox("alpha", { selfToken: true });
    const old = await selfTokenOf(harness.runtime, box.id);
    expect((await act(box.id, "restart")).status).toBe(200);
    const fresh = await selfTokenOf(harness.runtime, box.id);
    expect((await whoAmI(old)).status).toBe(401);
    expect((await whoAmI(fresh)).status).toBe(200);
  });

  test("a rebuild rotates the token: the old one stops, and the new container's token works", async () => {
    const box = await createBox("alpha", { selfToken: true });
    const old = await selfTokenOf(harness.runtime, box.id);
    const rebuilt = await call(harness.base, `/api/boxes/${box.id}/rebuild`, {
      body: { profile: "strict", confirm: true },
      headers: { "if-match": String(box.revision) },
    });
    expect(rebuilt.status).toBe(200);
    const next = rebuilt.json.box as BoxView;
    const fresh = await selfTokenOf(harness.runtime, next.id);
    expect((await whoAmI(old)).status).toBe(401);
    expect((await whoAmI(fresh)).json).toMatchObject({ boxId: box.boxId });
  });

  test("a rename renames the actor of the agent's later events and the saved record", async () => {
    const box = await createBox("alpha", { selfToken: true });
    const secret = await selfTokenOf(harness.runtime, box.id);
    const renamed = await call(harness.base, `/api/boxes/${box.id}`, {
      method: "PATCH",
      body: { name: "beta" },
      headers: { "if-match": String(box.revision) },
    });
    expect(renamed.status).toBe(200);

    const reported = await call(harness.base, "/api/self/status", {
      token: secret,
      body: { state: "working", note: "after the rename" },
    });
    expect(reported.status).toBe(200);
    const statuses = harness.app.events.list({}, { limit: 1000 }).events.filter((event) => event.op === "self.status");
    expect(statuses.map((event) => event.principal.name)).toEqual(["beta"]);
    expect(readTokenRecords(harness.app.cfg.dataDir)).toEqual([
      expect.objectContaining({ boxId: box.boxId, name: "beta" }),
    ]);
  });

  test("deleting the box ends its token and forgets its questions", async () => {
    const box = await createBox("alpha", { selfToken: true });
    const secret = await selfTokenOf(harness.runtime, box.id);
    const asked = await call(harness.base, "/api/self/questions", {
      token: secret,
      body: { message: "Still there?" },
    });
    expect(asked.status).toBe(201);
    expect(harness.app.hosts.get().questions.forBox(box.boxId)).toHaveLength(1);

    expect((await call(harness.base, `/api/boxes/${box.id}`, { method: "DELETE" })).status).toBe(200);
    expect(refusedOf(await whoAmI(secret))).toEqual({ status: 401, key: "unauthorized" });
    expect(harness.app.selfTokens.has(box.boxId)).toBe(false);
    expect(harness.app.hosts.get().questions.forBox(box.boxId)).toEqual([]);
  });

  test("the owner revokes the token, the feature turns off, and the box keeps running", async () => {
    const box = await createBox("alpha", { selfToken: true });
    const secret = await selfTokenOf(harness.runtime, box.id);
    const revoked = await call(harness.base, `/api/boxes/${box.id}/self-token`, { method: "DELETE" });
    expect(revoked.status).toBe(200);
    expect((revoked.json.box as BoxView).selfToken).toBeFalsy();
    expect((await whoAmI(secret)).status).toBe(401);
    expect(harness.runtime.containers.get(box.id)?.running).toBe(true);
    expect((await boxView(box.id)).selfToken).toBeFalsy();

    expect((await act(box.id, "restart")).status).toBe(200);
    expect(harness.app.selfTokens.has(box.boxId)).toBe(false);
  });

  test("a create whose token cannot be written is rolled back: no token stays issued and no box is kept", async () => {
    harness.runtime.fail("putArchive", new RuntimeError("engine", "archive refused"));
    const res = await call(harness.base, "/api/boxes", {
      body: { name: "alpha", cpus: 1, memoryMb: 256, selfToken: true },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const listed = await call(harness.base, "/api/boxes");
    expect(listed.json.boxes?.map((box) => box.name) ?? []).not.toContain("alpha");
    expect(readTokenRecords(harness.app.cfg.dataDir)).toEqual([]);
  });

  test("deleting a box leaves no token or question of it on disk", async () => {
    const box = await createBox("alpha", { selfToken: true });
    const secret = await selfTokenOf(harness.runtime, box.id);
    expect(
      (await call(harness.base, "/api/self/questions", { token: secret, body: { message: "Still?" } })).status,
    ).toBe(201);
    await call(harness.base, `/api/boxes/${box.id}`, { method: "DELETE" });
    expect(readTokenRecords(harness.app.cfg.dataDir)).toEqual([]);
    const questions = JSON.parse(readFileSync(questionsPath(harness.app.cfg.dataDir), "utf8")) as {
      questions: { boxId: string }[];
    };
    expect(questions.questions.filter((question) => question.boxId === box.boxId)).toEqual([]);
  });
});

describe("a self token stays out of events, the audit trail, the console and the box view", () => {
  let harness: Harness;
  let lines: string[];
  let restoreConsole: () => void;

  beforeEach(() => {
    harness = startHarness({ logLevel: "debug" });
    lines = [];
    const log = spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const error = spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    restoreConsole = () => {
      log.mockRestore();
      error.mockRestore();
    };
  });
  afterEach(() => {
    restoreConsole();
    harness.stop();
  });

  test("no event, console line, box view or image carries the token value, however the box uses it", async () => {
    const created = await call(harness.base, "/api/boxes", {
      body: { name: "alpha", cpus: 1, memoryMb: 256, selfToken: true },
    });
    const box = created.json.box as BoxView;
    const secrets: string[] = [await selfTokenOf(harness.runtime, box.id)];

    await call(harness.base, "/api/self/status", {
      token: secrets[0],
      body: { state: "working", note: `using ${secrets[0]} for a step` },
    });
    await call(harness.base, "/api/self/questions", {
      token: secrets[0],
      body: { message: "Is this fine?", options: ["yes", "no"] },
    });
    await call(harness.base, `/api/boxes/${box.id}/stop`, { method: "POST" });
    await call(harness.base, `/api/boxes/${box.id}/start`, { method: "POST" });
    secrets.push(await selfTokenOf(harness.runtime, box.id));
    await call(harness.base, `/api/boxes/${box.id}/self-token`, { method: "DELETE" });

    const saved = await call(harness.base, `/api/boxes/${box.id}/template`, { body: { name: "saved" } });
    expect(saved.status).toBe(202);
    await finishedTask(harness.base, saved.json.taskId ?? "");

    const events = JSON.stringify(harness.app.events.list({}, { limit: 1000 }).events);
    const view = JSON.stringify((await call(harness.base, `/api/boxes/${box.id}`)).json);
    const logged = lines.join("\n");
    const images = JSON.stringify([...harness.runtime.images.values()]);
    for (const secret of secrets) {
      for (const text of [events, view, logged, images]) {
        expect(text).not.toContain(secret);
        expect(text).not.toContain(secret.slice("mbx_".length));
      }
    }
    expect(logged).toContain("box.self_token_issued");
    expect(events).toContain("self.status");
  });
});

describe("a confirmed move gives the box a new token on its new host", () => {
  let cluster: Cluster;

  beforeEach(async () => {
    cluster = await bootCluster({}, ["local"]);
  });
  afterEach(() => cluster.close());

  test("the token on the old host stops, and the token on the new host works", async () => {
    const box = await boxOn(cluster, undefined, "dev", { selfToken: true });
    const before = await selfTokenOf(cluster.engines.local, box.id);
    expect((await call(cluster.base, "/api/self", { token: before })).status).toBe(200);

    const refused = await cluster.api(`/api/boxes/${box.boxId}/move`, {
      method: "POST",
      headers: { "if-match": String(box.revision) },
      body: JSON.stringify({ host: "small" }),
    });
    expect(refused.status).toBe(409);
    expect((await call(cluster.base, "/api/self", { token: before })).status).toBe(200);

    const moved = await cluster.api(`/api/boxes/${box.boxId}/move`, {
      method: "POST",
      headers: { "if-match": String(box.revision) },
      body: JSON.stringify({ host: "small", confirm: true }),
    });
    expect(moved.status).toBe(202);
    const done = await finishedTask(cluster.base, ((await moved.json()) as { taskId: string }).taskId);
    expect(done.status).toBe("succeeded");

    const current = (await (await cluster.api(`/api/boxes/${box.boxId}`)).json()) as { box: { id: string } };
    const after = await selfTokenOf(cluster.engines.small, current.box.id);
    expect(after).not.toBe(before);
    expect((await call(cluster.base, "/api/self", { token: before })).status).toBe(401);
    expect((await call(cluster.base, "/api/self", { token: after })).json).toMatchObject({ boxId: box.boxId });
  });
});

/** The status and key of a refused call. Kept local so each test reads its refusal in one line. */
function refusedOf(reply: { status: number; json: Body }): { status: number; key: string | undefined } {
  return { status: reply.status, key: reply.json.error?.key };
}

function readTokenRecords(dataDir: string): unknown[] {
  const file = selfTokensPath(dataDir);
  if (!existsSync(file)) return [];
  return (JSON.parse(readFileSync(file, "utf8")) as { tokens: unknown[] }).tokens;
}
