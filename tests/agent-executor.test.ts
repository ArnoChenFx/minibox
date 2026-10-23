import { describe, expect, test } from "bun:test";

import { AGENT_ALLOWED_CAPS, AgentExecutor, type AgentSink } from "../src/agent/executor";
import type { AgentErrorInfo, ExecExit } from "../src/agent/protocol";
import { STANDARD_CAPS } from "../src/box-profile";
import { RuntimeError } from "../src/runtime";
import { FakeRuntime } from "./support/fake-runtime";

type Frame =
  | { type: "response"; id: string; ok: boolean; result?: unknown; error?: AgentErrorInfo }
  | { type: "item"; id: string; value: unknown }
  | { type: "data"; id: string; channel: "stdout" | "stderr"; text: string }
  | { type: "end"; id: string; error?: AgentErrorInfo; exit?: ExecExit };

function recorder() {
  const frames: Frame[] = [];
  const sink: AgentSink = {
    respond: (id, outcome) => frames.push({ type: "response", id, ...outcome } as Frame),
    item: (id, value) => frames.push({ type: "item", id, value }),
    data: (id, channel, bytes) => frames.push({ type: "data", id, channel, text: Buffer.from(bytes).toString() }),
    end: (id, error, exit) => frames.push({ type: "end", id, error, exit }),
  };
  return { sink, frames };
}

function responseTo(frames: Frame[], id: string): Extract<Frame, { type: "response" }> {
  const found = frames.find((frame): frame is Extract<Frame, { type: "response" }> => {
    return frame.type === "response" && frame.id === id;
  });
  if (!found) throw new Error(`no response to ${id}`);
  return found;
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(2);
  }
}

function setup() {
  const runtime = new FakeRuntime();
  const { sink, frames } = recorder();
  const executor = new AgentExecutor(runtime, sink);
  return { runtime, frames, executor };
}

describe("requests the agent runs", () => {
  test("a listed operation runs against the runtime and its result is sent back", async () => {
    const { executor, frames, runtime } = setup();
    await executor.request("r1", "ping", {});
    expect(responseTo(frames, "r1")).toMatchObject({ ok: true, result: {} });
    expect(runtime.ops()).toEqual(["ping"]);
  });

  test("a container listing passes its label filter through", async () => {
    const { executor, frames, runtime } = setup();
    runtime.seedContainer({ image: "alpine:3.20", name: "one", running: true, labels: { "mbtest.box": "true" } });
    await executor.request("r2", "listContainers", { labels: { "mbtest.box": "true" } });
    expect(responseTo(frames, "r2")).toMatchObject({ ok: true });
    expect((responseTo(frames, "r2") as { result: unknown[] }).result).toHaveLength(1);
  });

  test("an engine error keeps its kind and message", async () => {
    const { executor, frames, runtime } = setup();
    runtime.fail("inspectContainer", new RuntimeError("not_found", "no such box", "bx_missing"));
    await executor.request("r3", "inspectContainer", { id: "bx_missing" });
    expect(responseTo(frames, "r3")).toMatchObject({
      ok: false,
      error: { kind: "not_found", message: "no such box", detail: "bx_missing" },
    });
  });

  test("an operation outside the allowlist is refused as unsupported and never reaches the runtime", async () => {
    const { executor, frames, runtime } = setup();
    await executor.request("r4", "saveImage", { ref: "alpine:3.20" });
    expect(responseTo(frames, "r4")).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(runtime.ops()).not.toContain("saveImage");
  });

  test("an operation that is not in the protocol at all is refused as invalid", async () => {
    const { executor, frames, runtime } = setup();
    await executor.request("r5", "shell", { command: "cat /etc/shadow" });
    expect(responseTo(frames, "r5")).toMatchObject({
      ok: false,
      error: { kind: "invalid", message: "unknown operation shell" },
    });
    expect(runtime.ops()).toEqual([]);
  });

  test("arguments are checked before the runtime runs, and unknown keys are refused", async () => {
    const { executor, frames, runtime } = setup();
    await executor.request("r6", "inspectContainer", { id: "../etc", extra: true });
    expect(responseTo(frames, "r6")).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(runtime.ops()).toEqual([]);
  });

  test("a bind mount is refused, because an agent creates only named volumes", async () => {
    const { executor, frames, runtime } = setup();
    const spec = { image: "alpine:3.20", mounts: [{ source: "/etc", target: "/host-etc" }] };
    await executor.request("r7", "createContainer", { spec });
    expect(responseTo(frames, "r7")).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(runtime.ops()).toEqual([]);
  });

  test("a capability outside Docker's default set is refused, so a console cannot widen a container", async () => {
    const { executor, frames, runtime } = setup();
    for (const [id, cap] of [
      ["rc1", "SYS_ADMIN"],
      ["rc2", "SYS_MODULE"],
      ["rc3", "DAC_READ_SEARCH"],
      ["rc4", "ALL"],
    ] as const) {
      const spec = { image: "alpine:3.20", hardening: { capDrop: ["ALL"], capAdd: ["CHOWN", cap] } };
      await executor.request(id, "createContainer", { spec });
      expect(responseTo(frames, id)).toMatchObject({ ok: false, error: { kind: "invalid" } });
    }
    expect(runtime.ops()).toEqual([]);
  });

  test("the standard profile's capabilities are accepted", async () => {
    const { executor, frames, runtime } = setup();
    runtime.seedImage("alpine:3.20");
    const capAdd = [...STANDARD_CAPS];
    expect(capAdd.every((cap) => (AGENT_ALLOWED_CAPS as readonly string[]).includes(cap))).toBe(true);
    const spec = { image: "alpine:3.20", hardening: { capDrop: ["ALL"], capAdd } };
    await executor.request("rc5", "createContainer", { spec });
    expect(responseTo(frames, "rc5")).toMatchObject({ ok: true });
    expect(runtime.ops()).toContain("createContainer");
  });

  test("a container on the host network is refused", async () => {
    const { executor, frames, runtime } = setup();
    await executor.request("r8", "createContainer", { spec: { image: "alpine:3.20", network: "host" } });
    expect(responseTo(frames, "r8")).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(runtime.ops()).toEqual([]);
  });

  test("a request id that is still in flight is refused, and the operation runs once", async () => {
    const { executor, frames, runtime } = setup();
    const held = runtime.hold("listContainers");
    const first = executor.request("r9", "listContainers", { labels: {} });
    await executor.request("r9", "listContainers", { labels: {} });
    expect(frames.filter((frame) => frame.type === "response" && frame.id === "r9")).toHaveLength(1);
    expect(frames).toEqual([
      {
        type: "response",
        id: "r9",
        ok: false,
        error: { kind: "invalid", message: "request id is in use", detail: "r9" },
      },
    ]);
    held.release();
    await first;
    expect(runtime.ops().filter((op) => op === "listContainers")).toHaveLength(1);
  });
});

