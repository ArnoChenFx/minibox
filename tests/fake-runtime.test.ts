import { describe, expect, test } from "bun:test";

import { RuntimeError } from "../src/runtime";
import { rejectionOf } from "./support/app";
import { FakeRuntime, fakeStamp, fakeStampMs } from "./support/fake-runtime";

const labels = { mbtest: "true" };
const devTemplate = { "minibox.template.uid": "1000", "minibox.template.gid": "1000" };

/** Every value of an async iterable, in order. */
async function drain<T>(values: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of values) out.push(value);
  return out;
}

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

  test("pausing freezes a running container and reports it as paused, and each direction refuses a no-op", async () => {
    const rt = new FakeRuntime();
    rt.seedImage("alpine:3.20");
    const { id } = await rt.createContainer({ image: "alpine:3.20", name: "box" });
    expect(await rejectionOf(rt.pauseContainer(id))).toMatchObject({ kind: "conflict" });
    await rt.startContainer(id);
    await rt.pauseContainer(id);
    expect(await rt.inspectContainer(id)).toMatchObject({ running: true, state: "paused" });
    expect(await rejectionOf(rt.pauseContainer(id))).toMatchObject({ kind: "conflict" });
    await rt.unpauseContainer(id);
    expect(await rt.inspectContainer(id)).toMatchObject({ running: true, state: "running" });
    await rt.unpauseContainer(id);
    expect(await rt.inspectContainer(id)).toMatchObject({ running: true, state: "running" });
  });

  test("pulling seeds a missing image and leaves a present one alone", async () => {
    const rt = new FakeRuntime();
    await rt.pullImage("restic/restic:0.18.1");
    const first = await rt.inspectImage("restic/restic:0.18.1");
    await rt.pullImage("restic/restic:0.18.1");
    expect((await rt.inspectImage("restic/restic:0.18.1")).id).toBe(first.id);
    expect(rt.callsTo("pullImage")).toHaveLength(2);
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

    rt.emitEvent({ type: "container", action: "start", id: "a", attributes: labels, time: "t", timeNano: 1 });
    rt.emitEvent({ type: "container", action: "stop", id: "b", attributes: {}, time: "t", timeNano: 2 });
    rt.emitEvent({ type: "container", action: "die", id: "c", attributes: labels, time: "t", timeNano: 3 });
    await Bun.sleep(10);
    controller.abort();

    expect(await consumer).toBe("ended");
    expect(seen).toEqual(["start", "die"]);
  });

  test("container changes emit the engine's events, and a stop of a stopped container emits nothing", async () => {
    const rt = new FakeRuntime();
    rt.seedImage("alpine:3.20");
    const controller = new AbortController();
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const event of rt.events({ labels, types: ["container"] }, controller.signal)) {
        seen.push(`${event.action}:${event.attributes.name}`);
      }
    })();

    const { id } = await rt.createContainer({ image: "alpine:3.20", name: "mbtest-a", labels });
    await rt.startContainer(id);
    await rt.stopContainer(id, { timeoutSec: 1 });
    await rt.stopContainer(id, { timeoutSec: 1 });
    await rt.renameContainer(id, "mbtest-b");
    await rt.updateContainer(id, { cpus: 2 });
    await rt.removeContainer(id, { force: true });
    await Bun.sleep(10);
    controller.abort();
    await consumer;

    expect(seen).toEqual([
      "create:mbtest-a",
      "start:mbtest-a",
      "die:mbtest-a",
      "stop:mbtest-a",
      "rename:mbtest-b",
      "update:mbtest-b",
      "destroy:mbtest-b",
    ]);
  });

  test("interruptEvents ends an open stream with the error, as a dropped engine connection does", async () => {
    const rt = new FakeRuntime();
    const consumer = (async () => {
      for await (const event of rt.events({ labels })) void event;
    })();
    rt.interruptEvents(new RuntimeError("unavailable", "connection reset"));
    expect(await rejectionOf(consumer)).toMatchObject({ kind: "unavailable", message: "connection reset" });
  });

  test("followLogs yields the tail, then each line as it is written, and a final partial line when the container stops", async () => {
    const rt = new FakeRuntime();
    const id = rt.seedContainer({ image: "alpine:3.20", running: true });
    rt.appendLogs(id, "one\ntwo\nthree\n");
    const follow = drain(rt.followLogs(id, { tail: 2, timestamps: false }));
    rt.appendLogs(id, "four\nfi");
    await Bun.sleep(5);
    rt.appendLogs(id, "ve\nsix");
    await Bun.sleep(5);
    await rt.stopContainer(id, { timeoutSec: 1 });

    expect(await follow).toEqual(["two", "three", "four", "five", "six"]);
  });

  test("followLogs of a container that is not running yields its tail and ends at once", async () => {
    const rt = new FakeRuntime();
    const id = rt.seedContainer({ image: "alpine:3.20" });
    rt.appendLogs(id, "one\ntwo\n");

    expect(await drain(rt.followLogs(id, { tail: 10, timestamps: false }))).toEqual(["one", "two"]);
    expect(await drain(rt.followLogs(id, { tail: 1, timestamps: false }))).toEqual(["two"]);
    expect(await drain(rt.followLogs(id, { tail: 0, timestamps: false }))).toEqual([]);
  });

  test("followLogs stamps each line as the engine does, and since keeps the lines stamped at or after it, past the tail", async () => {
    const rt = new FakeRuntime();
    const id = rt.seedContainer({ image: "alpine:3.20" });
    rt.appendLogs(id, "one\ntwo\nthree\nfour\n");

    const stamped = await drain(rt.followLogs(id, { tail: 2, timestamps: true }));
    expect(stamped).toEqual([`${fakeStamp(2)} three`, `${fakeStamp(3)} four`]);
    expect(stamped[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+\.\d{9}Z three$/);

    const since = new Date(fakeStampMs(1));
    expect(await drain(rt.followLogs(id, { tail: 10, timestamps: true, since }))).toEqual([
      `${fakeStamp(1)} two`,
      `${fakeStamp(2)} three`,
      `${fakeStamp(3)} four`,
    ]);
    expect(await drain(rt.followLogs(id, { tail: 2, timestamps: false, since: new Date(fakeStampMs(0)) }))).toEqual([
      "three",
      "four",
    ]);
    expect(await drain(rt.followLogs(id, { tail: 2, timestamps: false, since: new Date(fakeStampMs(3)) }))).toEqual([
      "four",
    ]);
    expect(await drain(rt.followLogs(id, { tail: 1, timestamps: false, since: new Date(fakeStampMs(4)) }))).toEqual([]);
  });

  test("a followed log ends quietly when its signal aborts, and an interrupt ends it with the error", async () => {
    const rt = new FakeRuntime();
    const id = rt.seedContainer({ image: "alpine:3.20", running: true });
    const controller = new AbortController();
    const quiet = drain(rt.followLogs(id, { tail: 0, timestamps: false, signal: controller.signal }));
    await Bun.sleep(5);
    controller.abort();
    expect(await quiet).toEqual([]);

    const broken = drain(rt.followLogs(id, { tail: 0, timestamps: false }));
    await Bun.sleep(5);
    rt.interruptLogs(new RuntimeError("unavailable", "connection reset"));
    expect(await rejectionOf(broken)).toMatchObject({ kind: "unavailable", message: "connection reset" });
  });

  test("a restart or removal ends the follows of its container, and a follow of a missing container is not_found", async () => {
    const rt = new FakeRuntime();
    const id = rt.seedContainer({ image: "alpine:3.20", running: true });
    const restarted = drain(rt.followLogs(id, { tail: 0, timestamps: false }));
    await rt.restartContainer(id, { timeoutSec: 1 });
    expect(await restarted).toEqual([]);

    const removed = drain(rt.followLogs(id, { tail: 0, timestamps: false }));
    await rt.removeContainer(id, { force: true });
    expect(await removed).toEqual([]);
    expect(await rejectionOf(drain(rt.followLogs(id, { tail: 1, timestamps: false })))).toMatchObject({
      kind: "not_found",
    });
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

  test("a volume takes the owner its template names when first mounted at /workspace, and root otherwise", async () => {
    const rt = new FakeRuntime();
    rt.seedImage("dev:1", devTemplate);
    rt.seedImage("plain:1", {});
    const dev = await rt.createContainer({ image: "dev:1", mounts: [{ source: "ws", target: "/workspace" }] });
    const data = await rt.createContainer({ image: "dev:1", mounts: [{ source: "data", target: "/data" }] });
    const plain = await rt.createContainer({ image: "plain:1", mounts: [{ source: "plain", target: "/workspace" }] });

    expect(await rt.volumeRootOwner(dev.id, "/workspace")).toEqual({ uid: 1000, gid: 1000 });
    expect(await rt.volumeRootOwner(data.id, "/data")).toEqual({ uid: 0, gid: 0 });
    expect(await rt.volumeRootOwner(plain.id, "/workspace")).toEqual({ uid: 0, gid: 0 });
  });

  test("a volume keeps the owner it has once it has been mounted, whatever template mounts it later", async () => {
    const rt = new FakeRuntime();
    rt.seedImage("dev:1", devTemplate);
    rt.seedImage("root:1", {});
    await rt.createContainer({ image: "root:1", mounts: [{ source: "ws", target: "/workspace" }] });
    const later = await rt.createContainer({ image: "dev:1", mounts: [{ source: "ws", target: "/workspace" }] });

    expect(await rt.volumeRootOwner(later.id, "/workspace")).toEqual({ uid: 0, gid: 0 });
  });

  test("the owner of a path that no mount of the container has is not_found", async () => {
    const rt = new FakeRuntime();
    rt.seedImage("dev:1", devTemplate);
    const { id } = await rt.createContainer({ image: "dev:1" });

    expect(await rejectionOf(rt.volumeRootOwner(id, "/workspace"))).toMatchObject({ kind: "not_found" });
  });

  test("setting a volume's owner needs the volume and the helper image, and a later mount keeps the owner", async () => {
    const rt = new FakeRuntime();
    rt.seedImage("dev:1", devTemplate);
    rt.seedImage("helper:1", {});
    const owner = { uid: 1000, gid: 1000 };

    expect(await rejectionOf(rt.setVolumeRootOwner("ws", owner, "helper:1"))).toMatchObject({ kind: "not_found" });
    await rt.createVolume("ws", labels);
    expect(await rejectionOf(rt.setVolumeRootOwner("ws", owner, "ghost:1"))).toMatchObject({ kind: "engine" });
    await rt.setVolumeRootOwner("ws", owner, "helper:1");

    const { id } = await rt.createContainer({ image: "dev:1", mounts: [{ source: "ws", target: "/workspace" }] });
    expect(await rt.volumeRootOwner(id, "/workspace")).toEqual(owner);
    expect(rt.callsTo("setVolumeRootOwner")).toHaveLength(3);
  });

  test("removing a volume forgets its owner, so the volume created again takes its next mount's owner", async () => {
    const rt = new FakeRuntime();
    rt.seedImage("dev:1", devTemplate);
    rt.seedImage("helper:1", {});
    await rt.createVolume("ws", labels);
    await rt.setVolumeRootOwner("ws", { uid: 0, gid: 0 }, "helper:1");
    await rt.removeVolume("ws");

    await rt.createVolume("ws", labels);
    const { id } = await rt.createContainer({ image: "dev:1", mounts: [{ source: "ws", target: "/workspace" }] });
    expect(await rt.volumeRootOwner(id, "/workspace")).toEqual({ uid: 1000, gid: 1000 });
  });

  test("seeding a volume's owner records no call, and the owner is what a later mount sees", async () => {
    const rt = new FakeRuntime();
    rt.seedImage("dev:1", devTemplate);
    rt.seedVolumeOwner("ws", { uid: 0, gid: 0 });
    const { id } = await rt.createContainer({ image: "dev:1", mounts: [{ source: "ws", target: "/workspace" }] });

    expect(await rt.volumeRootOwner(id, "/workspace")).toEqual({ uid: 0, gid: 0 });
    expect(rt.callsTo("setVolumeRootOwner")).toHaveLength(0);
  });
});
