import { describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SnapshotHeld } from "../src/checkpoints/engine";
import type { RemoteRepository } from "../src/checkpoints/remote";
import { ResticEngine, RESTIC_IMAGE } from "../src/checkpoints/restic";
import { createLocalHost, type HostCtx } from "../src/host/registry";
import type { HelperResult, HelperSpec } from "../src/runtime";
import { rejectionOf, testConfig } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";
import { tarBytes } from "./support/tar";

const SNAPSHOT = "a".repeat(64);
const SECOND = "b".repeat(64);
const ORIGIN = "3".repeat(64);
const PACKED = "2".repeat(64);
const COPIED = "1".repeat(64);
const PASSPHRASE = "a passphrase for one package";
const REPO_VOLUME = "mbtest-checkpoints-local";
/** The words a restic helper's command is, so a remote call's `-o` options do not read as its command. */
const RESTIC_COMMANDS = new Set(["backup", "cat", "copy", "dump", "forget", "init", "restore", "snapshots", "stats"]);

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
    const command = spec.cmd.find((arg) => RESTIC_COMMANDS.has(arg)) ?? "";
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

const commandsOf = (helpers: HelperSpec[]) =>
  helpers.map((spec) => spec.cmd.find((arg) => RESTIC_COMMANDS.has(arg)) ?? "");

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

/** What `snapshots --json` prints for these rows. */
function listed(rows: { id: string; tags?: string[]; original?: string }[]): HelperResult {
  return { exitCode: 0, logs: JSON.stringify(rows) };
}

/** A package file whose repository holds `ids`. The helpers are scripted, so the bytes need only be a tar of the repository. */
function packageFile(dataDir: string, ids: string[]): string {
  const file = join(dataDir, "package.mbckpt");
  writeFileSync(
    file,
    tarBytes([
      { name: "repo/config", body: Buffer.from("{}") },
      ...ids.map((id) => ({ name: `repo/snapshots/${id}`, body: Buffer.from("{}") })),
    ]),
  );
  return file;
}

