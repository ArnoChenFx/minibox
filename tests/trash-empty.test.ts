import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { HostMetrics } from "../src/host/metrics";
import { purgeScanned, scanTrash } from "../src/services/trash-empty";
import type { TaskReader } from "../src/tasks/types";
import { silenceLogs } from "./support/app";
import {
  call,
  type Harness,
  mint,
  refused,
  type Reply,
  startHarness,
  type TrashEntryBody,
  type TrashRefBody,
} from "./support/tokens";

const GB = 1024 ** 3;
const ROOMY_HOST = { cpu: { cores: 64 }, memory: { total: 64 * GB } } as unknown as HostMetrics;

interface Emptied {
  id: string;
  sourceName: string;
  status: string;
  blocked: string | null;
  error: { message: string; key: string | null } | null;
}

interface EmptyBody {
  removed: number;
  refused: number;
  failed: number;
  bytes: number;
  entries: Emptied[];
  hosts: { hostId: string; status: string }[];
}

async function makeBox(harness: Harness, name: string): Promise<string> {
  const reply = await call(harness.base, "/api/boxes", { body: { name, cpus: 1, memoryMb: 256 } });
  expect(reply.status).toBe(201);
  return reply.json.box?.boxId ?? "";
}

/** Deletes a new box into the recycle bin, and returns the entry's id. */
async function binned(harness: Harness, name: string): Promise<string> {
  const boxId = await makeBox(harness, name);
  const deleted = await call(harness.base, `/api/boxes/${boxId}`, { method: "DELETE" });
  return (deleted.json.trash as TrashRefBody | null | undefined)?.id ?? "";
}

async function trashNames(harness: Harness): Promise<string[]> {
  const reply = await call(harness.base, "/api/trash");
  return ((reply.json.trash ?? []) as TrashEntryBody[]).map((entry) => entry.sourceName).toSorted();
}

function empty(harness: Harness, body: Record<string, unknown>, token?: string): Promise<Reply> {
  return call(harness.base, "/api/trash/empty", { method: "POST", body, token });
}

const bodyOf = (reply: Reply) => reply.json as unknown as EmptyBody;

interface ActivityRow {
  action: string;
  target: string;
  ok: boolean;
}

async function activityOf(harness: Harness): Promise<ActivityRow[]> {
  const reply = await call(harness.base, "/api/activity");
  return (reply.json as unknown as { activity: ActivityRow[] }).activity;
}

async function eventsOf(harness: Harness): Promise<{ op: string; detail?: Record<string, unknown> }[]> {
  const reply = await call(harness.base, "/api/events");
  return (reply.json as unknown as { events: { op: string; detail?: Record<string, unknown> }[] }).events;
}

/** A task reader that reports one running task of the given op on the given entry. */
const holding = (op: string, id: string): TaskReader =>
  ({
    list: ({ status }: { status?: string }) =>
      status === "running" ? [{ op, target: { kind: "trash", id, name: "x" } }] : [],
  }) as unknown as TaskReader;

