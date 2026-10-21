import { describe, expect, test } from "bun:test";

import type Docker from "dockerode";

import { toContainerInfo, toCreateOptions } from "../src/docker/runtime";
import type { CreateContainerSpec } from "../src/runtime";

const base: CreateContainerSpec = { image: "img:1" };

describe("toCreateOptions", () => {
  test("a read-only bind and a user are passed through", () => {
    expect(
      toCreateOptions({
        ...base,
        user: "0:0",
        mounts: [
          { source: "/data", target: "/mnt", kind: "bind", mode: "ro" },
          { source: "vol", target: "/workspace" },
        ],
      }),
    ).toEqual({
      Image: "img:1",
      User: "0:0",
      HostConfig: { Binds: ["/data:/mnt:ro", "vol:/workspace"] },
    });
  });

  test("sends no HostConfig when nothing is set", () => {
    expect(toCreateOptions(base)).toEqual({ Image: "img:1" });
  });

  test("env is passed through and a read-only mount appends :ro", () => {
    expect(
      toCreateOptions({
        ...base,
        env: ["FOO=bar"],
        mounts: [
          { source: "vol", target: "/data", mode: "ro" },
          { source: "ws", target: "/workspace", mode: "rw" },
        ],
      }),
    ).toEqual({
      Image: "img:1",
      Env: ["FOO=bar"],
      HostConfig: { Binds: ["vol:/data:ro", "ws:/workspace"] },
    });
  });

  test("a network becomes NetworkMode", () => {
    expect(toCreateOptions({ ...base, network: "minibox-boxes" })).toEqual({
      Image: "img:1",
      HostConfig: { NetworkMode: "minibox-boxes" },
    });
  });

  test("hardening maps onto the matching HostConfig keys", () => {
    const options = toCreateOptions({
      ...base,
      hardening: {
        capDrop: ["ALL"],
        capAdd: ["CHOWN", "SETUID"],
        pidsLimit: 1024,
        ulimits: [{ name: "nofile", soft: 65536, hard: 65536 }],
        runtime: "runsc",
      },
    });
    expect(options.HostConfig).toEqual({
      CapDrop: ["ALL"],
      CapAdd: ["CHOWN", "SETUID"],
      PidsLimit: 1024,
      Ulimits: [{ Name: "nofile", Soft: 65536, Hard: 65536 }],
      Runtime: "runsc",
    });
  });

  test("no-new-privileges is a security option, and turning it off leaves nothing behind", () => {
    expect(toCreateOptions({ ...base, hardening: { noNewPrivileges: true } }).HostConfig).toEqual({
      SecurityOpt: ["no-new-privileges:true"],
    });
    expect(toCreateOptions({ ...base, hardening: { noNewPrivileges: false } })).toEqual({ Image: "img:1" });
  });

  test("empty capability lists and absent limits are not sent", () => {
    const options = toCreateOptions({ ...base, hardening: { capDrop: [], capAdd: [], ulimits: [] } });
    expect(options).toEqual({ Image: "img:1" });
  });

  test("a zero process limit is still sent, so it cannot be mistaken for no limit", () => {
    expect(toCreateOptions({ ...base, hardening: { pidsLimit: 0 } }).HostConfig).toEqual({ PidsLimit: 0 });
  });
});

const inspect = (networkMode: string | undefined) =>
  ({
    Id: "abc",
    Name: "/box",
    Created: "2026-10-20T00:00:00Z",
    Config: { Image: "img:1", Labels: {} },
    State: { Status: "created", Running: false, StartedAt: "0001-01-01T00:00:00Z" },
    HostConfig: networkMode === undefined ? undefined : { NetworkMode: networkMode },
  }) as unknown as Docker.ContainerInspectInfo;

describe("toContainerInfo", () => {
  test("reports the network the container is attached to", () => {
    expect(toContainerInfo(inspect("minibox-boxes")).network).toBe("minibox-boxes");
    expect(toContainerInfo(inspect("bridge")).network).toBe("bridge");
  });

  test("the default network alias and a missing host config both mean the default bridge", () => {
    expect(toContainerInfo(inspect("default")).network).toBe("bridge");
    expect(toContainerInfo(inspect(undefined)).network).toBe("bridge");
  });
});
