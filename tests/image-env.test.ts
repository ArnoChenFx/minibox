import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { HostCtx } from "../src/host/registry";
import { envChange } from "../src/labels";
import type { CommitSpec } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { takeCheckpoint } from "../src/services/checkpoints";
import { envScrubChanges } from "../src/services/images";
import { rebuildBox } from "../src/services/rebuild";
import { createSnapshot } from "../src/services/snapshots";
import type { BoxEnv } from "../src/specs/types";
import { createTestApp, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
});

afterEach(() => restoreLogs());

/** An app whose base template carries `baseEnv`, as the image of the bundled template may. */
function lab(baseEnv: string[] = []): { runtime: FakeRuntime; host: HostCtx } {
  const { app, runtime } = createTestApp({ labelPrefix: "mbtest" });
  const host = app.hosts.get();
  const labels = { [host.keys.template]: "true", [host.keys.templateName]: "base" };
  runtime.seedImage(host.baseTemplateTag, labels, undefined, baseEnv);
  return { runtime, host };
}

/** A box whose environment is `env`. A value reaches the container through a rebuild, as the box's env does. */
async function boxWithEnv(host: HostCtx, env: BoxEnv[], name = "alpha"): Promise<boxes.Box> {
  const box = await boxes.createBox(host, { name, cpus: 1, memoryMb: 256 });
  return env.length === 0 ? box : rebuildBox(host, box.boxId, box.revision, { env }, true);
}

/** The `commitContainer` call at `index` of the recorded calls. The last one by default. */
function commitAt(runtime: FakeRuntime, index = -1): CommitSpec {
  const entry = runtime.callsTo("commitContainer").at(index);
  if (!entry) throw new Error("no commit was made");
  return entry.args[1] as CommitSpec;
}

async function envOf(runtime: FakeRuntime, ref: string): Promise<string[]> {
  return (await runtime.inspectImage(ref)).env;
}

describe("the environment a commit writes", () => {
  test("a value the box was given never reaches the image, and its name is left empty", async () => {
    const { runtime, host } = lab(["PATH=/usr/local/bin:/usr/bin"]);
    const box = await boxWithEnv(host, [{ name: "API_TOKEN", value: "s3cret-value" }]);

    const snap = await createSnapshot(host, box.boxId, "envtest");

    expect(await envOf(runtime, snap.ref)).toEqual(["PATH=/usr/local/bin:/usr/bin", "API_TOKEN="]);
  });

  test("the commit names each variable with an empty value, a secret reference too, and no value", async () => {
    const { host } = lab();
    host.secrets.set("db-password", "db-s3cret-value", new Date().toISOString());
    const box = await boxWithEnv(host, [
      { name: "API_TOKEN", value: "s3cret-value" },
      { name: "DB_PASSWORD", secretRef: "db-password" },
    ]);

    // A snapshot of this box is refused (secret_in_image), so the scrub it would apply is checked directly.
    const changes = await envScrubChanges(host, box);
    expect(changes.filter((change) => change.startsWith("ENV "))).toEqual(['ENV API_TOKEN=""', 'ENV DB_PASSWORD=""']);
    expect(changes.join("\n")).not.toContain("s3cret-value");
    expect(changes.join("\n")).not.toContain("db-password");
    expect(changes.join("\n")).not.toContain("db-s3cret-value");
  });

  test("a box with no environment value writes no ENV instruction", async () => {
    const { runtime, host } = lab();
    const plain = await boxWithEnv(host, []);

    await createSnapshot(host, plain.boxId, "plain");

    expect(commitAt(runtime).changes.some((change) => change.startsWith("ENV "))).toBe(false);
  });

  test("a secret reference is scrubbed as well, so an injected secret value cannot reach the image", async () => {
    const { runtime, host } = lab();
    host.secrets.set("vault", "vault-s3cret-value", new Date().toISOString());
    const box = await boxWithEnv(host, [{ name: "TOKEN", secretRef: "vault" }]);

    // The service is called directly, below the operation that refuses this box with secret_in_image.
    await createSnapshot(host, box.boxId, "vaulted").catch(() => undefined);

    expect(runtime.callsTo("commitContainer")).toEqual([]);
  });

  test("a name the image sets goes back to the image's own value", async () => {
    const { runtime, host } = lab(["NODE_ENV=production"]);
    const box = await boxWithEnv(host, [{ name: "NODE_ENV", value: "development" }]);

    const snap = await createSnapshot(host, box.boxId, "envtest");

    expect(await envOf(runtime, snap.ref)).toEqual(["NODE_ENV=production"]);
  });

  test("an image value with quotes, dollar signs and backslashes is restored as the same text", async () => {
    const own = 'price "$5" C:\\tmp';
    const { runtime, host } = lab([`PRICE=${own}`]);
    const box = await boxWithEnv(host, [{ name: "PRICE", value: "box" }]);

    const snap = await createSnapshot(host, box.boxId, "envtest");

    expect(await envOf(runtime, snap.ref)).toEqual([`PRICE=${own}`]);
  });

  test("an image value with a line break is not written as an instruction, so its name is left empty", async () => {
    const { runtime, host } = lab(["PEM=first\nsecond"]);
    const box = await boxWithEnv(host, [{ name: "PEM", value: "box" }]);

    const snap = await createSnapshot(host, box.boxId, "envtest");

    expect(await envOf(runtime, snap.ref)).toEqual(["PEM="]);
    expect(commitAt(runtime).changes.every((change) => !/[\r\n]/.test(change))).toBe(true);
  });

  test("a checkpoint's system layer is scrubbed in the same way", async () => {
    const { runtime, host } = lab();
    const box = await boxWithEnv(host, [{ name: "API_TOKEN", value: "s3cret-value" }]);

    const view = await takeCheckpoint(
      host,
      box.boxId,
      { pinned: false, include: { system: true, volumes: [] }, consistency: "live" },
      "owner",
    );

    expect(await envOf(runtime, `mbtest-checkpoint:${view.id}`)).toEqual(["API_TOKEN="]);
  });
});

describe("envChange", () => {
  test("quotes the value as a label does, so the instruction reads it literally", () => {
    expect(envChange("A", 'x"y$z\\w')).toBe('ENV A="x\\"y\\$z\\\\w"');
  });

  test("refuses a value with a line break, which would start a new instruction", () => {
    expect(() => envChange("A", "a\nENV B=1")).toThrow("control characters");
  });
});
