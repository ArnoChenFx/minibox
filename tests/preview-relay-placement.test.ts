import { describe, expect, test } from "bun:test";

import type { HostCtx } from "../src/host/registry";
import { RELAY_PATHS } from "../src/preview/relay-binary";
import { RelayPlacements } from "../src/preview/relay-placement";

const RELAY_PATH = RELAY_PATHS[0] ?? "";

/**
 * The parts of a host a placement reaches: the architecture of an image, and the file write into a container. The
 * control plane's own host has much more, and none of it is read here.
 */
function engine(options: { arch?: string; write?: () => Promise<void> } = {}): {
  host: HostCtx;
  writes: () => number;
} {
  let writes = 0;
  const runtime = {
    inspectImage: async () => ({ arch: options.arch ?? "x86_64" }),
    inspectContainer: async () => ({ imageId: "sha256:image" }),
    writeContainerFile: async () => {
      writes += 1;
      await options.write?.();
    },
  };
  return { host: { host: { id: "edge" }, runtime } as unknown as HostCtx, writes: () => writes };
}

describe("relay placement records", () => {
  test("connections that place at the same time share one write, and all get the same path", async () => {
    const { host, writes } = engine();
    const placements = new RelayPlacements();

    const placed = await Promise.all([
      placements.place(host, "container", null),
      placements.place(host, "container", null),
      placements.place(host, "container", null),
    ]);

    expect(placed).toEqual([RELAY_PATH, RELAY_PATH, RELAY_PATH]);
    expect(writes()).toBe(1);
  });

  test("a write that failed is not remembered, so the next connection writes it again", async () => {
    let fail = true;
    const { host, writes } = engine({
      write: async () => {
        if (fail) throw new Error("a read-only /tmp");
      },
    });
    const placements = new RelayPlacements();

    expect(await placements.place(host, "container", null)).toBeNull();
    fail = false;
    expect(await placements.place(host, "container", null)).toBe(RELAY_PATH);
    expect(writes()).toBe(2);
  });

  test("a binary that was placed but could not run is placed again once it is forgotten", async () => {
    const { host, writes } = engine();
    const placements = new RelayPlacements();

    expect(await placements.place(host, "container", null)).toBe(RELAY_PATH);
    placements.forget(host, "container");
    expect(await placements.place(host, "container", null)).toBe(RELAY_PATH);
    expect(writes()).toBe(2);
  });

  test("an image with no embedded build places nothing, and is not marked as rejected by the record", async () => {
    const { host, writes } = engine({ arch: "mips" });
    const placements = new RelayPlacements();

    expect(await placements.place(host, "container", null)).toBeNull();
    expect(writes()).toBe(0);
    expect(placements.isRejected(host, "container")).toBe(false);
  });

  test("a rejected container stays rejected, and only for its own container", () => {
    const { host } = engine();
    const placements = new RelayPlacements();

    placements.reject(host, "container");
    expect(placements.isRejected(host, "container")).toBe(true);
    expect(placements.isRejected(host, "rebuilt")).toBe(false);
  });

  test("a rebuilt container under the same box is a new container, so its relay is placed again", async () => {
    const { host, writes } = engine();
    const placements = new RelayPlacements();

    await placements.place(host, "old", null);
    await placements.place(host, "new", null);
    expect(writes()).toBe(2);
  });

  test("which implementation a container settled on is reported once per container, and again when it changes", () => {
    const { host } = engine();
    const placements = new RelayPlacements();

    expect(placements.select(host, "container", "binary")).toBe(true);
    expect(placements.select(host, "container", "binary")).toBe(false);
    expect(placements.select(host, "container", "python3")).toBe(true);
    expect(placements.select(host, "other", "binary")).toBe(true);
  });
});