describe("exec", () => {
  test("a command exec sends its output on each channel and then its exit state", async () => {
    const { executor, frames, runtime } = setup();
    const containerId = runtime.seedContainer({ image: "alpine:3.20", name: "box", running: true });
    runtime.execScript = { stdout: "hello\n", stderr: "warn\n", code: 3 };
    await executor.request("x1", "startExec", {
      containerId,
      spec: { cmd: ["sh", "-c", "echo"], env: [], workingDir: "/", tty: false },
    });
    expect(responseTo(frames, "x1")).toMatchObject({ ok: true, result: { execId: expect.any(String) } });
    await until(() => frames.some((frame) => frame.type === "end" && frame.id === "x1"));
    const output = frames.filter((frame) => frame.type === "data" && frame.id === "x1");
    expect(output).toEqual(
      expect.arrayContaining([
        { type: "data", id: "x1", channel: "stdout", text: "hello\n" },
        { type: "data", id: "x1", channel: "stderr", text: "warn\n" },
      ]),
    );
    const end = frames.find((frame) => frame.type === "end" && frame.id === "x1");
    expect(end).toMatchObject({ exit: { running: false, exitCode: 3 } });
  });

  test("a session call on an exec that has ended answers not_found", async () => {
    const { executor, frames } = setup();
    await executor.request("x2", "execInspect", { session: "no-such-session" });
    expect(responseTo(frames, "x2")).toMatchObject({ ok: false, error: { kind: "not_found" } });
  });

  test("closing the executor detaches an open exec and sends no end for it", async () => {
    const { executor, frames, runtime } = setup();
    const containerId = runtime.seedContainer({ image: "alpine:3.20", name: "shell", running: true });
    await executor.request("x3", "startExec", { containerId, spec: { cmd: ["sh"], env: [], workingDir: "/" } });
    const opened = responseTo(frames, "x3").result as { execId: string };
    executor.close();
    await Bun.sleep(10);
    expect(frames.some((frame) => frame.type === "end" && frame.id === "x3")).toBe(false);
    expect(opened.execId).toBeString();
  });
});

describe("streams", () => {
  test("an events stream sends each event as an item, and cancelling it ends the stream", async () => {
    const { executor, frames, runtime } = setup();
    await executor.request("e1", "events", { filter: {} });
    expect(responseTo(frames, "e1")).toMatchObject({ ok: true });
    await Bun.sleep(5);
    const event = {
      type: "container",
      action: "start",
      id: "c1",
      attributes: {},
      time: "2026-10-22T00:00:00.000Z",
      timeNano: 1,
    };
    runtime.emitEvent(event);
    await until(() => frames.some((frame) => frame.type === "item" && frame.id === "e1"));
    expect(frames.find((frame) => frame.type === "item")).toEqual({ type: "item", id: "e1", value: event });
    executor.cancel("e1");
    await until(() => frames.some((frame) => frame.type === "end" && frame.id === "e1"));
    expect(frames.find((frame) => frame.type === "end" && frame.id === "e1")).toMatchObject({ error: undefined });
  });
});

