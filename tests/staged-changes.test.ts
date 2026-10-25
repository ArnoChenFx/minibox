import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import type { HostMetrics } from "../src/host/metrics";
import { RuntimeError } from "../src/runtime";
import { StagedStore } from "../src/specs/staged";
import { silenceLogs } from "./support/app";
import { type Body, call, type Harness, mint, type Reply, refused, startHarness } from "./support/tokens";

const GB = 1024 ** 3;
const ROOMY_HOST = { cpu: { cores: 64 }, memory: { total: 64 * GB } } as unknown as HostMetrics;

interface StagedBody {
  fields: Record<string, unknown>;
  pending: string[];
  changes: { field: string; from: string; to: string }[];
  problem: string | null;
  baseRevision: number;
  updatedBy: string;
}

interface PreviewBody {
  changes: { field: string }[];
  diff: { path: string; kind: string }[];
  sessions: number | null;
  systemCheckpoint: boolean;
}

const stagedOf = (reply: Reply) => (reply.json as Body & { staged?: StagedBody | null }).staged;
const previewOf = (reply: Reply) => (reply.json as Body & { preview?: PreviewBody }).preview;

let harness: Harness;
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  harness = startHarness();
  harness.app.monitor.snapshot = async () => ROOMY_HOST;
});

afterEach(() => {
  harness.stop();
  restoreLogs();
});

async function makeBox(name: string, token?: string): Promise<{ boxId: string; revision: number }> {
  const reply = await call(harness.base, "/api/boxes", { token, body: { name, cpus: 1, memoryMb: 256 } });
  expect(reply.status).toBe(201);
  return { boxId: reply.json.box?.boxId ?? "", revision: reply.json.box?.revision ?? 0 };
}

const stage = (boxId: string, body: Record<string, unknown>, token?: string) =>
  call(harness.base, `/api/boxes/${boxId}/staged`, { method: "PUT", body, token });
const readStaged = (boxId: string, token?: string) => call(harness.base, `/api/boxes/${boxId}/staged`, { token });
const preview = (boxId: string, token?: string) => call(harness.base, `/api/boxes/${boxId}/staged/preview`, { token });
const apply = (boxId: string, revision: number, body: Record<string, unknown> = {}, token?: string) =>
  call(harness.base, `/api/boxes/${boxId}/staged/apply`, { body, token, headers: { "if-match": String(revision) } });
interface BoxBody {
  id: string;
  profile: string | null;
  revision: number;
  env: { name: string; value?: string; secretRef?: string }[];
  mounts: { volume: string; path: string; mode: string }[];
}
const getBox = async (boxId: string) =>
  (await call(harness.base, `/api/boxes/${boxId}`)).json.box as unknown as BoxBody | undefined;

