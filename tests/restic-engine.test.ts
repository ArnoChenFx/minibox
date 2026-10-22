import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { ResticEngine, RESTIC_IMAGE } from "../src/checkpoints/restic";
import { createLocalHost, type HostCtx } from "../src/host/registry";
import type { HelperResult, HelperSpec } from "../src/runtime";
import { rejectionOf, testConfig } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";

const SNAPSHOT = "a".repeat(64);
const SECOND = "b".repeat(64);
const REPO_VOLUME = "mbtest-checkpoints-local";

interface Scripted {
  rt: FakeRuntime;
  host: HostCtx;
  helpers: HelperSpec[];
  /** Overrides the result of the next helper whose first argument is `command`. */
  next(command: string, result: HelperResult): void;
  dataDir: string;
}

function scripted(): Scripted {
  const cfg = testConfig();
  const rt = new FakeRuntime();
  const host = createLocalHost(cfg, rt);
  const helpers: HelperSpec[] = [];
  const overrides: { command: string; result: HelperResult }[] = [];
  const state = { repoExists: false };
  rt.helperHandler = (spec) => {
    helpers.push(spec);
    const command = spec.cmd.find((arg) => arg !== "--no-cache") ?? "";
    const index = overrides.findIndex((o) => o.command === command);
    if (index >= 0) return overrides.splice(index, 1)[0]?.result ?? { exitCode: 0, logs: "" };
    if (command === "cat") {
      return state.repoExists
        ? { exitCode: 0, logs: "{}" }
        : { exitCode: 10, logs: "Fatal: repository does not exist" };
    }
    if (command === "init") {
      state.repoExists = true;
      return { exitCode: 0, logs: "created restic repository" };
    }
    if (command === "backup") {
      return {
        exitCode: 0,
        logs: [
          '{"message_type":"status","percent_done":0.5}',
          `{"message_type":"summary","snapshot_id":"${SNAPSHOT}","total_bytes_processed":4096}`,
        ].join("\n"),
      };
    }
    return { exitCode: 0, logs: "" };
  };
  return {
    rt,
    host,
    helpers,
    next(command, result) {
      overrides.push({ command, result });
    },
    dataDir: cfg.dataDir,
  };
}

const commandsOf = (helpers: HelperSpec[]) => helpers.map((spec) => spec.cmd.find((arg) => arg !== "--no-cache") ?? "");

