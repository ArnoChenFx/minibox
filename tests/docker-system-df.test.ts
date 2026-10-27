import { describe, expect, test } from "bun:test";

import type Docker from "dockerode";

import { createEngine } from "../src/docker/engine";
import { systemMethods, toDiskBreakdown } from "../src/docker/system";
import { isRuntimeError, RuntimeError } from "../src/runtime";

/** The four classes, in the order `docker system df` prints them. */
const CLASSES = ["images", "containers", "volumes", "buildCache"] as const;

/** A `docker.df()` stand-in: records the options it was given and answers with `answer`. */
function engineWith(answer: () => Promise<unknown>) {
  const calls: { opts?: { abortSignal?: AbortSignal } }[] = [];
  const docker = {
    df: async (opts?: { abortSignal?: AbortSignal }) => {
      calls.push({ opts });
      return answer();
    },
  } as unknown as Docker;
  return { engine: createEngine(docker), calls };
}

const ENTRY = { count: 2, activeCount: 1, totalBytes: 1024, reclaimableBytes: 512 };

describe("the engine's own disk accounting (docker system df)", () => {
  test("an engine of API 1.52 or later reports each class with its own totals", () => {
    const breakdown = toDiskBreakdown({
      ImageUsage: { TotalCount: 5, ActiveCount: 2, TotalSize: 1000, Reclaimable: 400 },
      ContainerUsage: { TotalCount: 3, ActiveCount: 1, TotalSize: 200, Reclaimable: 150 },
      VolumeUsage: { TotalCount: 4, ActiveCount: 3, TotalSize: 3000, Reclaimable: 500 },
      BuildCacheUsage: { TotalCount: 9, ActiveCount: 1, TotalSize: 700, Reclaimable: 600 },
    });
    expect(breakdown).toEqual({
      images: { count: 5, activeCount: 2, totalBytes: 1000, reclaimableBytes: 400 },
      containers: { count: 3, activeCount: 1, totalBytes: 200, reclaimableBytes: 150 },
      volumes: { count: 4, activeCount: 3, totalBytes: 3000, reclaimableBytes: 500 },
      buildCache: { count: 9, activeCount: 1, totalBytes: 700, reclaimableBytes: 600 },
    });
  });

  test("an older engine lists what it holds and gives no totals, which are summed here", () => {
    const breakdown = toDiskBreakdown({
      LayersSize: 999,
      Images: [
        { Size: 600, Containers: 1 },
        { Size: 400, Containers: 0 },
      ],
      Containers: [
        { SizeRw: 10, State: "running" },
        { SizeRw: 20, State: "exited" },
        { SizeRw: 30, State: "created" },
      ],
      Volumes: [
        { UsageData: { Size: 100, RefCount: 1 } },
        { UsageData: { Size: 50, RefCount: 0 } },
        { UsageData: { Size: -1, RefCount: 0 } },
        { UsageData: null },
      ],
      BuildCache: [
        { Size: 70, InUse: true, Shared: false },
        { Size: 30, InUse: false, Shared: false },
        { Size: 20, InUse: false, Shared: true },
      ],
    });
    expect(breakdown).toEqual({
      images: { count: 2, activeCount: 1, totalBytes: 1000, reclaimableBytes: 400 },
      containers: { count: 3, activeCount: 1, totalBytes: 60, reclaimableBytes: 50 },
      // The volume the engine never measured (-1) and the one with no usage data are left out of both sums, not
      // counted as nothing.
      volumes: { count: 4, activeCount: 1, totalBytes: 150, reclaimableBytes: 50 },
      buildCache: { count: 3, activeCount: 1, totalBytes: 100, reclaimableBytes: 30 },
    });
  });

  test("a class the engine does not report is null, not an error and not zero", () => {
    const breakdown = toDiskBreakdown({ ImageUsage: { TotalCount: 1, ActiveCount: 1, TotalSize: 10, Reclaimable: 0 } });
    expect(breakdown.images).toEqual({ count: 1, activeCount: 1, totalBytes: 10, reclaimableBytes: 0 });
    for (const name of ["containers", "volumes", "buildCache"] as const) expect(breakdown[name]).toBeNull();
  });

  test("a figure the engine leaves out is null, and a value it cannot mean is treated as left out", () => {
    const breakdown = toDiskBreakdown({
      ImageUsage: { TotalCount: 2, TotalSize: -1, Reclaimable: "lots" },
      ContainerUsage: {},
    });
    expect(breakdown.images).toEqual({ count: 2, activeCount: null, totalBytes: null, reclaimableBytes: null });
    expect(breakdown.containers).toEqual({
      count: null,
      activeCount: null,
      totalBytes: null,
      reclaimableBytes: null,
    });
  });

  test("an answer that is not an object at all yields nulls rather than throwing", () => {
    for (const raw of [null, undefined, 42, "df", []]) {
      const breakdown = toDiskBreakdown(raw);
      for (const name of CLASSES) expect(breakdown[name]).toBeNull();
    }
  });

  test("`docker.df()` is what is called, and the reading keeps the shape the runtime promises", async () => {
    const { engine, calls } = engineWith(async () => ({
      ImageUsage: { TotalCount: 1, ActiveCount: 1, TotalSize: 10, Reclaimable: 0 },
    }));
    const breakdown = await systemMethods(engine).diskBreakdown();
    expect(calls).toHaveLength(1);
    expect(breakdown.images).toEqual({ count: 1, activeCount: 1, totalBytes: 10, reclaimableBytes: 0 });
    expect(breakdown.volumes).toBeNull();
  });

  test("the caller's signal reaches the engine call, so a read can be cut off", async () => {
    const { engine, calls } = engineWith(async () => ({ ImageUsage: ENTRY }));
    const signal = AbortSignal.timeout(1_000);
    await systemMethods(engine).diskBreakdown({ signal });
    expect(calls[0]?.opts?.abortSignal).toBe(signal);
  });

  test("an engine that refuses the read is a RuntimeError the caller can degrade on", async () => {
    const { engine } = engineWith(async () => {
      throw Object.assign(new Error("(HTTP code 500) server error - boom"), { statusCode: 500 });
    });
    const error = await systemMethods(engine)
      .diskBreakdown()
      .catch((e: unknown) => e);
    expect(isRuntimeError(error, "engine")).toBe(true);
    expect(error).toBeInstanceOf(RuntimeError);
  });
});
