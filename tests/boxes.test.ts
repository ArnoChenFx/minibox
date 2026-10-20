import { describe, expect, test } from "bun:test";

import type Docker from "dockerode";

import { createBox, getBox } from "../src/docker/boxes";
import type { DockerCtx } from "../src/docker/client";
import { labelKeys } from "../src/labels";
import { setLogLevel } from "../src/lib/logger";

setLogLevel("error");

const ICC = "com.docker.network.bridge.enable_icc";

interface StoredContainer {
  Id: string;
  Name: string;
  Created: string;
  Config: { Image: string; Labels: Record<string, string> };
  HostConfig: Docker.HostConfig;
  State: { Status: string; Running: boolean; StartedAt: string };
}

interface CreatedContainer {
  Labels: Record<string, string>;
  HostConfig: Docker.HostConfig;
}

function httpError(statusCode: number): Error {
  return Object.assign(new Error(`status ${statusCode}`), { statusCode });
}

/** Records the Docker API calls box creation makes, so tests can assert what the daemon would receive. */
class FakeDocker {
  readonly images = new Set(["minibox-template:base"]);
  readonly volumes = new Set<string>();
  readonly networks = new Map<string, { Name: string; Options: Record<string, string> }>();
  readonly containers = new Map<string, StoredContainer>();
  readonly networkCreates: Docker.NetworkCreateOptions[] = [];
  readonly containerCreates: CreatedContainer[] = [];
  createNetworkError: Error | null = null;
  private seq = 0;

  getImage(ref: string) {
    return {
      inspect: async () => {
        if (!this.images.has(ref)) throw httpError(404);
        return { Config: { Labels: {} } };
      },
    };
  }

  getVolume(name: string) {
    return {
      inspect: async () => {
        if (!this.volumes.has(name)) throw httpError(404);
        return {};
      },
    };
  }

  async createVolume(opts: { Name: string }) {
    this.volumes.add(opts.Name);
    return {};
  }

  getNetwork(name: string) {
    return {
      inspect: async () => {
        const network = this.networks.get(name);
        if (!network) throw httpError(404);
        return network;
      },
    };
  }

  async createNetwork(opts: Docker.NetworkCreateOptions) {
    this.networkCreates.push(opts);
    if (this.createNetworkError) {
      const err = this.createNetworkError;
      this.createNetworkError = null;
      throw err;
    }
    this.networks.set(opts.Name, { Name: opts.Name, Options: opts.Options ?? {} });
    return {};
  }

  async listContainers() {
    return [...this.containers.values()].map((c) => ({ Id: c.Id }));
  }

  getContainer(id: string) {
    return {
      inspect: async () => {
        const c = this.containers.get(id);
        if (!c) throw httpError(404);
        return c;
      },
      start: async () => {},
    };
  }

  async createContainer(opts: {
    name: string;
    Image: string;
    Labels: Record<string, string>;
    HostConfig: Docker.HostConfig;
  }) {
    this.containerCreates.push({ Labels: opts.Labels, HostConfig: opts.HostConfig });
    const id = `container-${++this.seq}`;
    this.containers.set(id, {
      Id: id,
      Name: `/${opts.name}`,
      Created: new Date().toISOString(),
      Config: { Image: opts.Image, Labels: opts.Labels },
      HostConfig: opts.HostConfig,
      State: { Status: "created", Running: false, StartedAt: "0001-01-01T00:00:00Z" },
    });
    return { id, start: async () => {} };
  }
}

function ctxFor(fake: FakeDocker, hardening: Partial<DockerCtx["hardening"]> = {}): DockerCtx {
  return {
    docker: fake as unknown as Docker,
    keys: labelKeys("minibox"),
    prefix: "minibox",
    baseTemplateTag: "minibox-template:base",
    templatesDir: "templates",
    hardening: { defaultProfile: "standard", pidsLimit: 1024, runtime: null, ...hardening },
    boxNetwork: "minibox-boxes",
  };
}

