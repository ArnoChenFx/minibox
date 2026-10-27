import { beforeEach, describe, expect, test } from "bun:test";

import { NO_LIVE } from "../src/host/live";
import { createHost, type HostCtx, type HostIdentity, LOCAL_HOST_ID } from "../src/host/registry";
import type { AppError } from "../src/lib/errors";
import { hostLabelsText, matchesHostLabels, placeBox, type PlacementRequest } from "../src/services/placement";
import { createTestApp, rejectionOf } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";

const GIB = 1024 ** 3;
const IMAGE = "mbtest-template:base";

/** The capacity each fake engine reports, so which host is roomiest does not depend on the machine running the tests. */
const SMALL = { cpus: 2, memoryBytes: 4 * GIB };
const LARGE = { cpus: 8, memoryBytes: 16 * GIB };

interface TestHost {
  readonly ctx: HostCtx;
  readonly runtime: FakeRuntime;
}

let app: ReturnType<typeof createTestApp>["app"];

beforeEach(() => {
  app = createTestApp({ labelPrefix: "mbtest" }).app;
});

/**
 * A remote host with a fake engine of a fixed size, so the roomiest host is decided by the numbers a test gives rather than
 * by the machine. It shares the app's stores, as the composition root does for a host added at runtime.
 */
function makeHost(
  id: string,
  engine: { cpus: number; memoryBytes: number },
  labels: Record<string, string> = {},
  transport: HostIdentity["transport"] = "unix",
  withImage = true,
): TestHost {
  const base = app.hosts.get();
  const runtime = new FakeRuntime();
  runtime.engine = engine;
  if (withImage) runtime.seedImage(IMAGE, { [base.keys.template]: "true" });
  const ctx = createHost(
    app.cfg,
    runtime,
    {
      specs: base.specs,
      volumes: base.volumes,
      secrets: base.secrets,
      live: NO_LIVE,
      pulse: base.pulse,
      checkpoints: base.checkpoints,
      checkpointEngine: base.checkpointEngine,
      selfTokens: base.selfTokens,
      questions: base.questions,
      multiHost: () => true,
      egress: base.egress,
      activity: base.activity,
    },
    { id, name: id, transport, endpoint: `unix:///run/${id}.sock`, labels },
  );
  ctx.host.status = "online";
  return { ctx, runtime };
}

/** A host whose engine does not hold the template, so only a buildable placement may choose it. */
function makeHostWithoutImage(
  id: string,
  engine: { cpus: number; memoryBytes: number },
  labels: Record<string, string> = {},
): TestHost {
  return makeHost(id, engine, labels, "unix", false);
}

const request = (overrides: Partial<PlacementRequest> = {}): PlacementRequest => ({
  cpus: 1,
  memoryMb: 256,
  image: IMAGE,
  ...overrides,
});

const refusal = async (hosts: readonly HostCtx[], want: PlacementRequest): Promise<AppError> => {
  const error = await rejectionOf(placeBox(hosts, want));
  if (!(error instanceof Error)) throw new Error("the placement was expected to fail");
  return error as AppError;
};

describe("a host label matches only when every requested entry does", () => {
  test("an empty request matches any host, and an empty set of host labels matches an empty request only", () => {
    const { ctx } = makeHost("plain", SMALL);
    expect(matchesHostLabels(ctx, undefined)).toBe(true);
    expect(matchesHostLabels(ctx, {})).toBe(true);
    expect(matchesHostLabels(ctx, { gpu: "" })).toBe(false);
    ctx.host.labels = { gpu: "" };
    expect(matchesHostLabels(ctx, { gpu: "" })).toBe(true);
    expect(matchesHostLabels(ctx, { gpu: "true" })).toBe(false);
  });

  test("a namespaced key and a value both have to be present and equal", () => {
    const { ctx } = makeHost("lab", SMALL, { "org/arch": "amd64", gpu: "true" });
    expect(matchesHostLabels(ctx, { "org/arch": "amd64" })).toBe(true);
    expect(matchesHostLabels(ctx, { gpu: "true", "org/arch": "amd64" })).toBe(true);
    expect(matchesHostLabels(ctx, { "org/arch": "arm64" })).toBe(false);
    expect(matchesHostLabels(ctx, { arch: "amd64" })).toBe(false);
    expect(matchesHostLabels(ctx, { gpu: "true", zone: "eu" })).toBe(false);
  });

  test("the refusal names the labels in the order the caller gave them", () => {
    expect(hostLabelsText({ gpu: "true", arch: "" })).toBe("gpu=true, arch");
    expect(hostLabelsText({})).toBe("");
  });
});

