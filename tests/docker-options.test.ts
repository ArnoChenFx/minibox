import { describe, expect, test } from "bun:test";

import type Docker from "dockerode";

import { toContainerInfo, toCreateOptions, toHelperOptions } from "../src/docker/runtime";
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

  test("a user is sent as User, and an absent user keeps the image's", () => {
    expect(toCreateOptions({ ...base, user: "0:0" })).toEqual({ Image: "img:1", User: "0:0" });
    expect(toCreateOptions(base)).toEqual({ Image: "img:1" });
  });

  test("noCopy volume mounts use Mounts with NoCopy, plus readonly root and tmpfs", () => {
    const options = toCreateOptions({
      ...base,
      mounts: [{ source: "vol", target: "/minibox-volume", noCopy: true }],
      network: "none",
      memoryBytes: 256 * 1024 * 1024,
      swapBytes: 256 * 1024 * 1024,
      readonlyRootfs: true,
      tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16m" },
      hardening: { capDrop: ["ALL"], noNewPrivileges: true, pidsLimit: 64 },
    });
    expect(options.HostConfig).toMatchObject({
      Mounts: [{ Type: "volume", Source: "vol", Target: "/minibox-volume", VolumeOptions: { NoCopy: true } }],
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16m" },
      Memory: 256 * 1024 * 1024,
      CapDrop: ["ALL"],
      PidsLimit: 64,
    });
    expect(options.HostConfig?.Binds).toBeUndefined();
  });
});

describe("toHelperOptions", () => {
  test("a helper joins no network, has a read-only root and a small /tmp, and gets only the capabilities it names", () => {
    const options = toHelperOptions(
      {
        image: "img:1",
        cmd: ["chown", "1000:1000", "/mnt"],
        user: "0:0",
        capAdd: ["CHOWN"],
        mounts: [{ source: "vol", target: "/mnt" }],
        labels: { "mb.internal": "true" },
      },
      "mbxhlp00000001",
    );
    expect(options).toMatchObject({
      Image: "img:1",
      name: "mbxhlp00000001",
      Cmd: ["chown", "1000:1000", "/mnt"],
      User: "0:0",
      Labels: { "mb.internal": "true" },
      HostConfig: {
        Mounts: [{ Type: "volume", Source: "vol", Target: "/mnt", VolumeOptions: { NoCopy: true } }],
        NetworkMode: "none",
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16m" },
        Memory: 256 * 1024 * 1024,
        MemorySwap: 256 * 1024 * 1024,
        AutoRemove: true,
        CapDrop: ["ALL"],
        CapAdd: ["CHOWN"],
        SecurityOpt: ["no-new-privileges:true"],
        PidsLimit: 64,
      },
    });
    expect(options.HostConfig).not.toHaveProperty("Binds");
  });

  test("a helper that names no user or capability keeps the image user and gets none", () => {
    const options = toHelperOptions({ image: "img:1", cmd: ["true"] }, "mbxhlp00000002");
    expect(options).not.toHaveProperty("User");
    expect(options).not.toHaveProperty("Labels");
    expect(options.HostConfig).not.toHaveProperty("CapAdd");
    expect(options.HostConfig).toMatchObject({ CapDrop: ["ALL"], NetworkMode: "none", AutoRemove: true });
  });

  test("a helper starts in / whatever working directory its image sets", () => {
    const options = toHelperOptions(
      { image: "img:1", cmd: ["true"], mounts: [{ source: "/srv/pool", target: "/home/dev", kind: "bind" }] },
      "mbxhlp00000006",
    );
    expect(options).toMatchObject({ WorkingDir: "/" });
  });

  test("a tools writer may join the bridge, write the root filesystem, and carry proxy env", () => {
    const options = toHelperOptions(
      {
        image: "img:1",
        cmd: ["npm", "install"],
        user: "1000:1000",
        network: true,
        readonlyRoot: false,
        memoryBytes: 1024 * 1024 * 1024,
        pidsLimit: 256,
        env: ["HTTP_PROXY=http://proxy:8080", "PATH=/opt/minibox/tools/bin"],
        mounts: [{ source: "tools", target: "/opt/minibox/tools", mode: "rw" }],
      },
      "mbxhlp00000004",
    );
    expect(options).toMatchObject({
      User: "1000:1000",
      Env: ["HTTP_PROXY=http://proxy:8080", "PATH=/opt/minibox/tools/bin"],
      HostConfig: {
        NetworkMode: "bridge",
        ReadonlyRootfs: false,
        Memory: 1024 * 1024 * 1024,
        PidsLimit: 256,
      },
    });
    expect(options.HostConfig).not.toHaveProperty("Tmpfs");
  });

  test("a read-only host path is a read-only bind and is not NoCopy", () => {
    const options = toHelperOptions(
      { image: "img:1", cmd: ["true"], mounts: [{ source: "/srv/pool", target: "/mnt", kind: "bind", mode: "ro" }] },
      "mbxhlp00000003",
    );
    expect(options.HostConfig?.Mounts).toEqual([{ Type: "bind", Source: "/srv/pool", Target: "/mnt", ReadOnly: true }]);
  });

  test("a helper's /tmp size can be set in bytes, and only a read-only root has a /tmp tmpfs", () => {
    const sized = toHelperOptions({ image: "img:1", cmd: ["true"], tmpfsBytes: 64 * 1024 * 1024 }, "mbxhlp00000004");
    expect(sized.HostConfig?.Tmpfs).toEqual({ "/tmp": "rw,noexec,nosuid,nodev,size=67108864" });
    const writable = toHelperOptions(
      { image: "img:1", cmd: ["true"], readonlyRoot: false, tmpfsBytes: 64 * 1024 * 1024 },
      "mbxhlp00000005",
    );
    expect(writable.HostConfig?.Tmpfs).toBeUndefined();
    expect(writable.HostConfig?.ReadonlyRootfs).toBe(false);
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