describe("ResticEngine backup", () => {
  test("the first backup initializes the repository, then snapshots the volume read-only with its tags", async () => {
    const s = scripted();
    await s.rt.createVolume("src", {});
    const engine = new ResticEngine({ dataDir: s.dataDir });
    const result = await engine.backup(s.host, "src", ["ck_abc", "vol_src"]);

    expect(result).toEqual({ snapshotId: SNAPSHOT, bytes: 4096 });
    expect(commandsOf(s.helpers)).toEqual(["cat", "init", "backup"]);
    const backup = s.helpers[2];
    expect(backup).toMatchObject({
      image: RESTIC_IMAGE,
      user: "0:0",
      capAdd: ["DAC_READ_SEARCH"],
      memoryBytes: 1024 * 1024 * 1024,
      pidsLimit: 256,
      tmpfsBytes: 64 * 1024 * 1024,
      timeoutSec: 3600,
      mounts: [
        { source: REPO_VOLUME, target: "/repo", mode: "rw" },
        { source: "src", target: "/data", mode: "ro" },
      ],
    });
    expect(backup?.cmd).toEqual([
      "--no-cache",
      "backup",
      "/data",
      "--json",
      "--host",
      "local",
      "--tag",
      "ck_abc",
      "--tag",
      "vol_src",
    ]);
    expect(backup?.network).toBeUndefined();
  });

  test("the repository volume is internal and names its host, and the helper's labels mark it internal too", async () => {
    const s = scripted();
    await s.rt.createVolume("src", {});
    await new ResticEngine({ dataDir: s.dataDir }).backup(s.host, "src", []);
    expect(s.rt.volumes.get(REPO_VOLUME)?.labels).toEqual({ "mbtest.internal": "true", "mbtest.checkpoint": "local" });
    expect(s.helpers[0]?.labels).toEqual({ "mbtest.internal": "true" });
  });

  test("the password is generated once into the secrets directory and reaches every helper as a secret file", async () => {
    const s = scripted();
    await s.rt.createVolume("src", {});
    const engine = new ResticEngine({ dataDir: s.dataDir });
    await engine.backup(s.host, "src", []);
    const keyPath = join(s.dataDir, "secrets", "checkpoint-repo.key");
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    const key = readFileSync(keyPath, "utf8").trim();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    for (const spec of s.helpers) {
      expect(spec.secrets).toEqual([{ name: "repo.key", value: key }]);
      expect(spec.env).toContain("RESTIC_PASSWORD_FILE=/run/secrets/repo.key");
      expect(spec.env?.some((entry) => entry.includes(key))).toBe(false);
    }

    await new ResticEngine({ dataDir: s.dataDir }).backup(s.host, "src", []);
    expect(readFileSync(keyPath, "utf8").trim()).toBe(key);
    expect(s.helpers.at(-1)?.secrets).toEqual([{ name: "repo.key", value: key }]);
  });

  test("a partial backup (exit 3) is a failure with restic's output, not a snapshot", async () => {
    const s = scripted();
    await s.rt.createVolume("src", {});
    s.next("backup", { exitCode: 3, logs: "Warning: open /data/secret: permission denied" });
    const error = await rejectionOf(new ResticEngine({ dataDir: s.dataDir }).backup(s.host, "src", []));
    expect(error).toMatchObject({ kind: "engine" });
    expect((error as Error).message).toContain("restic backup exited with status 3");
    expect((error as Error).message).toContain("permission denied");
  });

  test("a backup that prints no summary is a failure", async () => {
    const s = scripted();
    await s.rt.createVolume("src", {});
    s.next("backup", { exitCode: 0, logs: '{"message_type":"status"}' });
    expect(await rejectionOf(new ResticEngine({ dataDir: s.dataDir }).backup(s.host, "src", []))).toMatchObject({
      kind: "engine",
    });
  });

  test("a repository the password cannot open is an error, and no repository is initialized over it", async () => {
    const s = scripted();
    await s.rt.createVolume("src", {});
    s.next("cat", { exitCode: 12, logs: "Fatal: wrong password" });
    const error = await rejectionOf(new ResticEngine({ dataDir: s.dataDir }).backup(s.host, "src", []));
    expect(error).toMatchObject({ kind: "engine" });
    expect((error as Error).message).toContain("password is wrong");
    expect(commandsOf(s.helpers)).toEqual(["cat"]);
  });

  test("a volume that does not exist fails as not_found, before any helper runs", async () => {
    const s = scripted();
    expect(await rejectionOf(new ResticEngine({ dataDir: s.dataDir }).backup(s.host, "missing", []))).toMatchObject({
      kind: "not_found",
    });
    expect(s.helpers).toEqual([]);
    expect(s.rt.volumes.has(REPO_VOLUME)).toBe(false);
  });

  test("two operations on one host do not overlap", async () => {
    const s = scripted();
    await s.rt.createVolume("src", {});
    await s.rt.createVolume("other", {});
    const trace: string[] = [];
    let running = 0;
    let peak = 0;
    const slow = new Proxy(s.rt, {
      get(target, prop) {
        if (prop === "runHelper") {
          return async (spec: HelperSpec) => {
            running += 1;
            peak = Math.max(peak, running);
            trace.push(`start ${spec.cmd.at(-1)}`);
            await new Promise((resolve) => setTimeout(resolve, 5));
            const result = await target.runHelper(spec);
            running -= 1;
            return result;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const host = createLocalHost(testConfig({ dataDir: s.dataDir }), slow);
    const engine = new ResticEngine({ dataDir: s.dataDir });
    await Promise.all([engine.backup(host, "src", []), engine.backup(host, "other", [])]);
    expect(peak).toBe(1);
    expect(trace.length).toBeGreaterThan(2);
  });
});

describe("ResticEngine restore and forget", () => {
  test("restore writes <snapshot>:/data into the target volume with the three ownership capabilities", async () => {
    const s = scripted();
    await s.rt.createVolume("src", {});
    await s.rt.createVolume("fresh", {});
    const engine = new ResticEngine({ dataDir: s.dataDir });
    await engine.backup(s.host, "src", []);
    s.helpers.length = 0;

    await engine.restore(s.host, SNAPSHOT, "fresh");

    expect(commandsOf(s.helpers)).toEqual(["restore"]);
    expect(s.helpers[0]).toMatchObject({
      capAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER"],
      mounts: [
        { source: REPO_VOLUME, target: "/repo", mode: "rw" },
        { source: "fresh", target: "/dst", mode: "rw" },
      ],
    });
    expect(s.helpers[0]?.cmd).toEqual(["--no-cache", "restore", `${SNAPSHOT}:/data`, "--target", "/dst"]);
  });

  test("restore of a repository that does not exist is not_found, and creates nothing", async () => {
    const s = scripted();
    await s.rt.createVolume("fresh", {});
    const error = await rejectionOf(new ResticEngine({ dataDir: s.dataDir }).restore(s.host, SNAPSHOT, "fresh"));
    expect(error).toMatchObject({ kind: "not_found" });
    expect(commandsOf(s.helpers)).toEqual([]);
    expect(s.rt.volumes.has(REPO_VOLUME)).toBe(false);
  });

  test("a snapshot id that is not a restic id is refused before any helper runs", async () => {
    const s = scripted();
    await s.rt.createVolume("fresh", {});
    expect(
      await rejectionOf(new ResticEngine({ dataDir: s.dataDir }).restore(s.host, "../../etc", "fresh")),
    ).toMatchObject({ kind: "invalid" });
    expect(s.helpers).toEqual([]);
  });

  test("forget removes the snapshot and prunes the repository", async () => {
    const s = scripted();
    await s.rt.createVolume("src", {});
    const engine = new ResticEngine({ dataDir: s.dataDir });
    await engine.backup(s.host, "src", []);
    s.helpers.length = 0;
    await engine.forget(s.host, SECOND);
    expect(s.helpers[0]?.cmd).toEqual(["--no-cache", "forget", SECOND, "--prune"]);
  });

  test("a failed restore is an engine error with the exit status", async () => {
    const s = scripted();
    await s.rt.createVolume("src", {});
    await s.rt.createVolume("fresh", {});
    await new ResticEngine({ dataDir: s.dataDir }).backup(s.host, "src", []);
    s.next("restore", { exitCode: 1, logs: "Fatal: lchown: operation not permitted" });
    const error = await rejectionOf(new ResticEngine({ dataDir: s.dataDir }).restore(s.host, SNAPSHOT, "fresh"));
    expect(error).toMatchObject({ kind: "engine" });
    expect((error as Error).message).toContain("restic restore exited with status 1");
  });
});
