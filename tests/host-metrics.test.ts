import { describe, expect, test } from "bun:test";

import { assembleDisks, runsInContainer } from "../src/host/metrics";

const system = { mount: "/", total: 100, used: 40, free: 60 };
const dockerRoot = { mount: "/var/lib/docker", total: 500, used: 250, free: 250 };
const sameDisk = { ...dockerRoot, mount: "/var/lib/docker", total: system.total };

describe("runsInContainer", () => {
  test("recognises the marker files Docker and Podman create", () => {
    expect(runsInContainer((path) => path === "/.dockerenv")).toBe(true);
    expect(runsInContainer((path) => path === "/run/.containerenv")).toBe(true);
  });

  test("is false when neither marker exists", () => {
    expect(runsInContainer(() => false)).toBe(false);
  });
});

describe("assembleDisks on a host", () => {
  test("lists the system disk and a separate Docker data disk", () => {
    expect(assembleDisks(system, dockerRoot, false)).toEqual([
      { ...system, label: "root" },
      { ...dockerRoot, label: "docker" },
    ]);
  });

  test("merges them when Docker data sits on the system disk", () => {
    expect(assembleDisks(system, sameDisk, false)).toEqual([{ ...system, label: "root+docker" }]);
  });

  test("shows only the system disk when the Docker root cannot be read", () => {
    expect(assembleDisks(system, null, false)).toEqual([{ ...system, label: "root" }]);
  });
});

describe("assembleDisks inside a container", () => {
  test("labels the container's own filesystem as container, not as the system disk", () => {
    expect(assembleDisks(system, null, true)).toEqual([{ ...system, label: "container" }]);
  });

  test("keeps the Docker data disk apart from the container filesystem", () => {
    expect(assembleDisks(system, dockerRoot, true)).toEqual([
      { ...system, label: "container" },
      { ...dockerRoot, label: "docker" },
    ]);
  });

  test("merges them when the Docker root is on the same filesystem", () => {
    expect(assembleDisks(system, sameDisk, true)).toEqual([{ ...system, label: "container+docker" }]);
  });
});

describe("assembleDisks without a readable root", () => {
  test("falls back to the Docker data disk alone", () => {
    expect(assembleDisks(null, dockerRoot, false)).toEqual([{ ...dockerRoot, label: "docker" }]);
  });

  test("reports no disk when nothing can be read", () => {
    expect(assembleDisks(null, null, true)).toEqual([]);
  });
});
