import { describe, expect, test } from "bun:test";

import { boxesOnHost, hostOfBox, isUnreachable } from "../web/js/lib/host-list.js";

const boxes = [
  { name: "alpha", hostId: "local", state: "running" },
  { name: "beta", hostId: "lab", state: "running" },
  { name: "gamma", hostId: "lab", state: "unreachable" },
  { name: "delta", state: "exited" },
];

describe("host filter and host state in the console", () => {
  test("a box that names no host is on the local host", () => {
    expect(hostOfBox({ name: "delta" })).toBe("local");
    expect(hostOfBox({ name: "beta", hostId: "lab" })).toBe("lab");
  });

  test("an empty filter lists every box, and a host filter lists only its own", () => {
    expect(boxesOnHost(boxes, "").map((b) => b.name)).toEqual(["alpha", "beta", "gamma", "delta"]);
    expect(boxesOnHost(boxes, "lab").map((b) => b.name)).toEqual(["beta", "gamma"]);
    expect(boxesOnHost(boxes, "local").map((b) => b.name)).toEqual(["alpha", "delta"]);
    expect(boxesOnHost(boxes, "missing")).toEqual([]);
  });

  test("a box the control plane lists as unreachable is the only one greyed out", () => {
    expect(boxes.filter(isUnreachable).map((b) => b.name)).toEqual(["gamma"]);
  });
});
