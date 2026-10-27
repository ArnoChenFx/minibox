import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";
import { toJsonSchema } from "../src/operations/jsonschema";
import { OPERATIONS } from "../src/operations/registry";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";
import { DISK_CLASSES, diskReading, diskReadings } from "../web/js/lib/host-disk.js";

const WEB = join(ROOT, "web");
const HOSTS = readFileSync(join(WEB, "js", "components", "settings-hosts.js"), "utf8");
const OVERVIEW = readFileSync(join(WEB, "js", "pages", "overview.js"), "utf8");

const MB = 1024 ** 2;
const CJK = /[\u4e00-\u9fff]/;

const format = (bytes: number) => `${bytes / MB} MB`;

/** A full reading, as `GET /api/hosts/{id}/disk` answers it for a healthy host. */
const FULL = {
  id: "local",
  status: "online",
  checkedAt: "2026-10-26T10:00:00.000Z",
  supported: true,
  reason: null,
  detail: null,
  breakdown: {
    images: { count: 4, activeCount: 2, totalBytes: 600 * MB, reclaimableBytes: 200 * MB },
    containers: { count: 3, activeCount: 1, totalBytes: 30 * MB, reclaimableBytes: 20 * MB },
    volumes: { count: 6, activeCount: 5, totalBytes: 3_000 * MB, reclaimableBytes: 500 * MB },
    buildCache: { count: 9, activeCount: 0, totalBytes: 900 * MB, reclaimableBytes: 900 * MB },
  },
};

describe("the engine storage reading the console draws", () => {
  test("each of the four classes is a line, in the order docker system df prints them", () => {
    expect(DISK_CLASSES.map((entry) => entry.key)).toEqual(["images", "containers", "volumes", "buildCache"]);
    const reading = diskReading(FULL, format);
    expect(reading.reason).toBeNull();
    expect(reading.rows.map((row) => row.key)).toEqual(["images", "containers", "volumes", "buildCache"]);
    expect(reading.rows[0]).toMatchObject({
      total: "600 MB",
      totalBytes: 600 * MB,
      reclaimable: "200 MB",
      reclaimableBytes: 200 * MB,
      reclaimablePercent: 33,
      count: 4,
      activeCount: 2,
    });
  });

  test("a class, or a figure, the engine did not report is skipped rather than drawn as zero", () => {
    const reading = diskReading(
      {
        ...FULL,
        breakdown: {
          images: { count: 2, activeCount: null, totalBytes: null, reclaimableBytes: null },
          containers: null,
          volumes: { count: 1, activeCount: 1, totalBytes: 10 * MB, reclaimableBytes: null },
          buildCache: null,
        },
      },
      format,
    );
    // Only the volume has a total the console can show, and its reclaimable size is unknown rather than 0%.
    expect(reading.rows).toHaveLength(1);
    expect(reading.rows[0]).toMatchObject({
      key: "volumes",
      total: "10 MB",
      reclaimable: null,
      reclaimableBytes: null,
    });
  });

  test("a reading with nothing in it says so, instead of drawing an empty box", () => {
    const empty = { ...FULL, breakdown: { images: null, containers: null, volumes: null, buildCache: null } };
    expect(diskReading(empty, format)).toEqual({ reason: { key: "st.disk.empty", params: {} }, rows: [] });
  });

  test("an agent host says why it has no reading, and so does a host that has not answered yet", () => {
    const agentHost = { ...FULL, supported: false, reason: "agent_host", breakdown: null };
    expect(diskReading(agentHost, format).reason).toEqual({ key: "st.disk.agentHost", params: {} });
    expect(diskReading(null, format).reason).toEqual({ key: "st.disk.unread", params: {} });
    expect(diskReading(undefined, format).reason).toEqual({ key: "st.disk.unread", params: {} });
  });

  test("each way of having no reading names itself, and an engine failure carries the engine's message", () => {
    for (const reason of ["offline", "timeout"]) {
      const disk = { ...FULL, reason, breakdown: null };
      expect(diskReading(disk, format).reason).toEqual({ key: `st.disk.${reason}`, params: {} });
    }
    const failed = { ...FULL, reason: "engine", detail: "the engine said no", breakdown: null };
    expect(diskReading(failed, format).reason).toEqual({
      key: "st.disk.engine",
      params: { detail: "the engine said no" },
    });
    // An engine failure with no message still names the failure.
    expect(diskReading({ ...FULL, reason: "engine", detail: null, breakdown: null }, format).reason).toEqual({
      key: "st.disk.engine",
      params: {},
    });
  });

  test("every class the console draws has a label in both languages, and the Chinese is Chinese", () => {
    for (const { label } of DISK_CLASSES) {
      expect([label, label in en, label in zh]).toEqual([label, true, true]);
      expect([label, en[label] !== zh[label], CJK.test(zh[label] ?? "")]).toEqual([label, true, true]);
    }
  });

  test("every reason line and the two figures have a translation in both languages", () => {
    const keys = [
      "st.disk.title",
      "st.disk.count",
      "st.disk.reclaimable",
      "st.disk.reclaimableUnknown",
      "st.disk.unread",
      "st.disk.empty",
      "st.disk.agentHost",
      "st.disk.offline",
      "st.disk.timeout",
      "st.disk.engine",
      "ov.hostDisk",
    ];
    for (const key of keys) {
      expect([key, key in en, key in zh]).toEqual([key, true, true]);
      expect([key, en[key] !== zh[key], CJK.test(zh[key] ?? "")]).toEqual([key, true, true]);
    }
  });
});