describe("staging rebuild changes", () => {
  test("staging changes nothing on the box, and the staged fields add up", async () => {
    const { boxId } = await makeBox("alpha");
    const creates = harness.runtime.callsTo("createContainer").length;

    expect(stagedOf(await readStaged(boxId))).toBeNull();
    expect((await stage(boxId, { profile: "strict" })).status).toBe(200);
    const staged = stagedOf(await stage(boxId, { env: [{ name: "MODE", value: "dev" }] }));

    expect(staged).toMatchObject({
      fields: { profile: "strict", env: [{ name: "MODE", value: "dev" }] },
      pending: ["env", "profile"],
      problem: null,
      baseRevision: 1,
      updatedBy: "owner",
    });
    expect(staged?.changes.map((change) => change.field)).toEqual(["env", "profile", "containerName"]);
    expect(harness.runtime.callsTo("createContainer").length).toBe(creates);
    expect(await getBox(boxId)).toMatchObject({ profile: "standard", env: [], revision: 1 });
  });

  test("a field staged back to the box's value drops out, and none left removes the record", async () => {
    const { boxId } = await makeBox("alpha");
    await stage(boxId, { profile: "strict", network: "bridge" });

    expect(stagedOf(await stage(boxId, { profile: "standard" }))?.pending).toEqual(["network"]);
    expect(stagedOf(await stage(boxId, { network: "mbtest-boxes" }))).toBeNull();
    expect(stagedOf(await readStaged(boxId))).toBeNull();
  });

  test("staged changes are kept on disk with mode 600 and read back by a new store, as after a restart", async () => {
    const { boxId } = await makeBox("alpha");
    await stage(boxId, { profile: "strict" });

    const path = join(harness.app.cfg.dataDir, "boxes", "staged", `${boxId}.json`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const reopened = new StagedStore(harness.app.cfg.dataDir).read(boxId);
    expect(reopened).toMatchObject({ version: 1, boxId, fields: { profile: "strict" }, updatedBy: "owner" });
  });

  test("an empty request is refused, and so is a mount of a volume the token was not granted", async () => {
    const { boxId } = await makeBox("alpha");
    expect((await stage(boxId, {})).status).toBe(400);
    const volume = await call(harness.base, "/api/volumes", { body: { name: "private", confirm: true } });
    expect(volume.status).toBe(201);
    const reader = mint(harness.app, { name: "ops", preset: "operator" });
    const owned = await makeBox("beta", reader.secret);

    const refused = await stage(
      owned.boxId,
      { mounts: [{ volume: volume.json.volume?.engineName ?? "", path: "/data", mode: "ro" }] },
      reader.secret,
    );

    expect(refused.status).toBe(403);
    expect(stagedOf(await readStaged(owned.boxId))).toBeNull();
  });

  test("discarding drops the staged changes and leaves the box alone", async () => {
    const { boxId } = await makeBox("alpha");
    await stage(boxId, { profile: "strict" });

    const discarded = await call(harness.base, `/api/boxes/${boxId}/staged`, { method: "DELETE" });

    expect(discarded.json).toEqual({ ok: true });
    expect(stagedOf(await readStaged(boxId))).toBeNull();
    expect((await getBox(boxId))?.profile).toBe("standard");
  });

  test("deleting the box deletes its staged changes", async () => {
    const { boxId } = await makeBox("alpha");
    await stage(boxId, { profile: "strict" });
    const path = join(harness.app.cfg.dataDir, "boxes", "staged", `${boxId}.json`);
    expect(existsSync(path)).toBe(true);

    expect((await call(harness.base, `/api/boxes/${boxId}?skipTrash=true`, { method: "DELETE" })).status).toBe(200);

    expect(existsSync(path)).toBe(false);
  });
});

describe("previewing staged changes", () => {
  test("the preview lists the changes, the writable layer it loses and the sessions that end", async () => {
    const { boxId } = await makeBox("alpha");
    const box = await getBox(boxId);
    harness.runtime.seedDiff(box?.id ?? "", [{ path: "/etc/motd", kind: "modified" }]);
    await stage(boxId, { profile: "strict" });

    const shown = previewOf(await preview(boxId));

    expect(shown).toMatchObject({
      diff: [{ path: "/etc/motd", kind: "modified" }],
      systemCheckpoint: true,
    });
    expect(shown?.changes.map((change) => change.field)).toEqual(["profile", "containerName"]);
    expect(typeof shown?.sessions).toBe("number");
  });

  test("a box whose env names a secret cannot take its writable layer into the checkpoint", async () => {
    const { boxId } = await makeBox("alpha");
    expect((await call(harness.base, "/api/secrets/vault", { method: "PUT", body: { value: "s3cret" } })).status).toBe(
      200,
    );
    const box = await getBox(boxId);
    const rebuilt = await call(harness.base, `/api/boxes/${boxId}/rebuild`, {
      body: { env: [{ name: "TOKEN", secretRef: "vault" }], confirm: true, safetyCheckpoint: false },
      headers: { "if-match": String(box?.revision) },
    });
    expect(rebuilt.status).toBe(200);
    await stage(boxId, { profile: "strict" });

    expect(previewOf(await preview(boxId))?.systemCheckpoint).toBe(false);
  });

  test("with nothing staged the preview and apply answer 404", async () => {
    const { boxId, revision } = await makeBox("alpha");
    expect((await preview(boxId)).json.error?.key).toBe("staged_none");
    expect((await apply(boxId, revision)).json.error?.key).toBe("staged_none");
  });
});

describe("applying staged changes", () => {
  test("apply rebuilds the box with every staged field, takes a checkpoint with the writable layer, and clears them", async () => {
    const { boxId, revision } = await makeBox("alpha");
    await stage(boxId, { profile: "strict", env: [{ name: "MODE", value: "dev" }] });

    const applied = await apply(boxId, revision);

    expect(applied.status).toBe(200);
    expect(applied.json.box).toMatchObject({ profile: "strict", revision: revision + 1 });
    expect(applied.json.safety).toMatchObject({ id: expect.stringMatching(/^ck_/), label: "Before rebuild" });
    const checkpoint = (await call(harness.base, `/api/checkpoints/${applied.json.safety?.id}`)).json.checkpoint;
    expect(checkpoint?.system).not.toBeNull();
    expect(stagedOf(await readStaged(boxId))).toBeNull();
    expect((await getBox(boxId))?.env).toEqual([{ name: "MODE", value: "dev" }]);
  });

  test("apply without the checkpoint takes none", async () => {
    const { boxId, revision } = await makeBox("alpha");
    await stage(boxId, { profile: "strict" });

    const applied = await apply(boxId, revision, { checkpoint: false });

    expect(applied.status).toBe(200);
    expect(applied.json.safety).toBeNull();
  });

  test("a stale revision is refused and keeps the staged changes", async () => {
    const { boxId, revision } = await makeBox("alpha");
    await stage(boxId, { profile: "strict" });

    expect((await apply(boxId, revision + 5)).status).toBe(412);
    expect(stagedOf(await readStaged(boxId))?.pending).toEqual(["profile"]);
  });

  test("changes staged after the preview are refused with 412, so the owner applies only what they reviewed", async () => {
    const { boxId, revision } = await makeBox("alpha");
    await stage(boxId, { profile: "strict" });
    const reviewed = (await preview(boxId)).json as unknown as { preview: { stagedAt: string } };
    await new Promise((resolve) => setTimeout(resolve, 5));
    await stage(boxId, { env: [{ name: "LATE", value: "1" }] });

    const stale = await apply(boxId, revision, { checkpoint: false, stagedAt: reviewed.preview.stagedAt });
    expect(stale.status).toBe(412);
    expect(stale.json.error?.key).toBe("staged_changed");
    expect((await getBox(boxId))?.revision).toBe(revision);

    const fresh = (await preview(boxId)).json as unknown as { preview: { stagedAt: string } };
    expect((await apply(boxId, revision, { checkpoint: false, stagedAt: fresh.preview.stagedAt })).status).toBe(200);
  });

  test("a rebuild that fails keeps the staged changes, so they can be applied again", async () => {
    const { boxId, revision } = await makeBox("alpha");
    await stage(boxId, { profile: "strict" });
    harness.runtime.fail("startContainer", new RuntimeError("engine", "boom", "boom"));

    expect((await apply(boxId, revision, { checkpoint: false })).status).toBe(502);
    expect(stagedOf(await readStaged(boxId))?.pending).toEqual(["profile"]);
    expect((await getBox(boxId))?.profile).toBe("standard");
  });
});

describe("staged changes and tokens", () => {
  test("a token that may change a box can stage and discard, but only the owner can apply", async () => {
    const operator = mint(harness.app, { name: "ops", preset: "operator" });
    const { boxId, revision } = await makeBox("agent-box", operator.secret);

    const staged = await stage(boxId, { profile: "strict" }, operator.secret);
    expect(staged.status).toBe(200);
    expect(stagedOf(staged)?.updatedBy).toBe(operator.id);
    expect((await preview(boxId, operator.secret)).status).toBe(200);

    const refused = await apply(boxId, revision, {}, operator.secret);
    expect(refused.status).toBe(403);
    expect((await getBox(boxId))?.profile).toBe("standard");

    const admin = mint(harness.app, { name: "admin", preset: "admin" });
    expect((await apply(boxId, revision, {}, admin.secret)).status).toBe(403);

    expect((await apply(boxId, revision)).status).toBe(200);
    expect((await getBox(boxId))?.profile).toBe("strict");
  });

  test("a read-only token sees the staged changes and cannot stage or discard", async () => {
    const reader = mint(harness.app, { name: "reader", preset: "readonly", boxes: { type: "all" } });
    const { boxId } = await makeBox("alpha");
    await stage(boxId, { profile: "strict" });

    expect(stagedOf(await readStaged(boxId, reader.secret))?.pending).toEqual(["profile"]);
    expect((await stage(boxId, { profile: "relaxed" }, reader.secret)).status).toBe(403);
    const discard = await call(harness.base, `/api/boxes/${boxId}/staged`, { method: "DELETE", token: reader.secret });
    expect(discard.status).toBe(403);
  });

  test("a token without secret:use cannot stage an env that names a secret", async () => {
    const operator = mint(harness.app, { name: "ops", preset: "operator" });
    const { boxId } = await makeBox("agent-box", operator.secret);

    const refused = await stage(boxId, { env: [{ name: "TOKEN", secretRef: "vault" }] }, operator.secret);

    expect(refused.status).toBe(403);
    expect(refused.json.error?.key).toBe("secret_reference_forbidden");
  });
});

describe("staging refuses what a rebuild would refuse", () => {
  test("two mounts on one path are refused and nothing is staged", async () => {
    const { boxId } = await makeBox("alpha");
    const box = await getBox(boxId);
    const current = (box?.mounts ?? []).map((m) => ({
      volume: m.volume,
      path: m.path,
      mode: m.mode,
    }));
    const clash = { ...current[0], volume: "mbtest-other" };

    const refused = await stage(boxId, { mounts: [...current, clash] });

    expect(refused.status).toBe(400);
    expect(stagedOf(await readStaged(boxId))).toBeNull();
  });
});

const listStaged = (token?: string) => call(harness.base, "/api/staged", { token });

describe("every box's staged changes in one read", () => {
  type Listed = { staged: { box: { id: string; boxId: string; name: string; hostId: string }; staged: StagedBody }[] };
  const entriesOf = (reply: Reply) => (reply.json as unknown as Listed).staged;

  test("the list is empty while nothing is staged, and it carries the shape of the single-box read", async () => {
    await makeBox("alpha");
    await makeBox("beta");

    expect(entriesOf(await listStaged())).toEqual([]);

    const { boxId } = await makeBox("gamma");
    await stage(boxId, { profile: "strict", env: [{ name: "MODE", value: "dev" }] });

    const entries = entriesOf(await listStaged());
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.box).toMatchObject({ boxId, name: "gamma", hostId: "local" });
    expect(entry?.staged).toMatchObject({
      fields: { profile: "strict", env: [{ name: "MODE", value: "dev" }] },
      pending: ["env", "profile"],
      problem: null,
    });
    // The same record the single-box read returns, field for field.
    expect(entry?.staged).toEqual(stagedOf(await readStaged(boxId)) as StagedBody);
  });

  test("several boxes are listed, and a box with nothing staged is left out", async () => {
    const alpha = await makeBox("alpha");
    await makeBox("beta");
    const gamma = await makeBox("gamma");
    await stage(alpha.boxId, { profile: "strict" });
    await stage(gamma.boxId, { network: "bridge" });

    const names = entriesOf(await listStaged()).map((entry) => [entry.box.name, entry.staged.pending]);
    expect(names.toSorted()).toEqual([
      ["alpha", ["profile"]],
      ["gamma", ["network"]],
    ]);
  });

  test("a box whose staged changes cannot be read is skipped, and the others are still listed", async () => {
    const alpha = await makeBox("alpha");
    const beta = await makeBox("beta");
    await stage(alpha.boxId, { profile: "strict" });
    await stage(beta.boxId, { profile: "strict" });
    // A plan that cannot be made leaves the record in place and reports the problem, so the box is still listed.
    harness.runtime.fail("inspectImage", new RuntimeError("engine", "boom", "boom"));
    expect(
      entriesOf(await listStaged())
        .map((entry) => entry.box.name)
        .toSorted(),
    ).toEqual(["alpha", "beta"]);

    // A spec that is gone has no box to read: its record is dropped with the box, so the list stays whole.
    const gamma = await makeBox("gamma");
    await stage(gamma.boxId, { profile: "strict" });
    expect((await call(harness.base, `/api/boxes/${gamma.boxId}?skipTrash=true`, { method: "DELETE" })).status).toBe(
      200,
    );
    expect(
      entriesOf(await listStaged())
        .map((entry) => entry.box.name)
        .toSorted(),
    ).toEqual(["alpha", "beta"]);
  });

  test("a read-only token sees the staged changes of the boxes its grants cover, and only those", async () => {
    const alpha = await makeBox("alpha");
    const beta = await makeBox("beta");
    await stage(alpha.boxId, { profile: "strict" });
    await stage(beta.boxId, { profile: "strict" });

    const reader = mint(harness.app, {
      name: "reader",
      preset: "readonly",
      boxes: { type: "ids", ids: [alpha.boxId] },
    });
    expect(entriesOf(await listStaged(reader.secret)).map((entry) => entry.box.name)).toEqual(["alpha"]);

    const every = mint(harness.app, { name: "every", preset: "readonly", boxes: { type: "all" } });
    expect(
      entriesOf(await listStaged(every.secret))
        .map((entry) => entry.box.name)
        .toSorted(),
    ).toEqual(["alpha", "beta"]);

    const none = mint(harness.app, { name: "none", preset: "readonly" });
    expect(entriesOf(await listStaged(none.secret))).toEqual([]);
  });

  test("a token with no scope for boxes is refused, and so is one whose host is not granted", async () => {
    await makeBox("alpha");
    const exec = mint(harness.app, { name: "exec", scopes: ["exec"] });
    expect(refused(await listStaged(exec.secret))).toEqual({ status: 403, key: "operation_forbidden" });

    const elsewhere = mint(harness.app, {
      name: "elsewhere",
      preset: "readonly",
      hosts: { type: "list", ids: ["edge"] },
    });
    expect(refused(await listStaged(elsewhere.secret))).toEqual({ status: 403, key: "host_not_granted" });
  });
});