describe("volumes", () => {
  test("setting a volume's root owner passes the owner through to the runtime", async () => {
    const { executor, frames, runtime } = setup();
    runtime.seedImage("alpine:3.20");
    await executor.request("v1", "createVolume", { name: "data", labels: {} });
    await executor.request("v2", "setVolumeRootOwner", {
      volume: "data",
      owner: { uid: 1000, gid: 1000 },
      image: "alpine:3.20",
    });
    expect(responseTo(frames, "v2")).toMatchObject({ ok: true });
    expect(runtime.volumeOwners.get("data")).toEqual({ uid: 1000, gid: 1000 });
  });
});

describe("networks", () => {
  test("an internal bridge with a subnet is created as the caller asked", async () => {
    const { executor, frames, runtime } = setup();
    await executor.request("n1", "ensureBridgeNetwork", {
      name: "mbx-egress-a",
      opts: { interContainerComm: true, internal: true, subnet: "240.0.8.0/28" },
    });
    expect(responseTo(frames, "n1")).toMatchObject({ ok: true });
    expect(runtime.networks.get("mbx-egress-a")).toMatchObject({ internal: true, subnets: ["240.0.8.0/28"] });
  });

  test("a subnet that is not an IPv4 CIDR is refused before the runtime runs", async () => {
    const { executor, frames, runtime } = setup();
    await executor.request("n2", "ensureBridgeNetwork", {
      name: "mbx-egress-a",
      opts: { interContainerComm: true, subnet: "240.0.8.0/33" },
    });
    expect(responseTo(frames, "n2")).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(runtime.ops()).toEqual([]);
  });

  test("a host firewall source list that is not a list of IPv4 CIDRs is refused before the runtime runs", async () => {
    const { executor, frames, runtime } = setup();
    await executor.request("n3", "setHostIngressBlock", { owner: "mbx", sources: ["240.0.0.0/12", "not-a-network"] });
    expect(responseTo(frames, "n3")).toMatchObject({ ok: false, error: { kind: "invalid" } });
    await executor.request("n4", "setHostIngressBlock", {
      owner: "mbx",
      sources: Array.from({ length: 4097 }, () => "240.0.0.0/12"),
    });
    expect(responseTo(frames, "n4")).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(runtime.ops()).toEqual([]);
  });

  test("a host firewall source outside the egress pool must be the subnet of a network on the engine", async () => {
    const { executor, frames, runtime } = setup();
    runtime.seedNetwork("mbx-boxes");
    const boxes = runtime.networks.get("mbx-boxes");
    if (boxes) boxes.subnets = ["172.30.0.0/16"];
    const many = Array.from({ length: 64 }, (_, i) => `240.0.${i + 1}.0/28`);
    await executor.request("f1", "setHostIngressBlock", { owner: "mbx", sources: [...many, "172.30.0.0/16"] });
    expect(responseTo(frames, "f1")).toMatchObject({ ok: true });
    expect(runtime.hostIngressBlock).toEqual([...many, "172.30.0.0/16"]);
    expect(runtime.hostIngressOwner).toBe("mbx");

    for (const [id, source] of [
      ["f2", "0.0.0.0/0"],
      ["f3", "240.0.0.0/8"],
      ["f4", "172.30.0.0/15"],
    ] as const) {
      await executor.request(id, "setHostIngressBlock", { owner: "mbx", sources: ["240.0.1.0/28", source] });
      expect(responseTo(frames, id)).toMatchObject({ ok: false, error: { kind: "invalid" } });
    }
    expect(runtime.hostIngressBlock).toEqual([...many, "172.30.0.0/16"]);
  });

  test("a container is connected to a second network with its alias, and listed networks come back with their subnets", async () => {
    const { executor, frames, runtime } = setup();
    runtime.seedImage("alpine:3.20");
    runtime.seedNetwork("mbx-uplink");
    const { id } = await runtime.createContainer({ image: "alpine:3.20", name: "proxy" });
    await executor.request("n5", "connectNetwork", {
      containerId: id,
      name: "mbx-uplink",
      opts: { alias: "minibox-proxy" },
    });
    expect(responseTo(frames, "n5")).toMatchObject({ ok: true });
    expect(runtime.callsTo("connectNetwork")).toHaveLength(1);

    await executor.request("n6", "listNetworks", {});
    expect(responseTo(frames, "n6")).toMatchObject({
      ok: true,
      result: [{ name: "mbx-uplink", subnets: [] }],
    });
  });

  test("a network with a running container attached is a conflict, and one with only stopped containers is removed", async () => {
    const { executor, frames, runtime } = setup();
    runtime.seedImage("alpine:3.20");
    runtime.seedNetwork("mbx-egress-b");
    runtime.seedContainer({ image: "alpine:3.20", network: "mbx-egress-b", running: true });
    await executor.request("n7", "removeNetwork", { name: "mbx-egress-b" });
    expect(responseTo(frames, "n7")).toMatchObject({ ok: false, error: { kind: "conflict" } });

    runtime.seedNetwork("mbx-egress-c");
    runtime.seedContainer({ image: "alpine:3.20", network: "mbx-egress-c", running: false });
    await executor.request("n8", "removeNetwork", { name: "mbx-egress-c" });
    expect(responseTo(frames, "n8")).toMatchObject({ ok: true });
    expect(runtime.networks.has("mbx-egress-c")).toBe(false);
  });
});
