import { describe, expect, test } from "bun:test";

import type { Engine } from "../src/docker/engine";
import { hostFirewallMethods } from "../src/docker/host-firewall";

const ALPINE = "alpine:3.20";
const BUILT = "minibox-host-firewall:alpine3.20";
const BUILT_LABEL = "minibox.helper.built";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

interface Held {
  readonly id: string;
  readonly labels: Record<string, string>;
}

interface Build {
  readonly tag: string;
  readonly labels: Record<string, string>;
  readonly pull?: boolean;
  readonly nocache?: boolean;
}

interface Stub {
  /** The images the engine holds, by the reference a helper names. */
  readonly present: Map<string, Held>;
  buildFails: boolean;
  removeFails: boolean;
  readonly builds: Build[];
  readonly removed: string[];
  readonly started: string[];
}

/**
 * An engine that answers the image calls and stops where a helper would start, so what is observable is which image the
 * helper was asked to run in, how the build was asked for and how often it was tried. The build itself runs on a real
 * engine in CI.
 */
function engineOf(stub: Stub): Engine {
  const docker = {
    getImage: (ref: string) => ({
      inspect: async () => {
        const held = stub.present.get(ref);
        if (!held) throw Object.assign(new Error("No such image"), { statusCode: 404 });
        return { Id: held.id, RepoTags: [ref], Architecture: "amd64", Config: { Labels: held.labels } };
      },
      remove: async () => {
        if (stub.removeFails) throw Object.assign(new Error("image is being used by a container"), { statusCode: 409 });
        stub.removed.push(ref);
      },
    }),
    buildImage: async (
      _context: unknown,
      options: { t: string; labels: Record<string, string>; pull?: boolean; nocache?: boolean },
    ) => {
      stub.builds.push({ tag: options.t, labels: options.labels, pull: options.pull, nocache: options.nocache });
      if (stub.buildFails) throw new Error("could not reach the registry");
      stub.present.set(options.t, { id: `sha256:build-${stub.builds.length}`, labels: options.labels });
      return {};
    },
    pull: async () => {
      stub.present.set(ALPINE, { id: "sha256:alpine", labels: {} });
      return {};
    },
    modem: { followProgress: (_stream: unknown, done: (error: Error | null) => void) => done(null) },
    createContainer: async (options: { Image: string }) => {
      stub.started.push(options.Image);
      throw new Error("the test stops before a helper starts");
    },
  };
  return { docker } as unknown as Engine;
}

const stubOf = (): Stub => ({
  present: new Map(),
  buildFails: false,
  removeFails: false,
  builds: [],
  removed: [],
  started: [],
});

/** The engine already holds the helper image, built at `built` (an ISO time), or with no built label at all. */
function holding(stub: Stub, built: string | undefined, id = "sha256:old"): Stub {
  stub.present.set(BUILT, {
    id,
    labels: { minibox: "true", "minibox.internal": "true", ...(built === undefined ? {} : { [BUILT_LABEL]: built }) },
  });
  return stub;
}

/** The runtime's methods with a clock the test moves, and one pass of the forward check. */
function runtimeOf(stub: Stub, start = Date.UTC(2026, 9, 30, 12, 0)) {
  const clock = { now: start };
  const methods = hostFirewallMethods(engineOf(stub), { now: () => clock.now });
  const pass = (owner = "minibox") =>
    methods.checkHostForward(owner, "br-1a2b3c4d5e6f", "240.0.0.0/24").catch(() => undefined);
  return { clock, methods, pass };
}

const iso = (ms: number) => new Date(ms).toISOString();

