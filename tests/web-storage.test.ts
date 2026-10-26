import { describe, expect, test } from "bun:test";

import { groupCheckpoints } from "../web/js/lib/checkpoint-groups.js";
import { latestByVolume, snapshotPlan, stagedMountsByVolume } from "../web/js/lib/volume-row.js";

const ck = (id: string, boxId: string | null, createdAt: string, volumes: string[] = [], extra = {}) => ({
  id,
  boxId,
  boxName: boxId ? `name-${boxId}` : "gone",
  createdAt,
  bytes: 10,
  data: volumes.map((volumeId) => ({ volumeId })),
  ...extra,
});

const volume = (extra = {}) => ({
  id: "v1",
  role: null,
  checkpoint: true,
  ownership: "independent",
  ownerBoxId: null,
  mounts: [{ boxId: "b1", boxName: "one" }],
  ...extra,
});

describe("storage checkpoint timeline", () => {
  test("groups by box, newest first, with totals, and keeps boxes without checkpoints", () => {
    const groups = groupCheckpoints(
      [
        ck("a", "b1", "2026-10-01T00:00:00Z"),
        ck("b", "b1", "2026-10-03T00:00:00Z"),
        ck("c", "b2", "2026-10-02T00:00:00Z"),
      ],
      [
        { boxId: "b1", name: "one" },
        { boxId: "b2", name: "two" },
        { boxId: "b3", name: "three" },
      ],
    );
    expect(groups.map((group) => group.name)).toEqual(["one", "two", "three"]);
    expect(groups[0]!.rows.map((row) => row.id)).toEqual(["b", "a"]);
    expect(groups[0]!.bytes).toBe(20);
    expect(groups[2]!.rows).toEqual([]);
  });

  test("a box with a pending rollback comes first and deleted boxes come last under their old name", () => {
    const groups = groupCheckpoints(
      [
        ck("a", "b1", "2026-10-05T00:00:00Z"),
        ck("b", "b2", "2026-10-01T00:00:00Z"),
        ck("c", "b9", "2026-10-09T00:00:00Z", [], { boxName: "gone" }),
      ],
      [
        { boxId: "b1", name: "one" },
        { boxId: "b2", name: "two" },
      ],
      new Map([["b2", { id: "rb" }]]),
    );
    expect(groups.map((group) => group.id)).toEqual(["b2", "b1", "b9"]);
    expect(groups[0]!.pending).toEqual({ id: "rb" });
    expect(groups[2]).toMatchObject({ deleted: true, name: "gone", box: null });
  });
});

/** A record of a snapshot taken of one volume on its own: it names no box, and its box name is the volume's. */
const volumeSnapshot = (id: string, volumeName: string, createdAt: string) =>
  ck(id, null, createdAt, ["v1"], { boxName: volumeName });

describe("storage checkpoint timeline: volume snapshots", () => {
  test("a record with no box is grouped under the volume it holds, and is not a deleted box", () => {
    const groups = groupCheckpoints(
      [
        volumeSnapshot("a", "notes", "2026-10-04T00:00:00Z"),
        ck("b", "b9", "2026-10-01T00:00:00Z", [], { boxName: "gone" }),
      ],
      [{ boxId: "b1", name: "one" }],
    );
    expect(groups.map((group) => [group.id, group.name, group.deleted, group.volume])).toEqual([
      ["b1", "one", false, undefined],
      ["volume:notes", "notes", false, true],
      ["b9", "gone", true, false],
    ]);
    expect(groups[1]!.rows.map((row) => row.id)).toEqual(["a"]);
  });

  test("snapshots of two volumes are two groups, each named after its own volume", () => {
    const groups = groupCheckpoints(
      [volumeSnapshot("a", "notes", "2026-10-04T00:00:00Z"), volumeSnapshot("b", "data", "2026-10-02T00:00:00Z")],
      [],
    );
    expect(groups.map((group) => group.name)).toEqual(["notes", "data"]);
  });
});

describe("storage volume rows", () => {
  test("the latest checkpoint of each volume is the newest that holds it", () => {
    const latest = latestByVolume([
      ck("old", "b1", "2026-10-01T00:00:00Z", ["v1", "v2"]),
      ck("new", "b1", "2026-10-04T00:00:00Z", ["v1"]),
    ]);
    expect(latest.get("v1")?.id).toBe("new");
    expect(latest.get("v2")?.id).toBe("old");
    expect(latest.has("v3")).toBe(false);
  });

  test("an independent volume is snapshotted on its own, without borrowing the box that mounts it", () => {
    expect(snapshotPlan(volume())).toEqual({ block: "", own: true, boxId: null, boxName: null, include: ["v1"] });
  });

  test("an independent volume that no box mounts can still be snapshotted", () => {
    expect(snapshotPlan(volume({ mounts: [] }))).toEqual({
      block: "",
      own: true,
      boxId: null,
      boxName: null,
      include: ["v1"],
    });
  });

  test("an owned volume snapshots with its owner box, and excluded or orphaned ones are blocked", () => {
    expect(snapshotPlan(volume({ ownership: "owned", ownerBoxId: "b1" }))).toEqual({
      block: "",
      own: false,
      boxId: "b1",
      boxName: "one",
      include: [],
    });
    expect(snapshotPlan(volume({ ownership: "owned", ownerBoxId: "b1", ownerMissing: true })).block).toBe(
      "vol.snapshotNoBox",
    );
    expect(snapshotPlan(volume({ role: "tools" })).block).toBe("vol.snapshotExcluded");
    expect(snapshotPlan(volume({ checkpoint: false })).block).toBe("vol.snapshotExcluded");
  });

  test("staged mounts name the boxes that will mount a volume, leaving out boxes that already do", () => {
    const staged = stagedMountsByVolume(
      [
        { box: { boxId: "b1", name: "one" }, staged: { fields: { mounts: [{ volume: "v1" }, { volume: "v2" }] } } },
        { box: { boxId: "b2", name: "two" }, staged: { fields: { mounts: [{ volume: "v2" }] } } },
        { box: { boxId: "b3", name: "three" }, staged: null },
      ],
      [
        { id: "v1", mounts: [{ boxId: "b1" }] },
        { id: "v2", mounts: [] },
      ],
    );
    expect(staged.has("v1")).toBe(false);
    expect(staged.get("v2")).toEqual(["one", "two"]);
  });

  test("a staged mount of an adopted volume, named by its engine name, counts for that volume", () => {
    const staged = stagedMountsByVolume(
      [
        {
          box: { boxId: "b1", name: "one" },
          staged: { fields: { mounts: [{ volume: "old-data" }, { volume: "gone" }] } },
        },
      ],
      [{ id: "vol_1", name: "old-data", engineName: "old-data", mounts: [] }],
    );
    expect(staged.get("vol_1")).toEqual(["one"]);
    expect(staged.size).toBe(1);
  });
});