describe("ResticEngine copies: the origins a listing reports, and what unpacking keeps", () => {
  test("a listing reads the origin of each copied snapshot, and an empty repository lists none, as [] or null", async () => {
    const s = scripted();
    await s.rt.createVolume("src", {});
    const engine = new ResticEngine({ dataDir: s.dataDir });
    await engine.backup(s.host, "src", ["ck_abc"]);

    s.next(
      "snapshots",
      listed([
        { id: COPIED, tags: ["ck_abc"], original: SNAPSHOT },
        { id: SECOND, tags: ["ck_abc"] },
      ]),
    );
    expect(await engine.tagged(s.host, "ck_abc")).toEqual([
      { id: COPIED, tags: ["ck_abc"], original: SNAPSHOT },
      { id: SECOND, tags: ["ck_abc"], original: null },
    ]);

    s.next("snapshots", { exitCode: 0, logs: "[]\n" });
    expect(await engine.tagged(s.host, "ck_abc")).toEqual([]);
    s.next("snapshots", { exitCode: 0, logs: "null\n" });
    expect(await engine.tagged(s.host, "ck_abc")).toEqual([]);
  });

  test("a snapshots listing that is not a list is a failure", async () => {
    const s = scripted();
    await s.rt.createVolume("src", {});
    const engine = new ResticEngine({ dataDir: s.dataDir });
    await engine.backup(s.host, "src", ["ck_abc"]);

    s.next("snapshots", { exitCode: 0, logs: '{"id":"not a list"}' });
    expect(await rejectionOf(engine.tagged(s.host, "ck_abc"))).toMatchObject({ kind: "engine" });
  });

  test("a package whose origin the repository already holds is refused with SnapshotHeld, before restic copies anything", async () => {
    const s = scripted();
    await s.rt.createVolume("src", {});
    const engine = new ResticEngine({ dataDir: s.dataDir });
    await engine.backup(s.host, "src", ["ck_abc"]);
    const file = packageFile(s.dataDir, [PACKED]);
    s.next("snapshots", listed([{ id: PACKED, tags: ["ck_abc"], original: SNAPSHOT }]));
    const opened = await engine.open(s.host, file, PASSPHRASE);
    s.next("snapshots", listed([{ id: SNAPSHOT, tags: ["ck_abc"] }]));

    s.helpers.length = 0;
    expect(await rejectionOf(opened.unpack([PACKED]))).toBeInstanceOf(SnapshotHeld);
    expect(commandsOf(s.helpers)).toEqual(["snapshots"]);
    await opened.close();
  });

  test("unpacking copies each package snapshot in, and maps it to the copy restic wrote", async () => {
    const s = scripted();
    await s.rt.createVolume("src", {});
    const engine = new ResticEngine({ dataDir: s.dataDir });
    await engine.backup(s.host, "src", ["ck_abc"]);
    const file = packageFile(s.dataDir, [PACKED]);
    s.next("snapshots", listed([{ id: PACKED, tags: ["ck_abc"], original: ORIGIN }]));
    const opened = await engine.open(s.host, file, PASSPHRASE);
    s.next("snapshots", listed([{ id: SNAPSHOT, tags: ["ck_abc"] }]));
    s.next(
      "snapshots",
      listed([
        { id: SNAPSHOT, tags: ["ck_abc"] },
        { id: COPIED, tags: ["ck_abc"], original: ORIGIN },
      ]),
    );

    s.helpers.length = 0;
    expect(await opened.unpack([PACKED])).toEqual(new Map([[PACKED, COPIED]]));
    expect(commandsOf(s.helpers)).toEqual(["snapshots", "copy", "snapshots"]);
    expect(s.helpers[1]?.cmd).toEqual(expect.arrayContaining(["copy", PACKED]));
    await opened.close();
  });

  test("a copy restic fails forgets the copies it left, and no other snapshot", async () => {
    const s = scripted();
    await s.rt.createVolume("src", {});
    const engine = new ResticEngine({ dataDir: s.dataDir });
    await engine.backup(s.host, "src", ["ck_abc"]);
    const file = packageFile(s.dataDir, [PACKED]);
    s.next("snapshots", listed([{ id: PACKED, tags: ["ck_abc"], original: ORIGIN }]));
    const opened = await engine.open(s.host, file, PASSPHRASE);
    s.next("snapshots", listed([{ id: SNAPSHOT, tags: ["ck_abc"] }]));
    s.next("copy", { exitCode: 1, logs: "Fatal: no space left on device" });
    s.next(
      "snapshots",
      listed([
        { id: SNAPSHOT, tags: ["ck_abc"] },
        { id: COPIED, tags: ["ck_abc"], original: ORIGIN },
      ]),
    );

    s.helpers.length = 0;
    const error = await rejectionOf(opened.unpack([PACKED]));
    expect(error).toMatchObject({ kind: "engine" });
    expect((error as Error).message).toContain("restic copy out of the package exited with status 1");
    expect(commandsOf(s.helpers)).toEqual(["snapshots", "copy", "snapshots", "forget"]);
    expect(s.helpers[3]?.cmd).toEqual(["--no-cache", "forget", COPIED, "--prune"]);
    await opened.close();
  });
});

/** A host with a local repository, so a copy has something to read from and a key to open it with. */
async function withLocalRepo(): Promise<{ s: Scripted; engine: ResticEngine; localKey: string }> {
  const s = scripted();
  await s.rt.createVolume("src", {});
  const engine = new ResticEngine({ dataDir: s.dataDir });
  await engine.backup(s.host, "src", ["ck_abc"]);
  const localKey = readFileSync(join(s.dataDir, "secrets", "checkpoint-repo.key"), "utf8").trim();
  s.helpers.length = 0;
  return { s, engine, localKey };
}