describe("reading every host at once", () => {
  test("one host that does not answer does not take the others' readings with it", async () => {
    const hosts = [{ id: "local" }, { id: "edge" }, { id: "lab" }];
    const readings = await diskReadings(hosts, async (id) => {
      if (id === "edge") throw new Error("no answer");
      return { id, breakdown: null };
    });
    expect(readings).toHaveLength(3);
    expect(readings[0]).toMatchObject({ id: "local", disk: { id: "local" } });
    expect(readings[1]?.error).toBeInstanceOf(Error);
    expect(readings[2]).toMatchObject({ id: "lab", disk: { id: "lab" } });
  });
});

describe("the console asks for a reading once per host, and never for the whole page", () => {
  test("the settings card reads each host's engine storage after drawing, one request per host", () => {
    expect(HOSTS).toContain("/api/hosts/${enc(id)}/disk");
    // The read happens after the table is drawn, so a slow engine does not hold up the card, and only the rows the card
    // shows are asked for: the card is drawn first, then its rows are read.
    expect(HOSTS).toContain("void loadDisk(lines, shown, readDisk);");
    // A failed read leaves the line empty instead of failing the card.
    expect(HOSTS).toContain(".catch(() => null)");
  });

  test("the overview reads every host's storage in parallel, so one host cannot hold up the cards", () => {
    expect(OVERVIEW).toContain("diskReadings(due");
    expect(OVERVIEW).toContain("/api/hosts/${enc(id)}/disk");
    expect(OVERVIEW).toContain("void loadDisk();");
    // The heavier read is not repeated on every tick of the usage figures.
    expect(OVERVIEW).toContain("void loadDisk(HOST_DISK_MS);");
  });
});

describe("the API documents the reading", () => {
  test("host.disk is a read that returns the four classes with their totals and reclaimable bytes", () => {
    const op = OPERATIONS.find((candidate) => candidate.name === "host.disk");
    expect(op).toBeDefined();
    expect(op).toMatchObject({ kind: "read", scope: "host:manage", tag: "hosts", async: false });
    expect(op?.rest).toEqual([{ method: "GET", path: "/api/hosts/:id/disk" }]);
    const schema = toJsonSchema(op!.output, "output") as {
      properties: Record<string, unknown> & {
        reason?: { anyOf?: { enum?: string[] }[] };
      };
    };
    // A class, and a figure within it, is nullable: an engine that does not report it answers null, not zero.
    const entry = schema.properties.breakdown as unknown as {
      anyOf: { properties: Record<string, { anyOf?: { type?: string }[] }> }[];
    };
    const object = entry.anyOf.find((part) => part.properties);
    expect(Object.keys(object?.properties ?? {})).toEqual(["images", "containers", "volumes", "buildCache"]);
    const images = object?.properties.images as unknown as {
      anyOf: { properties: Record<string, { anyOf?: { type?: string }[] }> }[];
    };
    const classFields = Object.keys(images.anyOf[0]?.properties ?? {});
    expect(classFields).toEqual(["count", "activeCount", "totalBytes", "reclaimableBytes"]);
    expect(schema.properties.reason?.anyOf?.map((part) => part.enum).find(Boolean)).toEqual([
      "agent_host",
      "offline",
      "timeout",
      "engine",
    ]);
  });
});
