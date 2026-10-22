import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import { AppError } from "../src/lib/errors";
import { msg } from "../src/lib/messages";
import { within } from "../src/lib/within";
import type { Outgoing } from "../src/notify/channels";
import { noticeOfEvent } from "../src/notify/rules";
import type { StoredChannel } from "../src/notify/types";
import { type HelperResult, type HelperSpec, RuntimeError } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { takeCheckpoint } from "../src/services/checkpoints";
import {
  attachVolume,
  createVolume,
  getVolume,
  measureVolume,
  savePools,
  setVolumeLimits,
} from "../src/services/volumes";
import { remeasureHostDisk } from "../src/volumes/disk";
import { poolRootVolume } from "../src/volumes/health";
import { mergeLimits, normalizeLimits, usageLevel } from "../src/volumes/limits";
import { UNLIMITED, type VolumeLimits } from "../src/volumes/types";
import { recordSample, SHARE_DEADLINE_MS, sampleWithin, TREE_DEADLINE_MS } from "../src/volumes/usage";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import { advance, turn } from "./support/clock";
import { type FakeRuntime, volumeAwareHelper } from "./support/fake-runtime";
import { call, refused, startHarness } from "./support/tokens";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const DISK_TOTAL = 100 * GB;

const NAS_POOLS = [
  { name: "local", backend: "local" as const },
  {
    name: "nas",
    backend: "nfs" as const,
    server: "192.168.1.10",
    export: "/volume1/minibox",
    options: ["nfsvers=4.1", "hard"],
    default: true,
  },
];

const DISK_POOLS = [
  { name: "local", backend: "local" as const },
  { name: "disk", backend: "path" as const, root: "/mnt/disk", marker: ".minibox-mounted", default: true },
];

interface Figures {
  /** `du` bytes, by the engine name of a volume's tree. */
  readonly tree: Map<string, number>;
  /** `df` used bytes, by the name of a pool root volume. */
  readonly share: Map<string, number>;
  /** Engine names whose `du` fails, as a tree that cannot be read does. */
  readonly unreadable: Set<string>;
}

function dfLog(used: number): string {
  return `Filesystem 1B-blocks Used Available Use% Mounted\nshare ${DISK_TOTAL} ${used} ${DISK_TOTAL - used} 1% /mnt\n`;
}

/**
 * Answers `du` and `df` from the figures a test sets. Every other helper is the fake's own volume model, so the rest of a
 * volume's helpers behave as they do in the other suites.
 */
function figuresFor(runtime: FakeRuntime): Figures {
  const figures: Figures = { tree: new Map(), share: new Map(), unreadable: new Set() };
  runtime.helperHandler = (spec: HelperSpec): HelperResult => {
    const source = spec.mounts?.[0]?.source ?? "";
    if (spec.cmd[0] === "du") {
      if (figures.unreadable.has(source)) {
        return { exitCode: 1, logs: "du: cannot read directory: Permission denied\n" };
      }
      return { exitCode: 0, logs: `${figures.tree.get(source) ?? 0}\t/mnt\n` };
    }
    if (spec.cmd.join(" ").includes("df -B1 -P")) {
      return { exitCode: 0, logs: dfLog(figures.share.get(source) ?? 0) };
    }
    return volumeAwareHelper(runtime, spec);
  };
  return figures;
}

const isTreeOf = (spec: HelperSpec, engineName: string): boolean =>
  spec.cmd[0] === "du" && spec.mounts?.[0]?.source === engineName;

const isShareProbeOf = (spec: HelperSpec, root: string): boolean =>
  spec.cmd.join(" ").includes("df -B1 -P") && spec.mounts?.[0]?.source === root;

function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to throw");
}

/** Lets queued work run, a turn at a time, until `done` holds. The bound counts turns, not time. */
async function untilDone(done: () => boolean): Promise<void> {
  for (let turns = 0; turns < 100 && !done(); turns++) await turn();
  expect(done()).toBe(true);
}

function channelOf(patch: Partial<StoredChannel> & Pick<StoredChannel, "id">): StoredChannel {
  return {
    type: "webhook",
    name: "Ops",
    enabled: true,
    events: ["volume.usage_high", "volume.usage_limit"],
    boxes: [],
    url: "https://hooks.example.com/minibox",
    server: null,
    topic: null,
    chatId: null,
    createdAt: "2026-10-22T09:00:00.000Z",
    updatedAt: "2026-10-22T09:00:00.000Z",
    ...patch,
  };
}