describe("the image the forward check's helper runs in", () => {
  test("an engine without it builds it once, and every helper after that runs in it", async () => {
    const stub = stubOf();
    const { pass } = runtimeOf(stub);
    await pass();
    await pass();
    expect(stub.builds).toHaveLength(1);
    expect(stub.started).toEqual([BUILT, BUILT]);
  });

  test("the first build uses the Alpine the engine has, and does not ask for a fresh base", async () => {
    const stub = stubOf();
    await runtimeOf(stub).pass();
    expect(stub.builds[0]?.pull).toBeUndefined();
    expect(stub.builds[0]?.nocache).toBeUndefined();
  });

  test("an engine that already has it builds nothing, so no pass downloads a package", async () => {
    const start = Date.UTC(2026, 9, 30, 12, 0);
    const stub = holding(stubOf(), iso(start - DAY));
    await runtimeOf(stub, start).pass();
    expect(stub.builds).toHaveLength(0);
    expect(stub.started).toEqual([BUILT]);
  });

  test("a build that fails falls back to plain Alpine, and is not tried again within the hour", async () => {
    const stub = stubOf();
    stub.buildFails = true;
    // One set of methods, as a runtime has: the time of the failed build is kept in it.
    const { pass } = runtimeOf(stub);
    for (let attempt = 0; attempt < 3; attempt++) await pass();
    expect(stub.builds).toHaveLength(1);
    expect(stub.started).toEqual([ALPINE, ALPINE, ALPINE]);
  });

  test("a probe and a repair that start together share one build", async () => {
    const stub = stubOf();
    const { methods } = runtimeOf(stub);
    await Promise.allSettled([
      methods.checkHostForward("minibox", "br-1a2b3c4d5e6f", "240.0.0.0/24"),
      methods.allowHostForward("minibox", "br-1a2b3c4d5e6f"),
    ]);
    expect(stub.builds).toHaveLength(1);
    expect(stub.started).toEqual([BUILT, BUILT]);
  });

  test("the image it builds is marked as the install's own and internal, and with the time it was built", async () => {
    const start = Date.UTC(2026, 9, 30, 12, 0);
    const stub = stubOf();
    await runtimeOf(stub, start).pass("MbTest");
    expect(stub.builds[0]?.labels).toEqual({
      MbTest: "true",
      "MbTest.internal": "true",
      "MbTest.helper.built": iso(start),
    });
  });

  test("the name follows the install's label prefix, in lower case", async () => {
    const start = Date.UTC(2026, 9, 30, 12, 0);
    const stub = stubOf();
    stub.present.set("mbtest-host-firewall:alpine3.20", {
      id: "sha256:mbtest",
      labels: { "MbTest.helper.built": iso(start) },
    });
    await runtimeOf(stub, start).pass("MbTest");
    expect(stub.started).toEqual(["mbtest-host-firewall:alpine3.20"]);
  });
});

describe("the image follows Alpine's updates", () => {
  test("an image a week old is built again, from a fresh base and without the cache, and the old one is removed", async () => {
    const start = Date.UTC(2026, 9, 30, 12, 0);
    const stub = holding(stubOf(), iso(start - 8 * DAY));
    await runtimeOf(stub, start).pass();
    expect(stub.builds).toHaveLength(1);
    expect(stub.builds[0]).toMatchObject({ tag: BUILT, pull: true, nocache: true });
    expect(stub.builds[0]?.labels[BUILT_LABEL]).toBe(iso(start));
    expect(stub.removed).toEqual(["sha256:old"]);
    expect(stub.started).toEqual([BUILT]);
  });

  test("an image under a week old is left alone", async () => {
    const start = Date.UTC(2026, 9, 30, 12, 0);
    const stub = holding(stubOf(), iso(start - 6 * DAY));
    await runtimeOf(stub, start).pass();
    expect(stub.builds).toHaveLength(0);
    expect(stub.removed).toEqual([]);
  });

  test("an image gets old while MiniBox runs, and is built again at the first pass after that", async () => {
    const stub = stubOf();
    const { clock, pass } = runtimeOf(stub);
    await pass();
    clock.now += 6 * DAY;
    await pass();
    expect(stub.builds).toHaveLength(1);
    clock.now += 2 * DAY;
    await pass();
    await pass();
    expect(stub.builds).toHaveLength(2);
    expect(stub.builds[1]).toMatchObject({ pull: true, nocache: true });
  });

  test("an image with no built label, such as one made before the label existed, counts as old", async () => {
    const stub = holding(stubOf(), undefined);
    await runtimeOf(stub).pass();
    expect(stub.builds).toHaveLength(1);
    expect(stub.removed).toEqual(["sha256:old"]);
  });

  test("a built time in the future is not trusted", async () => {
    const start = Date.UTC(2026, 9, 30, 12, 0);
    const stub = holding(stubOf(), iso(start + 30 * DAY));
    await runtimeOf(stub, start).pass();
    expect(stub.builds).toHaveLength(1);
  });

  test("a rebuild that fails keeps the old image, and is tried again only after an hour", async () => {
    const start = Date.UTC(2026, 9, 30, 12, 0);
    const stub = holding(stubOf(), iso(start - 8 * DAY));
    stub.buildFails = true;
    const { clock, pass } = runtimeOf(stub, start);
    for (let attempt = 0; attempt < 3; attempt++) await pass();
    expect(stub.builds).toHaveLength(1);
    expect(stub.started).toEqual([BUILT, BUILT, BUILT]);
    expect(stub.removed).toEqual([]);

    clock.now += 61 * MINUTE;
    stub.buildFails = false;
    await pass();
    expect(stub.builds).toHaveLength(2);
    expect(stub.removed).toEqual(["sha256:old"]);
  });

  test("an old image that cannot be removed because a helper still runs in it is no failure", async () => {
    const start = Date.UTC(2026, 9, 30, 12, 0);
    const stub = holding(stubOf(), iso(start - 8 * DAY));
    stub.removeFails = true;
    await runtimeOf(stub, start).pass();
    expect(stub.builds).toHaveLength(1);
    expect(stub.started).toEqual([BUILT]);
  });
});
