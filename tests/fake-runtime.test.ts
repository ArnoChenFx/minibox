import { describe, expect, test } from "bun:test";

import { RuntimeError } from "../src/runtime";
import { rejectionOf } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";

const labels = { mbtest: "true" };

describe("FakeRuntime follows engine semantics the services rely on", () => {
  test("names are unique and missing objects are not_found", async () => {
    const rt = new FakeRuntime();
    rt.seedImage("alpine:3.20");
    await rt.createContainer({ image: "alpine:3.20", name: "one" });

    expect(await rejectionOf(rt.createContainer({ image: "alpine:3.20", name: "one" }))).toMatchObject({
      kind: "conflict",
    });
    expect(await rejectionOf(rt.createContainer({ image: "ghost:1" }))).toMatchObject({ kind: "not_found" });
    expect(await rejectionOf(rt.inspectContainer("missing"))).toMatchObject({ kind: "not_found" });
    expect(await rejectionOf(rt.inspectImage("ghost:1"))).toMatchObject({ kind: "not_found" });
  });

  test("start and stop are idempotent and only a forced remove stops a running container", async () => {
    const rt = new FakeRuntime();
    rt.seedImage("alpine:3.20");
    const { id } = await rt.createContainer({ image: "alpine:3.20", name: "box" });
    await rt.startContainer(id);
    await rt.startContainer(id);
    expect((await rt.inspectContainer(id)).running).toBe(true);

    expect(await rejectionOf(rt.removeContainer(id, { force: false }))).toMatchObject({ kind: "conflict" });
    await rt.stopContainer(id, { timeoutSec: 1 });
    await rt.stopContainer(id, { timeoutSec: 1 });
    expect((await rt.inspectContainer(id)).running).toBe(false);
  });

  test("a volume that a container mounts cannot be removed", async () => {
    const rt = new FakeRuntime();
    rt.seedImage("alpine:3.20");
    await rt.createVolume("data", labels);
    const { id } = await rt.createContainer({ image: "alpine:3.20", mounts: [{ source: "data", target: "/d" }] });

    expect(await rejectionOf(rt.removeVolume("data"))).toMatchObject({ kind: "conflict" });
    await rt.removeContainer(id, { force: true });
    await rt.removeVolume("data");
    expect(rt.volumes.size).toBe(0);
  });

  test("creating an existing volume keeps its labels", async () => {
    const rt = new FakeRuntime();
    await rt.createVolume("data", { first: "1" });
    await rt.createVolume("data", { second: "2" });
    expect((await rt.inspectVolume("data")).labels).toEqual({ first: "1" });
  });

  test("commit merges container labels with the LABEL changes, and retags move the tag", async () => {
    const rt = new FakeRuntime();
    rt.seedImage("base:1", { owner: "image" });
    const { id } = await rt.createContainer({ image: "base:1", labels: { box: "true" } });
    await rt.commitContainer(id, { repo: "snap", tag: "a", changes: ['LABEL k="quoted value"', 'CMD ["true"]'] });
    await rt.commitContainer(id, { repo: "snap", tag: "a", changes: ["LABEL k=second"] });

    const images = await rt.listImages({ labels: { box: "true" } });
    expect(images).toHaveLength(2);
    const current = images.find((img) => img.repoTags.includes("snap:a"));
    expect(current?.labels).toEqual({ owner: "image", box: "true", k: "second" });
    expect(images.filter((img) => img.repoTags.includes("<none>:<none>"))).toHaveLength(1);
  });

  test("removing the last tag of an image in use leaves it dangling, or refuses without force", async () => {
    const rt = new FakeRuntime();
    const imageId = rt.seedImage("keep:1", { mark: "yes" });
    await rt.createContainer({ image: "keep:1" });

    expect(await rejectionOf(rt.removeImage("keep:1", { force: false }))).toMatchObject({ kind: "conflict" });
    await rt.removeImage("keep:1", { force: true });
    expect(await rt.listImages({ labels: { mark: "yes" } })).toEqual([
      expect.objectContaining({ id: imageId, repoTags: ["<none>:<none>"] }),
    ]);
  });

  test("logs honour the tail and failures can be queued per operation", async () => {
    const rt = new FakeRuntime();
    rt.seedImage("alpine:3.20");
    const id = rt.seedContainer({ image: "alpine:3.20", running: true });
    const c = rt.containers.get(id);
    if (!c) throw new Error("seeded container missing");
    c.logs = "one\ntwo\nthree\n";
    expect(await rt.containerLogs(id, { tail: 2, timestamps: true })).toBe("two\nthree\n");

    rt.fail("containerLogs", new RuntimeError("engine", "first"));
    expect(await rejectionOf(rt.containerLogs(id, { tail: 1, timestamps: false }))).toMatchObject({ detail: "first" });
    expect(await rt.containerLogs(id, { tail: 1, timestamps: false })).toBe("three\n");
  });

  test("down makes every call unavailable, including the ping that marks a host offline", async () => {
    const rt = new FakeRuntime();
    rt.down = true;
    expect(await rejectionOf(rt.ping())).toMatchObject({ kind: "unavailable" });
    expect(await rejectionOf(rt.info())).toMatchObject({ kind: "unavailable" });
    expect(rt.ops()).toEqual(["ping", "info"]);
  });

  test("events yield what is emitted until the signal aborts", async () => {
    const rt = new FakeRuntime();
    const controller = new AbortController();
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const event of rt.events({ labels }, controller.signal)) seen.push(event.action);
      return "ended";
    })();

    rt.emitEvent({ type: "container", action: "start", id: "a", attributes: labels, time: "t" });
    rt.emitEvent({ type: "container", action: "stop", id: "b", attributes: {}, time: "t" });
    rt.emitEvent({ type: "container", action: "die", id: "c", attributes: labels, time: "t" });
    await Bun.sleep(10);
    controller.abort();

    expect(await consumer).toBe("ended");
    expect(seen).toEqual(["start", "die"]);
  });

  test("ensureBridgeNetwork creates an isolated network once and refuses networks with other settings", async () => {
    const rt = new FakeRuntime();
    await rt.ensureBridgeNetwork("boxes", { interContainerComm: false });
    await rt.ensureBridgeNetwork("boxes", { interContainerComm: false });
    expect(rt.networks.get("boxes")?.options).toEqual({ "com.docker.network.bridge.enable_icc": "false" });
    expect(rt.callsTo("ensureBridgeNetwork")).toHaveLength(2);

    rt.seedNetwork("open");
    expect(await rejectionOf(rt.ensureBridgeNetwork("open", { interContainerComm: false }))).toMatchObject({
      kind: "conflict",
    });
    expect(await rejectionOf(rt.ensureBridgeNetwork("boxes", { interContainerComm: true }))).toMatchObject({
      kind: "conflict",
    });
    rt.seedNetwork("overlay", {}, "overlay");
    expect(await rejectionOf(rt.ensureBridgeNetwork("overlay", { interContainerComm: true }))).toMatchObject({
      kind: "conflict",
    });
  });

  test("a container on a missing network can be created but not started, and reports its network once attached", async () => {
    const rt = new FakeRuntime();
    rt.seedImage("alpine:3.20");
    const { id } = await rt.createContainer({ image: "alpine:3.20", network: "boxes" });
    expect(await rejectionOf(rt.startContainer(id))).toMatchObject({ kind: "not_found" });

    await rt.ensureBridgeNetwork("boxes", { interContainerComm: false });
    await rt.startContainer(id);
    expect(await rt.inspectContainer(id)).toMatchObject({ running: true, network: "boxes" });
  });

  test("a stopped container cannot start on a re-created network until it is re-attached", async () => {
    const rt = new FakeRuntime();
    rt.seedImage("alpine:3.20");
    await rt.ensureBridgeNetwork("boxes", { interContainerComm: false });
    const oldId = rt.networks.get("boxes")?.id ?? "";
    const { id } = await rt.createContainer({ image: "alpine:3.20", network: "boxes" });
    await rt.startContainer(id);
    await rt.stopContainer(id, { timeoutSec: 1 });

    rt.pruneNetworks();
    await rt.ensureBridgeNetwork("boxes", { interContainerComm: false });
    const failure = await rejectionOf(rt.startContainer(id));
    expect(failure).toMatchObject({ kind: "not_found" });
    expect((failure as Error).message).toContain(oldId);

    await rt.reattachNetwork(id, "boxes");
    await rt.startContainer(id);
    expect(await rt.inspectContainer(id)).toMatchObject({ running: true, network: "boxes" });
  });

  test("reattachNetwork refuses containers on other networks and networks that do not exist", async () => {
    const rt = new FakeRuntime();
    rt.seedImage("alpine:3.20");
    await rt.ensureBridgeNetwork("boxes", { interContainerComm: false });
    const { id } = await rt.createContainer({ image: "alpine:3.20", network: "boxes" });

    expect(await rejectionOf(rt.reattachNetwork(id, "other"))).toMatchObject({ kind: "invalid" });
    rt.networks.delete("boxes");
    expect(await rejectionOf(rt.reattachNetwork(id, "boxes"))).toMatchObject({ kind: "not_found" });
  });

  test("pruning keeps only networks that a running container uses", async () => {
    const rt = new FakeRuntime();
    rt.seedImage("alpine:3.20");
    rt.seedNetwork("stopped-only");
    rt.seedNetwork("in-use");
    rt.seedNetwork("idle");
    rt.seedContainer({ image: "alpine:3.20", network: "stopped-only" });
    rt.seedContainer({ image: "alpine:3.20", network: "in-use", running: true });

    rt.pruneNetworks();
    expect([...rt.networks.keys()]).toEqual(["in-use"]);
  });

  test("containers on the default bridge report bridge and need no network to start", async () => {
    const rt = new FakeRuntime();
    rt.seedImage("alpine:3.20");
    const { id } = await rt.createContainer({ image: "alpine:3.20" });
    await rt.startContainer(id);
    expect(await rt.inspectContainer(id)).toMatchObject({ network: "bridge", running: true });
  });
});
