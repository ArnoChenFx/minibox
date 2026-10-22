import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import { RuntimeError } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { assertImageAvailable, ensureImageOn, isPullable, pullImageInto } from "../src/services/images";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

let restoreLogs: () => void;
beforeEach(() => {
  restoreLogs = silenceLogs();
});
afterEach(() => restoreLogs());

interface Lab {
  readonly app: App;
  readonly runtime: FakeRuntime;
  readonly host: HostCtx;
}

function lab(): Lab {
  const { app, runtime } = createTestApp({ labelPrefix: "mbtest" });
  const host = app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true", [host.keys.templateName]: "base" });
  return { app, runtime, host };
}

const pulls = (l: Lab) => l.runtime.callsTo("pullImage").map((call) => call.args[0]);

describe("which missing images may be pulled", () => {
  test("a registry image may be pulled, and MiniBox's own template, snapshot and checkpoint images may not", () => {
    const { host } = lab();
    expect(isPullable(host, "alpine:3.20")).toBe(true);
    expect(isPullable(host, "ghcr.io/org/image:1.2")).toBe(true);
    expect(isPullable(host, "localhost:5000/team/tool")).toBe(true);
    expect(isPullable(host, "node:24@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")).toBe(
      true,
    );
    expect(isPullable(host, "mbtest-template:gold")).toBe(false);
    expect(isPullable(host, "mbtest-snap:box-1")).toBe(false);
    expect(isPullable(host, "mbtest-checkpoint:ckpt")).toBe(false);
  });

  test("an image id or a digest-only reference names one image on one engine, so it is never pulled", () => {
    const { host } = lab();
    expect(isPullable(host, "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")).toBe(false);
    expect(isPullable(host, "0123456789ab")).toBe(false);
  });
});

describe("ensuring an image is present on the engine", () => {
  test("an image already present is returned and nothing is pulled", async () => {
    const l = lab();
    l.runtime.seedImage("alpine:3.20");

    const image = await ensureImageOn(l.host, "alpine:3.20");

    expect(image.tags).toContain("alpine:3.20");
    expect(pulls(l)).toEqual([]);
  });

  test("a missing image is pulled, with each layer's progress written to the log", async () => {
    const l = lab();
    const log: string[] = [];

    const image = await ensureImageOn(l.host, "alpine:3.20", { log: (text) => log.push(text) });

    expect(image.tags).toContain("alpine:3.20");
    expect(pulls(l)).toEqual(["alpine:3.20"]);
    expect(log.join("")).toContain("Pulling alpine:3.20");
    expect(log.join("")).toContain("Pull complete");
  });

  test("a missing MiniBox image is refused as a missing template, and is never pulled", async () => {
    const l = lab();
    const error = await rejectionOf(ensureImageOn(l.host, "mbtest-template:gold"));
    expect(error).toMatchObject({ status: 400, key: "template_image_missing", details: { field: "template" } });
    expect(pulls(l)).toEqual([]);
  });

  test("a missing image the registry does not hold is refused as a missing template, with its name", async () => {
    const l = lab();
    l.runtime.unpullable.add("ghost:1");
    const error = await rejectionOf(ensureImageOn(l.host, "ghost:1"));
    expect(error).toMatchObject({ status: 400, key: "template_image_missing", params: { image: "ghost:1" } });
  });

  test("any other pull failure is refused with the engine's text, not as a missing image", async () => {
    const l = lab();
    l.runtime.fail("pullImage", new RuntimeError("unavailable", "registry timed out"));
    const error = await rejectionOf(ensureImageOn(l.host, "alpine:3.20"));
    expect(error).toMatchObject({ status: 400, key: "image_pull_failed" });
    expect((error as { params?: { detail?: string } }).params?.detail).toContain("registry timed out");
  });
});

describe("pulling an image for an explicit request", () => {
  test("a missing registry image is pulled and its id returned", async () => {
    const l = lab();
    const id = await pullImageInto(l.host, "alpine:3.20", { field: "ref" });
    expect(id).toBe((await l.runtime.inspectImage("alpine:3.20")).id);
  });

  test("a registry that does not hold the reference fails as image_not_found on the ref field", async () => {
    const l = lab();
    l.runtime.unpullable.add("nope:404");
    const error = await rejectionOf(pullImageInto(l.host, "nope:404", { field: "ref" }));
    expect(error).toMatchObject({ status: 400, key: "image_not_found", details: { field: "ref" } });
  });

  test("assertImageAvailable passes a missing image a registry may hold, without pulling it", async () => {
    const l = lab();
    await assertImageAvailable(l.host, "alpine:3.20");
    expect(pulls(l)).toEqual([]);
  });

  test("assertImageAvailable refuses a missing MiniBox image", async () => {
    const l = lab();
    expect(await rejectionOf(assertImageAvailable(l.host, "mbtest-template:gold"))).toMatchObject({
      key: "template_image_missing",
    });
  });
});

describe("a box created from an image the engine does not hold", () => {
  test("pulls the image on demand and starts the box from it", async () => {
    const l = lab();

    const box = await boxes.createBox(l.host, { name: "alpha", cpus: 1, memoryMb: 256, image: "alpine:3.20" });

    expect(pulls(l)).toEqual(["alpine:3.20"]);
    expect(box.name).toBe("alpha");
    expect(box.image).toBe("alpine:3.20");
  });

  test("an image that is already present is not pulled again", async () => {
    const l = lab();
    l.runtime.seedImage("alpine:3.20");
    await boxes.createBox(l.host, { name: "alpha", cpus: 1, memoryMb: 256, image: "alpine:3.20" });
    expect(pulls(l)).toEqual([]);
  });
});
