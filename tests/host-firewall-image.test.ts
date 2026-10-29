import { describe, expect, test } from "bun:test";

import type { Engine } from "../src/docker/engine";
import { hostFirewallMethods } from "../src/docker/host-firewall";

const ALPINE = "alpine:3.20";
const BUILT = "minibox-host-firewall:alpine3.20";

interface Stub {
  readonly present: Set<string>;
  buildFails: boolean;
  builds: number;
  started: string[];
}

/**
 * An engine that answers the image calls and stops where a helper would start, so what is observable is which image the
 * helper was asked to run in and how often the build was tried. The build itself runs on a real engine in CI.
 */
function engineOf(stub: Stub): Engine {
  const docker = {
    getImage: (ref: string) => ({
      inspect: async () => {
        if (!stub.present.has(ref)) throw Object.assign(new Error("No such image"), { statusCode: 404 });
        return { Id: `sha256:${ref}`, RepoTags: [ref], Architecture: "amd64", Config: {} };
      },
    }),
    buildImage: async (_context: unknown, options: { t: string }) => {
      stub.builds += 1;
      if (stub.buildFails) throw new Error("could not reach the registry");
      stub.present.add(options.t);
      return {};
    },
    pull: async () => {
      stub.present.add(ALPINE);
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

const stubOf = (present: string[] = []): Stub => ({
  present: new Set(present),
  buildFails: false,
  builds: 0,
  started: [],
});

const probe = (engine: Engine, owner = "minibox") =>
  hostFirewallMethods(engine)
    .checkHostForward(owner, "br-1a2b3c4d5e6f", "240.0.0.0/24")
    .catch(() => undefined);

describe("the image the forward check's helper runs in", () => {
  test("an engine without it builds it once, and every helper after that runs in it", async () => {
    const stub = stubOf();
    const methods = hostFirewallMethods(engineOf(stub));
    await methods.checkHostForward("minibox", "br-1a2b3c4d5e6f", "240.0.0.0/24").catch(() => undefined);
    await methods.checkHostForward("minibox", "br-1a2b3c4d5e6f", "240.0.0.0/24").catch(() => undefined);
    expect(stub.builds).toBe(1);
    expect(stub.started).toEqual([BUILT, BUILT]);
  });

  test("an engine that already has it builds nothing, so no pass downloads a package", async () => {
    const stub = stubOf([BUILT]);
    await probe(engineOf(stub));
    expect(stub.builds).toBe(0);
    expect(stub.started).toEqual([BUILT]);
  });

  test("a build that fails falls back to plain Alpine, and is not tried again within the hour", async () => {
    const stub = stubOf();
    stub.buildFails = true;
    // One set of methods, as a runtime has: the time of the failed build is kept in it.
    const methods = hostFirewallMethods(engineOf(stub));
    for (let pass = 0; pass < 3; pass++) {
      await methods.checkHostForward("minibox", "br-1a2b3c4d5e6f", "240.0.0.0/24").catch(() => undefined);
    }
    expect(stub.builds).toBe(1);
    expect(stub.started).toEqual([ALPINE, ALPINE, ALPINE]);
  });

  test("a probe and a repair that start together share one build", async () => {
    const stub = stubOf();
    const methods = hostFirewallMethods(engineOf(stub));
    await Promise.allSettled([
      methods.checkHostForward("minibox", "br-1a2b3c4d5e6f", "240.0.0.0/24"),
      methods.allowHostForward("minibox", "br-1a2b3c4d5e6f"),
    ]);
    expect(stub.builds).toBe(1);
    expect(stub.started).toEqual([BUILT, BUILT]);
  });

  test("the name follows the install's label prefix, in lower case", async () => {
    const stub = stubOf(["mbtest-host-firewall:alpine3.20"]);
    await probe(engineOf(stub), "MbTest");
    expect(stub.started).toEqual(["mbtest-host-firewall:alpine3.20"]);
  });
});