describe("emptying the recycle bin", () => {
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

  test("a request without confirm lists what would go, and purges nothing", async () => {
    await binned(harness, "alpha");
    await binned(harness, "beta");

    const asked = await empty(harness, {});

    expect(asked.status).toBe(409);
    expect(asked.json.error?.code).toBe("confirmation_required");
    const preview = (asked.json.error as unknown as { details: { preview: Record<string, unknown> } }).details.preview;
    expect(preview).toMatchObject({ action: "empty_trash", count: 2 });
    expect(
      (preview.entries as { sourceName: string; blocked: string | null }[]).map((e) => e.sourceName).toSorted(),
    ).toEqual(["alpha", "beta"]);
    expect(await trashNames(harness)).toEqual(["alpha", "beta"]);
    expect(harness.app.hosts.get().checkpoints.list()).toHaveLength(2);
  });

  test("a confirmed empty purges every entry for good, and records the counts and one event per entry", async () => {
    await binned(harness, "alpha");
    await binned(harness, "beta");

    const done = await empty(harness, { confirm: true });

    expect(done.status).toBe(200);
    const body = bodyOf(done);
    expect(body).toMatchObject({ removed: 2, refused: 0, failed: 0 });
    expect(body.entries.map((entry) => entry.status)).toEqual(["removed", "removed"]);
    expect(body.hosts.map((host) => host.status)).toEqual(["checked"]);
    expect(await trashNames(harness)).toEqual([]);
    expect(harness.app.hosts.get().checkpoints.list()).toEqual([]);

    const events = await eventsOf(harness);
    expect(events.filter((event) => event.op === "trash.purged")).toHaveLength(2);
    const emptied = events.find((event) => event.op === "trash.empty");
    expect(emptied?.detail).toMatchObject({ named: null, removed: 2, refused: 0, failed: 0 });
    const activity = await activityOf(harness);
    expect(activity[0]).toMatchObject({ action: "trash.empty", target: "2/2", ok: true });
  });

  test("an empty recycle bin is answered with zero counts, and records nothing", async () => {
    const preview = await empty(harness, {});
    expect(preview.status).toBe(409);
    expect(preview.json.error?.details).toMatchObject({ preview: { count: 0, entries: [] } });

    const done = await empty(harness, { confirm: true });
    expect(bodyOf(done)).toMatchObject({ removed: 0, refused: 0, failed: 0, entries: [] });
    const activity = await activityOf(harness);
    expect(activity.filter((entry) => entry.action === "trash.empty")).toEqual([]);
  });

  test("ids limit the empty to the entries the caller listed, and an id that is gone is skipped", async () => {
    const first = await binned(harness, "alpha");
    await binned(harness, "beta");

    const done = await empty(harness, { confirm: true, ids: [first, "ck_0000000000000000000000000"] });

    expect(bodyOf(done)).toMatchObject({ removed: 1, refused: 0, failed: 0 });
    expect(bodyOf(done).entries.map((entry) => entry.sourceName)).toEqual(["alpha"]);
    expect(await trashNames(harness)).toEqual(["beta"]);
  });

  test("an empty id list is refused instead of meaning every entry", async () => {
    await binned(harness, "alpha");
    expect((await empty(harness, { confirm: true, ids: [] })).status).toBe(400);
    expect(await trashNames(harness)).toEqual(["alpha"]);
  });

  test("an entry being exported is left and reported, and the others are purged", async () => {
    const exporting = await binned(harness, "alpha");
    await binned(harness, "beta");
    harness.app.hosts.get().checkpoints.exporting.add(exporting);

    const preview = await empty(harness, {});
    expect(preview.json.error?.details).toMatchObject({ preview: { count: 1 } });

    const done = await empty(harness, { confirm: true });

    const body = bodyOf(done);
    expect(body).toMatchObject({ removed: 1, refused: 1, failed: 0 });
    expect(body.entries.find((entry) => entry.sourceName === "alpha")).toMatchObject({
      status: "refused",
      blocked: "exporting",
      error: { key: "checkpoint_exporting" },
    });
    expect(await trashNames(harness)).toEqual(["alpha"]);
    const activity = await activityOf(harness);
    expect(activity[0]).toMatchObject({ action: "trash.empty", target: "1/2", ok: false });
  });

  test("an entry that fails to purge is reported with its reason, and the empty goes on to the rest", async () => {
    const doomed = await binned(harness, "alpha");
    await binned(harness, "beta");
    await binned(harness, "gamma");
    const host = harness.app.hosts.get();
    const remove = host.checkpoints.remove.bind(host.checkpoints);
    const spy = spyOn(host.checkpoints, "remove").mockImplementation((id: string) => {
      if (id === doomed) throw new Error("disk is on fire");
      return remove(id);
    });

    const done = await empty(harness, { confirm: true });
    spy.mockRestore();

    const body = bodyOf(done);
    expect(done.status).toBe(200);
    expect(body).toMatchObject({ removed: 2, refused: 0, failed: 1 });
    expect(body.entries.find((entry) => entry.status === "failed")).toMatchObject({
      id: doomed,
      sourceName: "alpha",
      error: { message: expect.stringContaining("disk is on fire") },
    });
    expect(await trashNames(harness)).toEqual(["alpha"]);
    const activity = await activityOf(harness);
    expect(activity[0]).toMatchObject({ action: "trash.empty", target: "2/3", ok: false });
  });

  test("only the owner can empty it: no token reaches it, trash:skip and the admin preset included", async () => {
    await binned(harness, "alpha");
    const skipper = mint(harness.app, { name: "skipper", scopes: ["box:read", "box:delete", "trash:skip"] });
    const admin = mint(harness.app, { name: "admin", preset: "admin" });

    for (const token of [skipper.secret, admin.secret]) {
      expect(refused(await empty(harness, {}, token))).toEqual({ status: 403, key: "operation_forbidden" });
      expect(refused(await empty(harness, { confirm: true }, token))).toEqual({
        status: 403,
        key: "operation_forbidden",
      });
    }
    expect(await trashNames(harness)).toEqual(["alpha"]);
  });
});