describe("auto placement with host labels", () => {
  test("only the hosts that carry every label are candidates, so the roomier unlabelled host is not chosen", async () => {
    const small = makeHost("small", SMALL, { gpu: "true" });
    const large = makeHost("large", LARGE, {});
    const winner = await placeBox([small.ctx, large.ctx], request({ hostLabels: { gpu: "true" } }));
    expect(winner.host.id).toBe("small");
  });

  test("the roomiest of the labelled hosts wins, and an unlabelled request keeps the roomiest of them all", async () => {
    const first = makeHost("first", SMALL, { gpu: "true" });
    const second = makeHost("second", LARGE, { gpu: "true" });
    expect((await placeBox([first.ctx, second.ctx], request({ hostLabels: { gpu: "true" } }))).host.id).toBe("second");
    expect((await placeBox([first.ctx, second.ctx], request())).host.id).toBe("second");
  });

  test("an empty hostLabels object places the box as it always did, and an empty label set still matches", async () => {
    const plain = makeHost("plain", SMALL, {});
    const large = makeHost("large", LARGE, {});
    expect((await placeBox([plain.ctx, large.ctx], request({ hostLabels: {} }))).host.id).toBe("large");
    // `{}` in the request is the same as sending nothing: it asks for no label at all.
    expect((await placeBox([plain.ctx, large.ctx], request({ hostLabels: {} }))).host.labels).toEqual({});
  });

  test("an offline host is skipped even when it carries the labels", async () => {
    const online = makeHost("online", SMALL, { gpu: "true" });
    const offline = makeHost("offline", LARGE, { gpu: "true" });
    offline.ctx.host.status = "offline";
    const winner = await placeBox([online.ctx, offline.ctx], request({ hostLabels: { gpu: "true" } }));
    expect(winner.host.id).toBe("online");
  });

  test("labels no online host carries are a 4xx that names them, before any engine is read", async () => {
    const small = makeHost("small", SMALL, { gpu: "true" });
    const error = await refusal([small.ctx], request({ hostLabels: { gpu: "false" } }));
    expect(error).toMatchObject({
      status: 422,
      code: "insufficient_capacity",
      key: "host_auto_no_label_match",
      params: { labels: "gpu=false" },
      details: { field: "hostLabels" },
    });
    expect(error.message).toContain("gpu=false");
    expect(small.runtime.callsTo("inspectImage")).toHaveLength(0);
  });

  test("a host whose labels only partly match is not a candidate, so a set that no host carries is refused", async () => {
    const small = makeHost("small", SMALL, { gpu: "true" });
    const error = await refusal([small.ctx], request({ hostLabels: { gpu: "true", arch: "amd64" } }));
    expect(error.key).toBe("host_auto_no_label_match");
    expect(error.params).toEqual({ labels: "gpu=true, arch=amd64" });
  });

  test("labels filter before the template preference: a labelled host without the template is not a fallback", async () => {
    const labelledHolder = makeHost("holder", SMALL, { gpu: "true" });
    const labelledBuilder = makeHostWithoutImage("builder", LARGE, { gpu: "true" });
    const unlabelledHolder = makeHost("other", LARGE, {});
    // Without labels the roomier holder wins; with them the labelled holder does, even though the labelled builder is
    // roomier than it.
    expect((await placeBox([labelledHolder.ctx, labelledBuilder.ctx, unlabelledHolder.ctx], request())).host.id).toBe(
      "other",
    );
    expect(
      (
        await placeBox(
          [labelledHolder.ctx, labelledBuilder.ctx, unlabelledHolder.ctx],
          request({ hostLabels: { gpu: "true" } }),
        )
      ).host.id,
    ).toBe("holder");
  });

  test("when no labelled host holds the template and one is buildable, the roomiest labelled builder takes it", async () => {
    const holder = makeHost("holder", LARGE, {});
    const builder = makeHostWithoutImage("builder", SMALL, { gpu: "true" });
    const winner = await placeBox([holder.ctx, builder.ctx], request({ hostLabels: { gpu: "true" }, buildable: true }));
    expect(winner.host.id).toBe("builder");
  });

  test("an agent host is never a labelled builder, since it builds nothing", async () => {
    const agent = makeHostWithoutImage("agent", LARGE, { gpu: "true" });
    agent.ctx.host.transport = "agent";
    const error = await refusal([agent.ctx], request({ hostLabels: { gpu: "true" }, buildable: true }));
    expect(error).toMatchObject({ status: 400, key: "template_image_missing", details: { field: "template" } });
  });

  test("labels and the overcommit ratio together: a labelled host past its limit is refused with the no-room answer", async () => {
    const small = makeHost("small", { cpus: 2, memoryBytes: 4 * GIB }, { gpu: "true" });
    small.ctx.capacityPolicy = { overcommit: 2 };
    const large = makeHost("large", LARGE, { gpu: "true" });
    large.ctx.capacityPolicy = { overcommit: 2 };
    // 3 CPUs fit the small host only because of the ratio, so the ratio is what makes it the roomiest candidate.
    const winner = await placeBox(
      [small.ctx, large.ctx],
      request({ cpus: 3, memoryMb: 256, hostLabels: { gpu: "true" } }),
    );
    expect(winner.host.id).toBe("large");

    // The same labelled set with no ratio left for a 3-CPU box refuses it rather than falling back to a host without the
    // label, which is not a candidate at all.
    const tight = makeHost("tight", { cpus: 2, memoryBytes: 4 * GIB }, { gpu: "true" });
    const error = await refusal([tight.ctx], request({ cpus: 3, memoryMb: 256, hostLabels: { gpu: "true" } }));
    expect(error).toMatchObject({ status: 422, key: "host_auto_no_room" });
  });

  test("a labelled box that no host has room for is the no-room answer, never the label one", async () => {
    const small = makeHost("small", { cpus: 2, memoryBytes: 4 * GIB }, { gpu: "true" });
    const error = await refusal([small.ctx], request({ cpus: 16, memoryMb: 256, hostLabels: { gpu: "true" } }));
    expect(error).toMatchObject({ status: 422, key: "host_auto_no_room" });
  });

  test("an unlabelled request over a control plane whose hosts carry labels behaves as it always did", async () => {
    const small = makeHost("small", SMALL, { gpu: "true" });
    const large = makeHost("large", LARGE, { zone: "eu" });
    expect((await placeBox([small.ctx, large.ctx], request())).host.id).toBe("large");
    const error = await refusal([small.ctx, large.ctx], request({ cpus: 64, memoryMb: 262144 }));
    expect(error.key).toBe("host_auto_no_room");
  });

  test("a request with no online host at all is the offline answer, labels or not", async () => {
    const down = makeHost("down", SMALL, { gpu: "true" });
    down.ctx.host.status = "offline";
    const error = await refusal([down.ctx], request({ hostLabels: { gpu: "true" } }));
    expect(error).toMatchObject({ status: 503, key: "host_auto_offline" });
  });
});

describe("the local host carries labels like any other", () => {
  test("a local host built with labels matches a request for them, and its id stays local", async () => {
    const { ctx } = makeHost(LOCAL_HOST_ID, SMALL, { gpu: "true", "org/arch": "amd64" });
    expect(ctx.host.labels).toEqual({ gpu: "true", "org/arch": "amd64" });
    expect((await placeBox([ctx], request({ hostLabels: { gpu: "true" } }))).host.id).toBe(LOCAL_HOST_ID);
  });

  test("a local host with no configured labels carries an empty set, never undefined", () => {
    expect(app.hosts.get().host.labels).toEqual({});
  });
});