describe("ResticEngine remote copy", () => {
  const ACCESS_KEY = "AKIAEXAMPLE";
  const SECRET_KEY = "s3-secret-value";
  const REMOTE_PASSWORD = "a-remote-password-of-its-own";
  const SFTP_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----";
  const KNOWN_HOSTS = "[backup.example.com]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKnown";

  const s3Remote = (overrides: Partial<RemoteRepository> = {}): RemoteRepository => ({
    targetId: "tgt_0000000000000000",
    targetName: "archive",
    repository: "s3:https://s3.example.com/archive/minibox/local",
    password: REMOTE_PASSWORD,
    credentials: { kind: "s3", region: "us-east-1", accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    ...overrides,
  });

  const sftpRemote = (overrides: Partial<RemoteRepository> = {}): RemoteRepository => ({
    targetId: "tgt_1111111111111111",
    targetName: "nas",
    repository: "sftp://backup@backup.example.com:2222/checkpoints/local",
    password: REMOTE_PASSWORD,
    credentials: { kind: "sftp", port: 2222, privateKey: SFTP_KEY, knownHosts: KNOWN_HOSTS },
    ...overrides,
  });

  test("a missing remote repository is initialized, then copied into with both passwords as secret files", async () => {
    const { s, engine, localKey } = await withLocalRepo();
    s.next("cat", { exitCode: 10, logs: "Fatal: repository does not exist" });

    await engine.copyToRemote(s.host, s3Remote(), [SNAPSHOT]);

    expect(commandsOf(s.helpers)).toEqual(["cat", "init", "copy"]);
    expect(s.helpers[2]?.cmd).toEqual([
      "--no-cache",
      "-o",
      "s3.region=us-east-1",
      "--retry-lock",
      "5m",
      "copy",
      "--from-repo",
      "/repo",
      "--from-password-file",
      "/run/secrets/repo.key",
      SNAPSHOT,
    ]);
    for (const spec of s.helpers) {
      expect(spec.network).toBe(true);
      const secrets = new Map((spec.secrets ?? []).map((secret) => [secret.name, secret.value]));
      expect(secrets.get("remote.key")).toBe(REMOTE_PASSWORD);
      expect(secrets.get("repo.key")).toBe(localKey);
      expect(secrets.get("aws-credentials")).toBe(
        `[default]\naws_access_key_id = ${ACCESS_KEY}\naws_secret_access_key = ${SECRET_KEY}\n`,
      );
      expect(spec.env).toEqual([
        "RESTIC_PASSWORD_FILE=/run/secrets/remote.key",
        "RESTIC_REPOSITORY=s3:https://s3.example.com/archive/minibox/local",
        "HOME=/tmp",
        "AWS_SHARED_CREDENTIALS_FILE=/run/secrets/aws-credentials",
      ]);
    }
  });

  test("no credential reaches the helper's environment, which docker inspect would show", async () => {
    const { s, engine, localKey } = await withLocalRepo();
    s.next("cat", { exitCode: 12, logs: "Fatal: wrong password" });

    await rejectionOf(engine.copyToRemote(s.host, s3Remote(), [SNAPSHOT]));

    const env = JSON.stringify(s.helpers.map((spec) => spec.env ?? []));
    for (const secret of [ACCESS_KEY, SECRET_KEY, REMOTE_PASSWORD, localKey]) expect(env).not.toContain(secret);
    expect(env).not.toContain("AWS_ACCESS_KEY_ID");
    expect(env).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toContain("RESTIC_PASSWORD=");
  });

  test("a remote repository whose password does not open it is an error, and nothing is initialized over it", async () => {
    const { s, engine } = await withLocalRepo();
    s.next("cat", { exitCode: 12, logs: "Fatal: wrong password" });

    const error = await rejectionOf(engine.copyToRemote(s.host, s3Remote(), [SNAPSHOT]));
    expect(error).toMatchObject({ kind: "engine" });
    expect((error as Error).message).toContain("remote checkpoint repository password is wrong");
    expect(commandsOf(s.helpers)).toEqual(["cat"]);
  });

  test("an SFTP copy passes the private key and the pinned host key through sftp.args, as files", async () => {
    const { s, engine } = await withLocalRepo();

    await engine.copyToRemote(s.host, sftpRemote(), [SNAPSHOT]);

    expect(commandsOf(s.helpers)).toEqual(["cat", "copy"]);
    const copy = s.helpers[1];
    expect(copy?.cmd).toEqual([
      "--no-cache",
      "-o",
      "sftp.args=-i /run/secrets/sftp.key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/run/secrets/known_hosts -p 2222",
      "--retry-lock",
      "5m",
      "copy",
      "--from-repo",
      "/repo",
      "--from-password-file",
      "/run/secrets/repo.key",
      SNAPSHOT,
    ]);
    const secrets = new Map((copy?.secrets ?? []).map((secret) => [secret.name, secret.value]));
    expect(secrets.get("sftp.key")).toBe(SFTP_KEY);
    expect(secrets.get("known_hosts")).toBe(`${KNOWN_HOSTS}\n`);
    expect(copy?.env).not.toContain(SFTP_KEY);
    expect(copy?.env).toContain("RESTIC_REPOSITORY=sftp://backup@backup.example.com:2222/checkpoints/local");
  });

  test("an empty copy asks nothing of the remote", async () => {
    const { s, engine } = await withLocalRepo();
    await engine.copyToRemote(s.host, s3Remote(), []);
    expect(s.helpers).toEqual([]);
  });

  test("a failed copy is an engine failure with restic's output, and forgets nothing anywhere", async () => {
    const { s, engine } = await withLocalRepo();
    s.next("copy", { exitCode: 1, logs: "Fatal: unable to open the remote repository" });

    const error = await rejectionOf(engine.copyToRemote(s.host, s3Remote(), [SNAPSHOT]));
    expect(error).toMatchObject({ kind: "engine" });
    expect((error as Error).message).toContain("restic copy to the remote checkpoint repository exited with status 1");
    expect(commandsOf(s.helpers)).toEqual(["cat", "copy"]);
  });
});

/** The local checkpoint volume calls a remote-only host must never make. */
const repoVolumeCalls = (s: Scripted) =>
  s.rt
    .callsTo("createVolume")
    .concat(s.rt.callsTo("inspectVolume"))
    .filter((call) => call.args[0] === REPO_VOLUME);

describe("ResticEngine with a host that keeps its checkpoints only on the remote", () => {
  const ACCESS_KEY = "AKIAONLY";
  const SECRET_KEY = "a-secret-key-for-the-only-mode";
  const REMOTE_PASSWORD = "the-only-repository-password";
  const SFTP_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nonly mode\n-----END OPENSSH PRIVATE KEY-----";
  const KNOWN_HOSTS = "[backup.example.com]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOnlyMode";

  const remoteRepository = (overrides: Partial<RemoteRepository> = {}): RemoteRepository => ({
    targetId: "tgt_2222222222222222",
    targetName: "archive",
    repository: "s3:https://s3.example.com/archive/only/local",
    password: REMOTE_PASSWORD,
    credentials: { kind: "s3", region: "us-east-1", accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    ...overrides,
  });

  const sftpRepository = (): RemoteRepository =>
    remoteRepository({
      targetId: "tgt_3333333333333333",
      targetName: "nas",
      repository: "sftp://backup@backup.example.com:2222/only/local",
      credentials: { kind: "sftp", port: 2222, privateKey: SFTP_KEY, knownHosts: KNOWN_HOSTS },
    });

  /** A host whose only repository is `remote`, with its source volume made and the setup's own volume calls forgotten. */
  async function onlyRemote(remote: RemoteRepository = remoteRepository(), now?: () => number) {
    const s = scripted();
    await s.rt.createVolume("src", {});
    const engine = new ResticEngine({ dataDir: s.dataDir, ...(now ? { now } : {}) });
    engine.bindRemotes(async (hostId) => (hostId === s.host.host.id ? remote : null));
    s.rt.calls.length = 0;
    return { s, engine, remote };
  }

  test("a backup opens the remote, never mounts or creates the local volume, and writes with the bounded lock wait", async () => {
    const { s, engine } = await onlyRemote();

    const result = await engine.backup(s.host, "src", ["ck_only"]);

    expect(result).toEqual({ snapshotId: SNAPSHOT, bytes: 4096 });
    expect(commandsOf(s.helpers)).toEqual(["cat", "init", "backup"]);
    const backup = s.helpers[2];
    expect(backup?.cmd).toEqual([
      "--no-cache",
      "-o",
      "s3.region=us-east-1",
      "--retry-lock",
      "5m",
      "backup",
      "/data",
      "--json",
      "--host",
      "local",
      "--tag",
      "ck_only",
    ]);
    // Only the box's own volume is mounted: there is no local checkpoint repository to mount.
    expect(backup?.mounts).toEqual([{ source: "src", target: "/data", mode: "ro" }]);
    expect(backup?.network).toBe(true);
    for (const spec of s.helpers) {
      const secrets = new Map((spec.secrets ?? []).map((secret) => [secret.name, secret.value]));
      expect(secrets.get("remote.key")).toBe(REMOTE_PASSWORD);
      expect(secrets.get("aws-credentials")).toBe(
        `[default]\naws_access_key_id = ${ACCESS_KEY}\naws_secret_access_key = ${SECRET_KEY}\n`,
      );
      expect(spec.env).toEqual([
        "RESTIC_PASSWORD_FILE=/run/secrets/remote.key",
        "RESTIC_REPOSITORY=s3:https://s3.example.com/archive/only/local",
        "HOME=/tmp",
        "AWS_SHARED_CREDENTIALS_FILE=/run/secrets/aws-credentials",
      ]);
      expect((spec.mounts ?? []).some((mount) => mount.source === REPO_VOLUME)).toBe(false);
      expect(spec.network).toBe(true);
    }
    expect(s.rt.volumes.has(REPO_VOLUME)).toBe(false);
    expect(repoVolumeCalls(s)).toEqual([]);
    const env = JSON.stringify(s.helpers.map((spec) => spec.env ?? []));
    for (const secret of [ACCESS_KEY, SECRET_KEY, REMOTE_PASSWORD]) expect(env).not.toContain(secret);
    expect(env).not.toContain("AWS_ACCESS_KEY_ID");
    expect(env).not.toContain("RESTIC_PASSWORD=");
  });

  test("restore, forget, stats and snapshots all use the remote, and only writes wait for a lock", async () => {
    const { s, engine } = await onlyRemote();
    await engine.backup(s.host, "src", ["ck_only"]);
    await s.rt.createVolume("dst", {});
    s.helpers.length = 0;
    s.next("snapshots", { exitCode: 0, logs: JSON.stringify([{ id: SNAPSHOT, tags: ["ck_only"] }]) });
    s.next("stats", { exitCode: 0, logs: '{"total_size":1234}' });

    await engine.restore(s.host, SNAPSHOT, "dst");
    await engine.forget(s.host, SNAPSHOT);
    expect(await engine.usage(s.host)).toEqual({ bytes: 1234 });
    expect(await engine.tagged(s.host, "ck_only")).toEqual([{ id: SNAPSHOT, tags: ["ck_only"], original: null }]);

    expect(commandsOf(s.helpers)).toEqual(["restore", "forget", "stats", "snapshots"]);
    const [restore, forget, stats, snapshots] = s.helpers;
    expect(restore?.mounts).toEqual([{ source: "dst", target: "/dst", mode: "rw" }]);
    expect(restore?.cmd).not.toContain("--retry-lock");
    expect(forget?.mounts).toEqual([]);
    expect(forget?.cmd).toEqual([
      "--no-cache",
      "-o",
      "s3.region=us-east-1",
      "--retry-lock",
      "5m",
      "forget",
      SNAPSHOT,
      "--prune",
    ]);
    expect(stats?.cmd).not.toContain("--retry-lock");
    expect(snapshots?.cmd).not.toContain("--retry-lock");
    for (const spec of [restore, forget, stats, snapshots]) {
      expect(spec?.network).toBe(true);
      expect((spec?.mounts ?? []).some((mount) => mount.source === REPO_VOLUME)).toBe(false);
    }
    expect(repoVolumeCalls(s)).toEqual([]);
  });

  test("an SFTP remote-only backup passes the private key and the known_hosts line as files", async () => {
    const { s, engine } = await onlyRemote(sftpRepository());

    await engine.backup(s.host, "src", []);

    expect(commandsOf(s.helpers)).toEqual(["cat", "init", "backup"]);
    for (const spec of s.helpers) {
      expect(spec.network).toBe(true);
      expect((spec.mounts ?? []).some((mount) => mount.source === REPO_VOLUME)).toBe(false);
      const secrets = new Map((spec.secrets ?? []).map((secret) => [secret.name, secret.value]));
      expect(secrets.get("sftp.key")).toBe(SFTP_KEY);
      expect(secrets.get("known_hosts")).toBe(`${KNOWN_HOSTS}\n`);
      expect(spec.env).toEqual([
        "RESTIC_PASSWORD_FILE=/run/secrets/remote.key",
        "RESTIC_REPOSITORY=sftp://backup@backup.example.com:2222/only/local",
        "HOME=/tmp",
      ]);
      expect((spec.env ?? []).join("\n")).not.toContain(SFTP_KEY);
    }
    expect(s.helpers[2]?.cmd).toEqual([
      "--no-cache",
      "-o",
      "sftp.args=-i /run/secrets/sftp.key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/run/secrets/known_hosts -p 2222",
      "--retry-lock",
      "5m",
      "backup",
      "/data",
      "--json",
      "--host",
      "local",
    ]);
  });

  test("usage is cached for ten minutes, and a backup or a forget clears the reading", async () => {
    let clock = 1_000_000;
    const { s, engine } = await onlyRemote(remoteRepository(), () => clock);
    await engine.backup(s.host, "src", []);
    s.next("stats", { exitCode: 0, logs: '{"total_size":10}' });
    s.next("stats", { exitCode: 0, logs: '{"total_size":20}' });
    const stats = () => commandsOf(s.helpers).filter((command) => command === "stats").length;

    expect(await engine.usage(s.host)).toEqual({ bytes: 10 });
    expect(await engine.usage(s.host)).toEqual({ bytes: 10 });
    expect(stats()).toBe(1);

    clock += 10 * 60 * 1000;
    expect(await engine.usage(s.host)).toEqual({ bytes: 20 });
    expect(stats()).toBe(2);

    await engine.backup(s.host, "src", []);
    s.next("stats", { exitCode: 0, logs: '{"total_size":30}' });
    expect(await engine.usage(s.host)).toEqual({ bytes: 30 });
    expect(stats()).toBe(3);

    await engine.forget(s.host, SECOND);
    s.next("stats", { exitCode: 0, logs: '{"total_size":40}' });
    expect(await engine.usage(s.host)).toEqual({ bytes: 40 });
    expect(stats()).toBe(4);
  });

  test("a remote repository that does not exist reports zero usage and is not created", async () => {
    const { s, engine } = await onlyRemote();
    s.next("cat", { exitCode: 10, logs: "Fatal: repository does not exist" });

    expect(await engine.usage(s.host)).toEqual({ bytes: 0 });
    expect(commandsOf(s.helpers)).toEqual(["cat"]);
    expect(repoVolumeCalls(s)).toEqual([]);
    expect(s.rt.volumes.has(REPO_VOLUME)).toBe(false);
  });

  test("switching a host to remote-only probes the new repository instead of trusting the local one's state", async () => {
    const s = scripted();
    await s.rt.createVolume("src", {});
    const engine = new ResticEngine({ dataDir: s.dataDir });
    await engine.backup(s.host, "src", ["ck_local"]);
    expect(commandsOf(s.helpers)).toEqual(["cat", "init", "backup"]);
    s.helpers.length = 0;
    s.rt.calls.length = 0;

    engine.bindRemotes(async () => remoteRepository());
    // The scripted `cat` answers for whatever repository is asked, so a missing remote is stated here: only a probe that
    // actually runs sees it, and only then is the remote initialized.
    s.next("cat", { exitCode: 10, logs: "Fatal: repository does not exist" });
    await engine.backup(s.host, "src", ["ck_only"]);

    // The local repository's `cat config` was cached under another key, so the remote is opened and initialized again.
    expect(commandsOf(s.helpers)).toEqual(["cat", "init", "backup"]);
    expect(repoVolumeCalls(s)).toEqual([]);
    expect(s.rt.volumes.has(REPO_VOLUME)).toBe(true);
  });

  test("an export copies from the remote repository, with its options and password file", async () => {
    const { s, engine } = await onlyRemote();
    s.next("cat", { exitCode: 0, logs: "{}" });
    // The manifest write is stopped after the copy, which is the call this test is about.
    s.next("backup", { exitCode: 1, logs: "Fatal: no space left on device" });
    const file = join(s.dataDir, "only.mbckpt");

    await rejectionOf(
      engine.pack(s.host, { snapshotIds: [SNAPSHOT], manifest: "{}", passphrase: PASSPHRASE }, file, 1024 * 1024),
    );

    const copy = s.helpers.find((spec) => spec.cmd.includes("copy"));
    expect(copy?.cmd).toEqual([
      "--no-cache",
      "-o",
      "s3.region=us-east-1",
      "copy",
      "--from-repo",
      "s3:https://s3.example.com/archive/only/local",
      "--from-password-file",
      "/run/secrets/remote.key",
      SNAPSHOT,
    ]);
    expect(copy?.network).toBe(true);
    expect((copy?.mounts ?? []).some((mount) => mount.source === REPO_VOLUME)).toBe(false);
    expect(copy?.env).toEqual([
      "RESTIC_PASSWORD_FILE=/run/secrets/package.key",
      "RESTIC_REPOSITORY=/pkg/repo",
      "HOME=/tmp",
      "AWS_SHARED_CREDENTIALS_FILE=/run/secrets/aws-credentials",
    ]);
    const secrets = new Map((copy?.secrets ?? []).map((secret) => [secret.name, secret.value]));
    expect(secrets.get("remote.key")).toBe(REMOTE_PASSWORD);
    expect(secrets.get("package.key")).toBe(PASSPHRASE);
    expect(repoVolumeCalls(s)).toEqual([]);
  });

  test("copying into a remote-only repository is refused as unnecessary", async () => {
    const { s, engine, remote } = await onlyRemote();

    const error = await rejectionOf(engine.copyToRemote(s.host, remote, [SNAPSHOT]));

    expect(error).toMatchObject({ kind: "engine" });
    expect((error as Error).message).toContain("only on the remote");
    expect(s.helpers).toEqual([]);
  });

  test("checking a remote opens it and creates it only when it does not exist", async () => {
    const { s, engine, remote } = await onlyRemote();
    s.next("cat", { exitCode: 10, logs: "Fatal: repository does not exist" });

    await engine.checkRemote(s.host, remote);

    expect(commandsOf(s.helpers)).toEqual(["cat", "init"]);
    for (const spec of s.helpers) {
      expect(spec.network).toBe(true);
      expect((spec.mounts ?? []).some((mount) => mount.source === REPO_VOLUME)).toBe(false);
    }
    expect(s.helpers[1]?.cmd).toEqual(["--no-cache", "-o", "s3.region=us-east-1", "--retry-lock", "5m", "init"]);

    s.helpers.length = 0;
    s.next("cat", { exitCode: 12, logs: "Fatal: wrong password" });
    const wrong = await rejectionOf(engine.checkRemote(s.host, remote));
    expect((wrong as Error).message).toContain("password is wrong");
  });
});