interface VolumeReply {
  volume: {
    id: string;
    bytes: number | null;
    limits: VolumeLimits;
    usage: { scope: string; level: string; lastError: string | null };
  };
}

let app: App;
let runtime: FakeRuntime;
let host: HostCtx;
let figures: Figures;
let sent: Outgoing[];
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  sent = [];
  const created = createTestApp(
    { labelPrefix: "mbtest" },
    undefined,
    {},
    {
      notify: {
        transport: async (request) => {
          sent.push(request);
          return 200;
        },
        sleep: async () => undefined,
      },
    },
  );
  app = created.app;
  runtime = created.runtime;
  host = app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true", [host.keys.templateName]: "base" });
  figures = figuresFor(runtime);
});

afterEach(() => {
  restoreLogs();
});

const pass = (): Promise<void> => app.volumeUsage.tick();
const eventsOf = (op: string) => app.events.list({ op }, { limit: 100 }).events;
const runsOf = (text: string): HelperSpec[] =>
  runtime
    .callsTo("runHelper")
    .map((entry) => entry.args[0] as HelperSpec)
    .filter((spec) => spec.cmd.join(" ").includes(text));

describe("usage limits as stored and as judged", () => {
  test("a stored limit that is not a positive whole number reads as no limit, and an unknown action reads as warn", () => {
    expect(normalizeLimits(undefined)).toEqual(UNLIMITED);
    expect(normalizeLimits({ softBytes: 0, hardBytes: -5, action: "stop" })).toEqual({
      softBytes: null,
      hardBytes: null,
      action: "stop",
    });
    expect(normalizeLimits({ softBytes: 1.5, hardBytes: "9", action: "explode" })).toEqual({
      softBytes: null,
      hardBytes: null,
      action: "warn",
    });
  });

  test("a figure is ok, soft or hard against its limits, and unknown until a sample exists", () => {
    const limits: VolumeLimits = { softBytes: 2 * MB, hardBytes: 4 * MB, action: "warn" };
    expect(usageLevel(null, limits)).toBe("unknown");
    expect(usageLevel(MB, limits)).toBe("ok");
    expect(usageLevel(2 * MB, limits)).toBe("soft");
    expect(usageLevel(4 * MB, limits)).toBe("hard");
    expect(usageLevel(9 * MB, UNLIMITED)).toBe("ok");
  });

  test("a partial update keeps the fields it leaves out, null clears one, and a soft limit above the hard one is refused", () => {
    const current: VolumeLimits = { softBytes: 2 * MB, hardBytes: 4 * MB, action: "warn" };
    expect(mergeLimits(current, { action: "stop" })).toEqual({ softBytes: 2 * MB, hardBytes: 4 * MB, action: "stop" });
    expect(mergeLimits(current, { hardBytes: null })).toEqual({ softBytes: 2 * MB, hardBytes: null, action: "warn" });
    expect(mergeLimits(current, { softBytes: 3 * MB })).toEqual({
      softBytes: 3 * MB,
      hardBytes: 4 * MB,
      action: "warn",
    });
    expect(thrown(() => mergeLimits(current, { softBytes: 5 * MB }))).toMatchObject({
      status: 400,
      key: "volume_limit_order",
    });
  });
});