function lastCreate(fake: FakeDocker): CreatedContainer {
  const created = fake.containerCreates.at(-1);
  if (!created) throw new Error("no container was created");
  return created;
}

const input = { name: "dev", cpus: 2, memoryMb: 4096 };

describe("createBox hardening", () => {
  test("uses the standard profile by default and records it on the box", async () => {
    const fake = new FakeDocker();
    const box = await createBox(ctxFor(fake), input);
    expect(box.profile).toBe("standard");
    const { Labels, HostConfig } = lastCreate(fake);
    expect(Labels).toMatchObject({ minibox: "true", "minibox.name": "dev", "minibox.profile": "standard" });
    expect(HostConfig).toMatchObject({
      CapDrop: ["ALL"],
      PidsLimit: 1024,
      NetworkMode: "minibox-boxes",
      Init: true,
      NanoCpus: 2e9,
      Memory: 4096 * 1024 * 1024,
      Privileged: false,
    });
    expect(HostConfig.SecurityOpt).toBeUndefined();
  });

  test("an explicit profile overrides the configured default", async () => {
    const fake = new FakeDocker();
    const box = await createBox(ctxFor(fake), { ...input, profile: "strict" });
    expect(box.profile).toBe("strict");
    expect(lastCreate(fake).HostConfig).toMatchObject({ CapAdd: [], SecurityOpt: ["no-new-privileges"] });
  });

  test("relaxed keeps Docker's default capabilities", async () => {
    const fake = new FakeDocker();
    await createBox(ctxFor(fake), { ...input, profile: "relaxed" });
    const { HostConfig } = lastCreate(fake);
    expect(HostConfig.CapDrop).toBeUndefined();
    expect(HostConfig.PidsLimit).toBe(1024);
  });

  test("a configured container runtime is set on the container", async () => {
    const fake = new FakeDocker();
    await createBox(ctxFor(fake, { runtime: "runsc" }), input);
    expect(lastCreate(fake).HostConfig.Runtime).toBe("runsc");
  });

  test("the shared network is created once, with inter-container traffic disabled", async () => {
    const fake = new FakeDocker();
    const ctx = ctxFor(fake);
    await createBox(ctx, input);
    await createBox(ctx, { ...input, name: "second" });
    expect(fake.networkCreates).toHaveLength(1);
    expect(fake.networkCreates[0]).toMatchObject({
      Name: "minibox-boxes",
      Driver: "bridge",
      Options: { [ICC]: "false" },
    });
  });

  test("an existing network is reused as is", async () => {
    const fake = new FakeDocker();
    fake.networks.set("minibox-boxes", { Name: "minibox-boxes", Options: { [ICC]: "false" } });
    await createBox(ctxFor(fake), input);
    expect(fake.networkCreates).toHaveLength(0);
  });

  test("a network created concurrently by someone else is accepted", async () => {
    const fake = new FakeDocker();
    fake.createNetworkError = httpError(409);
    const box = await createBox(ctxFor(fake), input);
    expect(box.name).toBe("dev");
    expect(lastCreate(fake).HostConfig.NetworkMode).toBe("minibox-boxes");
  });

  test("other errors creating the network stop box creation", async () => {
    const fake = new FakeDocker();
    fake.createNetworkError = httpError(500);
    await expect(createBox(ctxFor(fake), input)).rejects.toThrow("status 500");
    expect(fake.containerCreates).toHaveLength(0);
  });

  test("boxes created before profiles existed report no profile and are left alone", async () => {
    const fake = new FakeDocker();
    fake.containers.set("legacy", {
      Id: "legacy",
      Name: "/minibox-old",
      Created: new Date().toISOString(),
      Config: { Image: "minibox-template:base", Labels: { minibox: "true", "minibox.name": "old" } },
      HostConfig: {},
      State: { Status: "running", Running: true, StartedAt: "2026-01-01T00:00:00Z" },
    });
    const box = await getBox(ctxFor(fake), "legacy");
    expect(box.profile).toBeNull();
    expect(box.name).toBe("old");
  });
});