describe("what an empty leaves", () => {
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

  test.each(["trash.restore", "trash.purge"])("an entry with a running %s task is left alone", async (op) => {
    const held = await binned(harness, "alpha");
    await binned(harness, "beta");
    const hosts = [harness.app.hosts.get()];
    const opts = { ids: null, tasks: holding(op, held) };

    const scan = await scanTrash(hosts, opts);
    expect(scan.entries.map((row) => [row.sourceName, row.status, row.blocked]).toSorted()).toEqual([
      ["alpha", "refused", "busy"],
      ["beta", "candidate", null],
    ]);

    const rows = await purgeScanned(hosts, scan, opts);
    expect(rows.map((row) => [row.sourceName, row.status]).toSorted()).toEqual([
      ["alpha", "refused"],
      ["beta", "removed"],
    ]);
    expect(await trashNames(harness)).toEqual(["alpha"]);
  });

  test("an entry that a restore claims after the scan is checked again before it is purged", async () => {
    const late = await binned(harness, "alpha");
    const hosts = [harness.app.hosts.get()];
    const scan = await scanTrash(hosts, { ids: null });
    expect(scan.entries[0]?.status).toBe("candidate");

    const rows = await purgeScanned(hosts, scan, { ids: null, tasks: holding("trash.restore", late) });

    expect(rows).toMatchObject([{ sourceName: "alpha", status: "refused", blocked: "busy" }]);
    expect(await trashNames(harness)).toEqual(["alpha"]);
  });

  test("an entry that expired between the scan and the purge is skipped, not reported as failed", async () => {
    const gone = await binned(harness, "alpha");
    const hosts = [harness.app.hosts.get()];
    const scan = await scanTrash(hosts, { ids: null });
    harness.app.hosts.get().checkpoints.remove(gone);

    expect(await purgeScanned(hosts, scan, { ids: null })).toEqual([]);
  });

  test("two hosts of one name keep their own name in the report, and the message tells them apart by id", async () => {
    const local = harness.app.hosts.get();
    // A hosts file written before names had to be unique can still hold two hosts of one name.
    const twin = (id: string) => ({
      ...local,
      host: { ...local.host, id, name: "NAS", transport: "ssh" as const, status: "offline" as const },
    });
    const scan = await scanTrash([twin("nas-1"), twin("nas-2")], { ids: null });
    expect(scan.hosts.map((host) => [host.hostId, host.name, host.error?.message])).toEqual([
      ["nas-1", "NAS", expect.stringContaining("NAS · nas-1")],
      ["nas-2", "NAS", expect.stringContaining("NAS · nas-2")],
    ]);
  });
});