describe("a deadline answers a call that has not finished", () => {
  test("the promise wins if it answers first, and the late value wins once the deadline passes, without cancelling the promise", async () => {
    jest.useFakeTimers();
    try {
      expect(await within(Promise.resolve("answered"), 100, () => "late")).toBe("answered");

      const slow = Promise.withResolvers<string>();
      const pending = within(slow.promise, 100, () => "late");
      await advance(100);
      expect(await pending).toBe("late");

      slow.resolve("finished after the deadline");
      expect(await slow.promise).toBe("finished after the deadline");
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("a volume is sampled with the helper that fits its pool", () => {
  test("a local volume is measured with du over its own tree, and the figure is kept with the time it was taken", async () => {
    const notes = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    figures.tree.set(notes.engineName, 3 * MB);

    const view = await measureVolume(host, notes.id);

    expect(view.bytes).toBe(3 * MB);
    expect(view.bytesAt).not.toBeNull();
    expect(view.usage).toMatchObject({ scope: "volume", level: "ok", lastError: null, history: [{ bytes: 3 * MB }] });
    expect(host.volumes.read(notes.id)?.bytes).toBe(3 * MB);
    expect(runsOf("du -sb")).toEqual([
      expect.objectContaining({
        user: "0:0",
        capAdd: ["DAC_READ_SEARCH"],
        mounts: [{ source: notes.engineName, target: "/mnt" }],
      }),
    ]);
  });

  test("a volume on a path pool is measured with du as well", async () => {
    await savePools(host, DISK_POOLS, undefined);
    const archive = await createVolume(host, { name: "archive", pool: "disk", role: null, createdBy: "owner" });
    figures.tree.set(archive.engineName, 4 * MB);

    const view = await measureVolume(host, archive.id);

    expect(view.usage.scope).toBe("volume");
    expect(view.bytes).toBe(4 * MB);
    expect(runsOf("du -sb")).toHaveLength(1);
  });

  test("an NFS volume is measured with df on its pool root, so its figure is the whole share's and no du runs for it", async () => {
    await savePools(host, NAS_POOLS, undefined);
    const shared = await createVolume(host, { name: "shared", pool: "nas", role: null, createdBy: "owner" });
    figures.share.set(poolRootVolume(host.prefix, "nas"), 7 * MB);

    const view = await measureVolume(host, shared.id);

    expect(view.bytes).toBe(7 * MB);
    expect(view.usage).toMatchObject({ scope: "share", level: "ok", lastError: null });
    expect(runsOf("du -sb").filter((spec) => spec.mounts?.[0]?.source === shared.engineName)).toEqual([]);
  });

  test("a tree still being measured at its deadline is a failed sample, and the figure from before it is kept", async () => {
    const notes = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    figures.tree.set(notes.engineName, 3 * MB);
    await measureVolume(host, notes.id);
    const volume = host.volumes.read(notes.id);
    if (!volume) throw new Error("the volume was not recorded");

    const frozen = runtime.hold("runHelper", (args) => isTreeOf(args[0] as HelperSpec, notes.engineName));
    jest.useFakeTimers();
    try {
      const started = Date.now();
      const pending = sampleWithin(host, volume);
      await advance(TREE_DEADLINE_MS);
      const sample = await pending;

      expect(Date.now() - started).toBe(TREE_DEADLINE_MS);
      expect(sample.ok).toBe(false);
      if (sample.ok) throw new Error("a tree past its deadline must not sample");
      expect(sample.error).toMatchObject({
        status: 503,
        key: "volume_usage_timeout",
        params: { volume: "notes", seconds: 120 },
      });
      expect(sample.error).toBeInstanceOf(AppError);

      recordSample(host, notes.id, sample);
      expect(host.volumes.read(notes.id)?.bytes).toBe(3 * MB);
      expect(host.volumes.usageMemory(notes.id).lastError).toBe(
        msg("volume_usage_timeout", { volume: "notes", seconds: 120 }).text,
      );
    } finally {
      frozen.release();
      jest.useRealTimers();
    }
  });

  test("a sample that fails keeps the figure from before and says why, and the next good sample clears the reason", async () => {
    const notes = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    figures.tree.set(notes.engineName, 3 * MB);
    await measureVolume(host, notes.id);

    figures.unreadable.add(notes.engineName);
    await rejectionOf(measureVolume(host, notes.id));
    expect(await getVolume(host, notes.id)).toMatchObject({
      bytes: 3 * MB,
      usage: { lastError: expect.stringContaining("Permission denied") },
    });

    figures.unreadable.delete(notes.engineName);
    figures.tree.set(notes.engineName, 5 * MB);
    await measureVolume(host, notes.id);
    expect(await getVolume(host, notes.id)).toMatchObject({ bytes: 5 * MB, usage: { lastError: null } });
  });

  test("the trend keeps the last 24 samples", async () => {
    const notes = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    for (let n = 1; n <= 30; n++) {
      figures.tree.set(notes.engineName, n * MB);
      await measureVolume(host, notes.id);
    }

    const view = await getVolume(host, notes.id);
    expect(view.bytes).toBe(30 * MB);
    expect(view.usage.history).toHaveLength(24);
    expect(view.usage.history[0]?.bytes).toBe(7 * MB);
    expect(view.usage.history.at(-1)?.bytes).toBe(30 * MB);
  });
});

describe("a frozen mount does not hold back the other volumes", () => {
  test("the share answers at its deadline, while the local volume is sampled at once, on that pass and the next", async () => {
    await savePools(host, NAS_POOLS, undefined);
    const work = await createVolume(host, { name: "work", pool: "local", role: null, createdBy: "owner" });
    const shared = await createVolume(host, { name: "shared", pool: "nas", role: null, createdBy: "owner" });
    const root = poolRootVolume(host.prefix, "nas");
    figures.tree.set(work.engineName, 1 * MB);

    const frozen = runtime.hold("runHelper", (args) => isShareProbeOf(args[0] as HelperSpec, root));
    jest.useFakeTimers();
    try {
      const started = Date.now();
      const first = pass();
      await untilDone(() => host.volumes.read(work.id)?.bytes === 1 * MB);
      expect(host.volumes.read(shared.id)?.bytes ?? null).toBeNull();
      expect(Date.now() - started).toBe(0);

      await advance(SHARE_DEADLINE_MS);
      await first;
      expect(Date.now() - started).toBe(SHARE_DEADLINE_MS);
      expect(host.volumes.usageMemory(shared.id).lastError).toBe(
        msg("storage_unreachable", { pool: "nas", detail: "no answer within 30 s" }).text,
      );

      figures.tree.set(work.engineName, 2 * MB);
      const second = pass();
      await untilDone(() => host.volumes.read(work.id)?.bytes === 2 * MB);
      expect(Date.now() - started).toBe(SHARE_DEADLINE_MS);

      await advance(SHARE_DEADLINE_MS);
      await second;
    } finally {
      frozen.release();
      jest.useRealTimers();
    }
  });

  test("a volume whose sample is still running is not asked again, and the other volumes are sampled on every pass", async () => {
    const slow = await createVolume(host, { name: "slow", pool: "local", role: null, createdBy: "owner" });
    const quick = await createVolume(host, { name: "quick", pool: "local", role: null, createdBy: "owner" });
    figures.tree.set(quick.engineName, 1 * MB);

    const frozen = runtime.hold("runHelper", (args) => isTreeOf(args[0] as HelperSpec, slow.engineName));
    try {
      const first = pass();
      await untilDone(() => host.volumes.read(quick.id)?.bytes === 1 * MB);

      figures.tree.set(quick.engineName, 2 * MB);
      await pass();
      expect(host.volumes.read(quick.id)?.bytes).toBe(2 * MB);
      expect(runsOf("du -sb").filter((spec) => spec.mounts?.[0]?.source === slow.engineName)).toHaveLength(1);

      frozen.release();
      await first;
    } finally {
      frozen.release();
    }
  });
});

describe("crossing a limit raises one event, and the event carries the reason", () => {
  test("crossing the soft limit raises volume.usage_high once, and again only after the volume drops below it", async () => {
    const notes = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    setVolumeLimits(host, notes.id, { softBytes: 2 * MB, hardBytes: 8 * MB, action: "warn" });

    figures.tree.set(notes.engineName, 3 * MB);
    await pass();
    figures.tree.set(notes.engineName, 3.5 * MB);
    await pass();
    expect(eventsOf("volume.usage_high")).toHaveLength(1);

    figures.tree.set(notes.engineName, 1 * MB);
    await pass();
    figures.tree.set(notes.engineName, 3 * MB);
    await pass();

    const highs = eventsOf("volume.usage_high");
    expect(highs).toHaveLength(2);
    expect(highs[0]).toMatchObject({
      status: "ok",
      target: { kind: "volume", id: notes.id, name: "notes" },
      detail: { volumeId: notes.id, bytes: 3 * MB, softBytes: 2 * MB, hardBytes: 8 * MB },
    });
  });

  test("over the hard limit with the warn action, the soft and hard events are each raised once with their reasons, and no box is stopped", async () => {
    const notes = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    const alpha = await boxes.createBox(host, {
      name: "alpha",
      cpus: 1,
      memoryMb: 256,
      mounts: [{ volume: "notes", path: "/srv/notes", mode: "rw" }],
    });
    setVolumeLimits(host, notes.id, { softBytes: 2 * MB, hardBytes: 4 * MB, action: "warn" });
    figures.tree.set(notes.engineName, 5 * MB);

    await pass();
    await pass();

    const limits = eventsOf("volume.usage_limit");
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({
      status: "error",
      error: { code: "volume_over_limit", status: 409 },
      detail: {
        volumeId: notes.id,
        bytes: 5 * MB,
        hardBytes: 4 * MB,
        action: "warn",
        reason: "volume_limit",
        boxes: [],
      },
    });
    expect(eventsOf("volume.usage_high")).toHaveLength(1);
    expect((await boxes.getBox(host, alpha.boxId)).running).toBe(true);
  });

  test("over the hard limit with the stop action, the running boxes that mount the volume stop with the reason, and the rest are left alone", async () => {
    const data = await createVolume(host, { name: "data", role: null, createdBy: "owner" });
    setVolumeLimits(host, data.id, { softBytes: 2 * MB, hardBytes: 4 * MB, action: "stop" });
    const alpha = await boxes.createBox(host, {
      name: "alpha",
      cpus: 1,
      memoryMb: 256,
      mounts: [{ volume: "data", path: "/srv/data", mode: "rw" }],
    });
    const beta = await boxes.createBox(host, { name: "beta", cpus: 1, memoryMb: 256, mounts: [] });
    const gamma = await boxes.createBox(host, {
      name: "gamma",
      cpus: 1,
      memoryMb: 256,
      mounts: [{ volume: "data", path: "/srv/data", mode: "ro" }],
    });
    await boxes.stopBox(host, gamma.boxId);
    figures.tree.set(data.engineName, 5 * MB);

    await pass();

    expect((await boxes.getBox(host, alpha.boxId)).running).toBe(false);
    expect(host.specs.read(alpha.boxId)?.lifecycle).toMatchObject({ desired: "stopped", stopReason: "volume_limit" });
    expect((await boxes.getBox(host, beta.boxId)).running).toBe(true);
    expect(host.specs.read(gamma.boxId)?.lifecycle).toMatchObject({ desired: "stopped", stopReason: "manual" });
    expect(eventsOf("volume.usage_limit")[0]).toMatchObject({
      detail: { action: "stop", reason: "volume_limit", boxes: [{ id: alpha.boxId, name: "alpha" }] },
    });

    await pass();
    expect(eventsOf("volume.usage_limit")).toHaveLength(1);
  });

  test("while a volume stays over its hard stop limit its boxes cannot start, and new boxes or attachments cannot take it", async () => {
    const data = await createVolume(host, { name: "data", role: null, createdBy: "owner" });
    setVolumeLimits(host, data.id, { softBytes: 2 * MB, hardBytes: 4 * MB, action: "stop" });
    const alpha = await boxes.createBox(host, {
      name: "alpha",
      cpus: 1,
      memoryMb: 256,
      mounts: [{ volume: "data", path: "/srv/data", mode: "rw" }],
    });
    const beta = await boxes.createBox(host, { name: "beta", cpus: 1, memoryMb: 256, mounts: [] });
    figures.tree.set(data.engineName, 5 * MB);
    await pass();

    expect(await rejectionOf(boxes.startBox(host, alpha.boxId))).toMatchObject({
      status: 409,
      key: "volume_over_limit",
    });
    expect(
      await rejectionOf(
        boxes.createBox(host, {
          name: "delta",
          cpus: 1,
          memoryMb: 256,
          mounts: [{ volume: "data", path: "/srv/data", mode: "rw" }],
        }),
      ),
    ).toMatchObject({ status: 409, key: "volume_over_limit" });
    expect(
      await rejectionOf(
        attachVolume(host, data.id, {
          box: beta.boxId,
          path: "/srv/data",
          mode: "rw",
          revision: beta.revision,
          confirm: true,
        }),
      ),
    ).toMatchObject({ status: 409, key: "volume_over_limit" });

    figures.tree.set(data.engineName, 1 * MB);
    await pass();
    await boxes.startBox(host, alpha.boxId);
    expect((await boxes.getBox(host, alpha.boxId)).running).toBe(true);
  });

  test("an NFS volume takes no limit of its own, since its usage is the whole share's", async () => {
    await savePools(host, NAS_POOLS, undefined);
    const shared = await createVolume(host, { name: "shared", pool: "nas", role: null, createdBy: "owner" });

    expect(thrown(() => setVolumeLimits(host, shared.id, { softBytes: 1 * MB }))).toMatchObject({
      status: 400,
      key: "volume_limit_nfs",
    });
    expect(host.volumes.read(shared.id)?.limits).toEqual(UNLIMITED);
  });
});

describe("the host's free-space floor", () => {
  test("below the floor a new volume, a new box and a checkpoint are refused with 507, and the low disk is announced once", async () => {
    const alpha = await boxes.createBox(host, { name: "alpha", cpus: 1, memoryMb: 256 });
    runtime.disk = { totalBytes: DISK_TOTAL, freeBytes: 5 * GB };
    await remeasureHostDisk(host);

    expect(
      await rejectionOf(createVolume(host, { name: "scratch", pool: "local", role: null, createdBy: "owner" })),
    ).toMatchObject({ status: 507, code: "insufficient_storage", key: "host_disk_low" });
    expect(await rejectionOf(boxes.createBox(host, { name: "beta", cpus: 1, memoryMb: 256 }))).toMatchObject({
      status: 507,
      code: "insufficient_storage",
    });
    expect(
      await rejectionOf(
        takeCheckpoint(
          host,
          alpha.boxId,
          { pinned: false, include: { system: false, volumes: [] }, consistency: "live" },
          "owner",
        ),
      ),
    ).toMatchObject({ status: 507, code: "insufficient_storage" });

    await pass();
    await pass();
    expect(eventsOf("host.disk_low")).toHaveLength(1);
    expect(eventsOf("host.disk_low")[0]).toMatchObject({
      status: "error",
      error: { code: "insufficient_storage", status: 507 },
      detail: { freePercent: 5, minFreePercent: 10 },
    });

    runtime.disk = { totalBytes: DISK_TOTAL, freeBytes: 40 * GB };
    await pass();
    expect((await createVolume(host, { name: "scratch", pool: "local", role: null, createdBy: "owner" })).name).toBe(
      "scratch",
    );

    runtime.disk = { totalBytes: DISK_TOTAL, freeBytes: 5 * GB };
    await pass();
    expect(eventsOf("host.disk_low")).toHaveLength(2);
  });

  test("a floor of 0 turns the check off: nothing is refused and no low disk is announced", async () => {
    const off = createTestApp({ labelPrefix: "mbtest", hostDiskMinFreePercent: 0 });
    off.runtime.disk = { totalBytes: DISK_TOTAL, freeBytes: 1 * GB };
    const local = off.app.hosts.get();

    expect((await createVolume(local, { name: "scratch", pool: "local", role: null, createdBy: "owner" })).name).toBe(
      "scratch",
    );
    await off.app.volumeUsage.tick();
    expect(off.app.events.list({ op: "host.disk_low" }, { limit: 5 }).events).toEqual([]);
  });

  test("a disk that cannot be measured does not refuse anything", async () => {
    runtime.disk = { totalBytes: DISK_TOTAL, freeBytes: 5 * GB };
    spyOn(runtime, "diskUsage").mockRejectedValue(new RuntimeError("engine", "statfs failed"));
    runtime.helperHandler = (spec) =>
      spec.cmd.join(" ").includes("df -B1 -P")
        ? { exitCode: 1, logs: "df: /mnt: cannot be read\n" }
        : volumeAwareHelper(runtime, spec);
    expect(await remeasureHostDisk(host)).toBeNull();
    expect((await createVolume(host, { name: "scratch", pool: "local", role: null, createdBy: "owner" })).name).toBe(
      "scratch",
    );
  });
});

describe("the watcher's clock and the limits route", () => {
  test("the first pass runs 30 seconds after start, then one pass runs each interval, and stop ends them", () => {
    const tick = spyOn(app.volumeUsage, "tick").mockResolvedValue(undefined);
    jest.useFakeTimers();
    try {
      app.volumeUsage.start();
      app.volumeUsage.start();
      jest.advanceTimersByTime(29_999);
      expect(tick).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(tick).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(569_999);
      expect(tick).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1);
      expect(tick).toHaveBeenCalledTimes(2);

      app.volumeUsage.stop();
      jest.advanceTimersByTime(3_600_000);
      expect(tick).toHaveBeenCalledTimes(2);
    } finally {
      app.volumeUsage.stop();
      tick.mockRestore();
      jest.useRealTimers();
    }
  });

  test("the route sets and clears limits, refuses a soft limit above the hard one, and the volume shows its usage", async () => {
    const h = startHarness({ labelPrefix: "mbtest" });
    try {
      const created = await call(h.base, "/api/volumes", {
        method: "POST",
        body: { name: "notes", role: null, confirm: true },
      });
      expect(created.status).toBe(201);
      const id = (created.json as unknown as VolumeReply).volume.id;

      const set = await call(h.base, `/api/volumes/${id}/limits`, {
        method: "PUT",
        body: { softBytes: 2 * MB, hardBytes: 4 * MB, action: "stop" },
      });
      expect(set.status).toBe(200);
      expect((set.json as unknown as VolumeReply).volume.limits).toEqual({
        softBytes: 2 * MB,
        hardBytes: 4 * MB,
        action: "stop",
      });

      const refusedSet = await call(h.base, `/api/volumes/${id}/limits`, {
        method: "PUT",
        body: { softBytes: 5 * MB },
      });
      expect(refused(refusedSet)).toEqual({ status: 400, key: "volume_limit_order" });

      h.runtime.helperHandler = (spec) =>
        spec.cmd[0] === "du" ? { exitCode: 0, logs: `${3 * MB}\t/mnt\n` } : volumeAwareHelper(h.runtime, spec);
      const measured = await call(h.base, `/api/volumes/${id}/usage`, { method: "POST" });
      expect(measured.status).toBe(200);
      expect((measured.json as unknown as VolumeReply).volume).toMatchObject({
        bytes: 3 * MB,
        usage: { scope: "volume", level: "soft" },
      });

      const read = await call(h.base, `/api/volumes/${id}`);
      expect((read.json as unknown as VolumeReply).volume.usage.level).toBe("soft");
    } finally {
      h.stop();
    }
  });
});

describe("a limit reaches the channels that take it", () => {
  test("a soft and a hard limit are sent with their reasons, and a channel that does not take them is sent nothing", async () => {
    app.notify.store.save(channelOf({ id: "ops" }));
    app.notify.store.save(channelOf({ id: "boxes", events: ["box.oom"] }));
    const notes = await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    setVolumeLimits(host, notes.id, { softBytes: 2 * MB, hardBytes: 4 * MB, action: "warn" });

    figures.tree.set(notes.engineName, 3 * MB);
    await pass();
    await app.notify.idle();
    figures.tree.set(notes.engineName, 5 * MB);
    await pass();
    await app.notify.idle();

    expect(sent.map((request) => JSON.parse(request.body))).toEqual([
      expect.objectContaining({
        kind: "volume.usage_high",
        title: "Volume over its soft limit: notes",
        body: "Using 3 MB against a soft limit of 2 MB. A soft limit is best effort, not a quota.",
      }),
      expect.objectContaining({
        kind: "volume.usage_limit",
        title: "Volume over its hard limit: notes",
        body: "Reason: over the hard limit of 4 MB, with 5 MB used. Action: warn.",
      }),
    ]);
  });

  test("a notice for a stopped box names the box in its body", () => {
    const stopped = noticeOfEvent({
      id: "01VOLUMEUSAGE0000000000000",
      ts: Date.UTC(2026, 9, 22, 10, 0, 0),
      durationMs: 0,
      status: "error",
      kind: "write",
      op: "volume.usage_limit",
      principal: { type: "system", id: "system", name: "system" },
      source: "system",
      hostId: "local",
      summary: "",
      target: { kind: "volume", id: "vol_notes", name: "notes" },
      detail: {
        volumeId: "vol_notes",
        bytes: 5 * MB,
        hardBytes: 4 * MB,
        action: "stop",
        reason: "volume_limit",
        boxes: [{ id: "bx_alpha", name: "alpha" }],
      },
      seq: 1,
      tier: "audit",
      count: 1,
    });
    expect(stopped?.body).toBe("Reason: over the hard limit of 4 MB, with 5 MB used. Action: stop. Stopped: alpha.");
  });
});
