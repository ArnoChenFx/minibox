import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Copies checkpoints from the local restic repository to a remote repository, on a real engine: an S3 bucket served by
 * s3proxy in a container, and an SFTP folder served by its SFTP double, both reachable from the restic helper over the
 * Docker bridge. It covers what only the real engine can: the copy crossing two repositories with different passwords,
 * the S3 credentials file, the pinned known_hosts line, and that a copy adds snapshots without ever removing one.
 *
 *   bun run test:docker
 *
 * To run this file directly: MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbit<id> bun test tests/docker-checkpoint-remote.test.ts
 *
 * The machine must run Linux, so the bridge gateway address can be published. Optional: DOCKER_SOCKET (default
 * /var/run/docker.sock) and MINIBOX_TEST_IMAGE (default alpine:3.20), which must already be present locally. The S3
 * service and the one-shot CLI that creates its bucket are pulled from the digests in `tests/support/s3proxy.ts`.
 */
import { S3Client } from "bun";
import Docker from "dockerode";
import { utils } from "ssh2";

import type { RemoteRepository } from "../src/checkpoints/remote";
import { knownHostsLine, s3Repository } from "../src/checkpoints/remote";
import { ResticEngine } from "../src/checkpoints/restic";
import { createDockerRuntime } from "../src/docker/runtime";
import { createLocalHost, type HostCtx } from "../src/host/registry";
import { probePublicKey, publicKeyTextOf } from "../src/host/ssh";
import type { Runtime } from "../src/runtime";
import { rejectionOf, silenceLogs, testConfig } from "./support/app";
import { createS3Bucket, type S3Proxy, type S3ServiceOptions, startS3Proxy } from "./support/s3proxy";
import { newEd25519Key, startSftpDouble } from "./support/sftp-double";

const enabled = process.env.MINIBOX_TEST_DOCKER === "1";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const IMAGE = process.env.MINIBOX_TEST_IMAGE ?? "alpine:3.20";
const LONG = 180_000;
const PREFIX_PATTERN = /^mbit[a-z0-9-]{3,40}$/;
const prefix = process.env.MINIBOX_TEST_PREFIX ?? `mbit${Date.now().toString(36)}`;
if (enabled && !PREFIX_PATTERN.test(prefix)) throw new Error(`MINIBOX_TEST_PREFIX must match ${PREFIX_PATTERN}`);
const runtime: Runtime = createDockerRuntime(SOCKET);
const docker = new Docker({ socketPath: SOCKET });
const ACCESS_KEY = "AKIADOCKERTEST";
const SECRET_KEY = "docker-test-secret-key";
const REMOTE_PASSWORD = "the remote repository's own password";
const BUCKET = "archive";
const REGION = "us-east-1";
const PACKAGE_TAG = "ck_only_pack";
/** 包里的 manifest 对引擎只是文本：它被存成包里的一个快照，导入方再读回来。 */
const PACKAGE_MANIFEST = '{"from":"a remote-only host","note":"the package round trip"}';
const PACKAGE_PASSPHRASE = "the package's own passphrase";

const dataDir = mkdtempSync(join(tmpdir(), "minibox-docker-remote-"));
const host: HostCtx = createLocalHost(testConfig({ dataDir, labelPrefix: prefix }), runtime);
const restoreLogs = silenceLogs();

/** The bridge gateway, which is this machine as a container sees it. */
async function bridgeGateway(): Promise<string> {
  const network = await docker.getNetwork("bridge").inspect();
  const gateway = network.IPAM?.Config?.[0]?.Gateway;
  if (!gateway) throw new Error("the bridge network reports no gateway");
  return gateway;
}

/** Writes one small file into a volume, so a snapshot has something to hold. */
async function seed(volume: string): Promise<void> {
  await runtime.createVolume(volume, { [host.keys.internal]: "true" });
  const result = await runtime.runHelper({
    image: IMAGE,
    cmd: ["sh", "-c", "echo 'hello from the remote test' > /data/notes.txt"],
    mounts: [{ source: volume, target: "/data", mode: "rw" }],
    labels: { [host.keys.internal]: "true" },
    timeoutSec: 60,
  });
  if (result.exitCode !== 0) throw new Error(`could not seed ${volume}: ${result.logs}`);
}

/** The contents of one file in a volume, read through a helper. */
async function readFile(volume: string, name: string): Promise<string> {
  const result = await runtime.runHelper({
    image: IMAGE,
    cmd: ["cat", `/data/${name}`],
    mounts: [{ source: volume, target: "/data", mode: "ro" }],
    labels: { [host.keys.internal]: "true" },
    timeoutSec: 60,
  });
  if (result.exitCode !== 0) throw new Error(`could not read ${name} from ${volume}: ${result.logs}`);
  return result.logs;
}

/** A host whose only checkpoint repository is `remote`, with an engine that answers for it alone. */
function onlyHostOf(id: string, remote: RemoteRepository): HostCtx {
  const engine = new ResticEngine({ dataDir });
  engine.bindRemotes(async (hostId) => (hostId === id ? remote : null));
  return createLocalHost(
    testConfig({ dataDir, labelPrefix: prefix }),
    runtime,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      id,
      name: id,
      checkpointEngine: engine,
    },
  );
}

/** Every file under a folder, as paths relative to it. */
function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const nested of filesUnder(path)) found.push(`${entry.name}/${nested}`);
    } else {
      found.push(entry.name);
    }
  }
  return found;
}

/** Every key under a prefix, as the S3 service lists them. */
async function listKeys(client: S3Client, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await client.list({ prefix, continuationToken, maxKeys: 1000 });
    for (const item of page.contents ?? []) if (item.key !== undefined) keys.push(item.key);
    continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (continuationToken !== undefined);
  return keys;
}

/** Waits for the service's metrics to show a matching request. */
async function untilMetric(proxy: S3Proxy, pattern: RegExp, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (pattern.test(await proxy.metrics())) return;
    } catch {
      // The metrics port may not answer yet.
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}

/** 现有 S3 用例共用的服务参数：运行前缀、固定的测试凭据与桶名。 */
function s3Service(gateway: string): S3ServiceOptions {
  return {
    docker,
    runtime,
    gateway,
    prefix,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    bucket: BUCKET,
  };
}

/** 本前缀下包的暂存卷：包写完后打开、关闭的整个过程结束就该一个不剩。 */
async function packageVolumes(): Promise<string[]> {
  const { Volumes } = await docker.listVolumes();
  return (Volumes ?? [])
    .map((volume) => volume.Name)
    .filter((name) => name.startsWith(prefix) && name.includes("-package-"));
}

/**
 * 在一台仅异地的宿主机上打包一个快照，再到另一台仅异地的宿主机上打开、解包、还原。
 * 两台都没有本地仓库，所以这覆盖了 `pack` 以远端为源（`--from-repo`、远端口令文件、目标的 `-o` 选项与凭据文件）
 * 和 `unpack` 以远端为目标（`--retry-lock`、`init`）。
 */
async function packageRoundTrip(a: HostCtx, b: HostCtx, source: string, target: string, file: string): Promise<void> {
  await seed(source);
  const snapshotId = (await a.checkpointEngine.backup(a, source, [PACKAGE_TAG])).snapshotId;
  await a.checkpointEngine.pack(
    a,
    { snapshotIds: [snapshotId], manifest: PACKAGE_MANIFEST, passphrase: PACKAGE_PASSPHRASE },
    file,
    64 * 1024 * 1024,
  );
  expect(statSync(file).size).toBeGreaterThan(0);

  const opened = await b.checkpointEngine.open(b, file, PACKAGE_PASSPHRASE);
  const packaged = opened.snapshots.filter((snapshot) => snapshot.tags.includes(PACKAGE_TAG));
  expect(packaged).toHaveLength(1);
  const packagedId = packaged[0]?.id;
  if (!packagedId) throw new Error("the package holds no snapshot carrying the tag");
  const copies = await opened.unpack([packagedId]);
  await opened.close();
  expect(await packageVolumes()).toEqual([]);

  // 用 tagged 找回新快照：它的 origin 仍是第一台宿主机仓库里那个快照，说明链没有断。
  const found = await b.checkpointEngine.tagged(b, PACKAGE_TAG);
  expect(found.map((snapshot) => snapshot.original)).toEqual([snapshotId]);
  const copied = found[0]?.id;
  if (!copied) throw new Error("the imported snapshot is not in the second repository");
  expect(copies.get(packagedId)).toBe(copied);

  await seed(target);
  await b.checkpointEngine.restore(b, copied, target);
  expect(await readFile(target, "notes.txt")).toBe("hello from the remote test\n");
}

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  restoreLogs();
});

describe.skipIf(!enabled)("checkpoint remote copy against a real engine", () => {
  test(
    "restic copies to an S3 repository with credentials from a file, and a second copy or a local forget removes nothing",
    async () => {
      const gateway = await bridgeGateway();
      const service = {
        docker,
        runtime,
        gateway,
        prefix,
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET_KEY,
        bucket: BUCKET,
      };
      const volume = `${prefix}-s3-src`;
      await seed(volume);
      const snapshotId = (await host.checkpointEngine.backup(host, volume, ["ck_remote"])).snapshotId;
      let proxy: S3Proxy | null = null;
      try {
        proxy = await startS3Proxy(service);
        await createS3Bucket({ ...service, endpoint: proxy.endpoint });
        const client = new S3Client({
          accessKeyId: ACCESS_KEY,
          secretAccessKey: SECRET_KEY,
          endpoint: proxy.endpoint,
          region: REGION,
          bucket: BUCKET,
          virtualHostedStyle: false,
          retry: 3,
        });
        const remote: RemoteRepository = {
          targetId: "tgt_0000000000000000",
          targetName: "archive",
          repository: s3Repository(proxy.endpoint, BUCKET, "repo/local"),
          password: REMOTE_PASSWORD,
          credentials: { kind: "s3", region: REGION, accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
        };
        const keys = () => listKeys(client, "repo/local/");

        await host.checkpointEngine.copyToRemote(host, remote, [snapshotId]);
        expect(await keys()).toEqual(expect.arrayContaining(["repo/local/config"]));
        await untilMetric(proxy, /s3_operation="PutObject"/, "the copy's object writes");
        expect(await proxy.metrics()).toContain('http_request_method="PUT"');
        const snapshots = (await keys()).filter((key) => key.startsWith("repo/local/snapshots/"));
        expect(snapshots).toHaveLength(1);
        // A snapshot object is encrypted, so its `original` cannot be read here. The second copy below shows the origin was
        // recorded: restic skips a snapshot whose origin the repository already holds, and the key set stays the same.

        const before = (await keys()).toSorted();
        await host.checkpointEngine.copyToRemote(host, remote, [snapshotId]);
        expect((await keys()).toSorted()).toEqual(before);

        await host.checkpointEngine.forget(host, snapshotId);
        expect((await keys()).toSorted()).toEqual(before);
      } finally {
        await proxy?.stop();
        await runtime.removeVolume(volume);
      }
    },
    LONG,
  );

  test(
    "restic copies to an SFTP repository with the private key and the pinned known_hosts line, and refuses another host key",
    async () => {
      const gateway = await bridgeGateway();
      const volume = `${prefix}-sftp-src`;
      await seed(volume);
      const snapshotId = (await host.checkpointEngine.backup(host, volume, ["ck_remote"])).snapshotId;
      const sftp = await startSftpDouble({ host: gateway });
      const presented = await probePublicKey(gateway, sftp.port);
      expect(presented.fingerprint).toBe(sftp.hostKeyFingerprint);
      const remote: RemoteRepository = {
        targetId: "tgt_1111111111111111",
        targetName: "nas",
        repository: `sftp://backup@${gateway}:${sftp.port}/repo/local`,
        password: REMOTE_PASSWORD,
        credentials: {
          kind: "sftp",
          port: sftp.port,
          privateKey: sftp.privateKey,
          knownHosts: knownHostsLine(gateway, sftp.port, presented.text),
        },
      };
      try {
        await host.checkpointEngine.copyToRemote(host, remote, [snapshotId]);
        const snapshots = filesUnder(join(sftp.root, "repo/local/snapshots"));
        expect(snapshots).toHaveLength(1);
        const before = filesUnder(join(sftp.root, "repo/local")).toSorted();
        await host.checkpointEngine.copyToRemote(host, remote, [snapshotId]);
        expect(filesUnder(join(sftp.root, "repo/local")).toSorted()).toEqual(before);

        const otherKey = utils.parseKey(newEd25519Key());
        if (otherKey instanceof Error) throw otherKey;
        const credentials = remote.credentials;
        if (credentials.kind !== "sftp") throw new Error("the remote is not an SFTP repository");
        const wrong: RemoteRepository = {
          ...remote,
          credentials: {
            ...credentials,
            knownHosts: knownHostsLine(gateway, sftp.port, publicKeyTextOf(otherKey.getPublicSSH())),
          },
        };
        const error = await rejectionOf(host.checkpointEngine.copyToRemote(host, wrong, [snapshotId]));
        expect((error as Error).message).toContain("Host key verification failed");
        expect(filesUnder(join(sftp.root, "repo/local")).toSorted()).toEqual(before);
      } finally {
        await sftp.close();
        await runtime.removeVolume(volume);
      }
    },
    LONG,
  );

  test(
    "a remote-only S3 host backs up, restores and forgets on the remote, and never creates a local checkpoint volume",
    async () => {
      const gateway = await bridgeGateway();
      const service = {
        docker,
        runtime,
        gateway,
        prefix,
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET_KEY,
        bucket: BUCKET,
      };
      let proxy: S3Proxy | null = null;
      const src = `${prefix}-only-s3-src`;
      const dst = `${prefix}-only-s3-dst`;
      try {
        proxy = await startS3Proxy(service);
        await createS3Bucket({ ...service, endpoint: proxy.endpoint });
        const remote: RemoteRepository = {
          targetId: "tgt_4444444444444444",
          targetName: "archive",
          repository: s3Repository(proxy.endpoint, BUCKET, "repo/only-s3"),
          password: REMOTE_PASSWORD,
          credentials: { kind: "s3", region: REGION, accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
        };
        const host = onlyHostOf("onlys3", remote);
        await seed(src);
        const snapshotId = (await host.checkpointEngine.backup(host, src, ["ck_only"])).snapshotId;

        expect((await host.checkpointEngine.tagged(host, "ck_only")).map((snapshot) => snapshot.id)).toEqual([
          snapshotId,
        ]);
        await seed(dst);
        await host.checkpointEngine.restore(host, snapshotId, dst);
        expect(await readFile(dst, "notes.txt")).toBe("hello from the remote test\n");

        await host.checkpointEngine.forget(host, snapshotId);
        expect(await host.checkpointEngine.tagged(host, "ck_only")).toEqual([]);
        await rejectionOf(runtime.inspectVolume(`${prefix}-checkpoints-onlys3`));
      } finally {
        await proxy?.stop();
        await runtime.removeVolume(src).catch(() => undefined);
        await runtime.removeVolume(dst).catch(() => undefined);
      }
    },
    LONG,
  );

  test(
    "a remote-only SFTP host backs up, restores and forgets on the remote, and never creates a local checkpoint volume",
    async () => {
      const gateway = await bridgeGateway();
      const sftp = await startSftpDouble({ host: gateway });
      const presented = await probePublicKey(gateway, sftp.port);
      const src = `${prefix}-only-sftp-src`;
      const dst = `${prefix}-only-sftp-dst`;
      try {
        const remote: RemoteRepository = {
          targetId: "tgt_5555555555555555",
          targetName: "nas",
          repository: `sftp://backup@${gateway}:${sftp.port}/repo/only-sftp`,
          password: REMOTE_PASSWORD,
          credentials: {
            kind: "sftp",
            port: sftp.port,
            privateKey: sftp.privateKey,
            knownHosts: knownHostsLine(gateway, sftp.port, presented.text),
          },
        };
        const host = onlyHostOf("onlysftp", remote);
        await seed(src);
        const snapshotId = (await host.checkpointEngine.backup(host, src, ["ck_only"])).snapshotId;

        expect((await host.checkpointEngine.tagged(host, "ck_only")).map((snapshot) => snapshot.id)).toEqual([
          snapshotId,
        ]);
        await seed(dst);
        await host.checkpointEngine.restore(host, snapshotId, dst);
        expect(await readFile(dst, "notes.txt")).toBe("hello from the remote test\n");

        await host.checkpointEngine.forget(host, snapshotId);
        expect(await host.checkpointEngine.tagged(host, "ck_only")).toEqual([]);
        expect(filesUnder(join(sftp.root, "repo/only-sftp/snapshots"))).toEqual([]);
        await rejectionOf(runtime.inspectVolume(`${prefix}-checkpoints-onlysftp`));
      } finally {
        await sftp.close();
        await runtime.removeVolume(src).catch(() => undefined);
        await runtime.removeVolume(dst).catch(() => undefined);
      }
    },
    LONG,
  );

  test(
    "a remote-only S3 host exports a package that a second remote-only host imports and restores",
    async () => {
      const gateway = await bridgeGateway();
      const service = s3Service(gateway);
      const source = `${prefix}-only-pack-s3-src`;
      const target = `${prefix}-only-pack-s3-dst`;
      const file = join(dataDir, "only-pack-s3.mbckpt");
      let proxy: S3Proxy | null = null;
      try {
        proxy = await startS3Proxy(service);
        await createS3Bucket({ ...service, endpoint: proxy.endpoint });
        const credentials = {
          kind: "s3" as const,
          region: REGION,
          accessKeyId: ACCESS_KEY,
          secretAccessKey: SECRET_KEY,
        };
        const sourceHost = onlyHostOf("onlys3packa", {
          targetId: "tgt_6666666666666666",
          targetName: "archive",
          repository: s3Repository(proxy.endpoint, BUCKET, "repo/only-pack-s3-a"),
          password: REMOTE_PASSWORD,
          credentials,
        });
        const targetHost = onlyHostOf("onlys3packb", {
          targetId: "tgt_7777777777777777",
          targetName: "archive",
          repository: s3Repository(proxy.endpoint, BUCKET, "repo/only-pack-s3-b"),
          password: REMOTE_PASSWORD,
          credentials,
        });

        await packageRoundTrip(sourceHost, targetHost, source, target, file);

        // 两台都只写远端：本地检查点卷从未被创建。
        await rejectionOf(runtime.inspectVolume(`${prefix}-checkpoints-onlys3packa`));
        await rejectionOf(runtime.inspectVolume(`${prefix}-checkpoints-onlys3packb`));
      } finally {
        await proxy?.stop();
        await runtime.removeVolume(source).catch(() => undefined);
        await runtime.removeVolume(target).catch(() => undefined);
      }
    },
    LONG,
  );

  test(
    "a remote-only SFTP host exports a package that a second remote-only host imports and restores",
    async () => {
      const gateway = await bridgeGateway();
      const sftp = await startSftpDouble({ host: gateway });
      const presented = await probePublicKey(gateway, sftp.port);
      const source = `${prefix}-only-pack-sftp-src`;
      const target = `${prefix}-only-pack-sftp-dst`;
      const file = join(dataDir, "only-pack-sftp.mbckpt");
      try {
        const credentials = {
          kind: "sftp" as const,
          port: sftp.port,
          privateKey: sftp.privateKey,
          knownHosts: knownHostsLine(gateway, sftp.port, presented.text),
        };
        const sourceHost = onlyHostOf("onlysftppacka", {
          targetId: "tgt_8888888888888888",
          targetName: "nas",
          repository: `sftp://backup@${gateway}:${sftp.port}/repo/only-pack-sftp-a`,
          password: REMOTE_PASSWORD,
          credentials,
        });
        const targetHost = onlyHostOf("onlysftppackb", {
          targetId: "tgt_9999999999999999",
          targetName: "nas",
          repository: `sftp://backup@${gateway}:${sftp.port}/repo/only-pack-sftp-b`,
          password: REMOTE_PASSWORD,
          credentials,
        });

        await packageRoundTrip(sourceHost, targetHost, source, target, file);

        await rejectionOf(runtime.inspectVolume(`${prefix}-checkpoints-onlysftppacka`));
        await rejectionOf(runtime.inspectVolume(`${prefix}-checkpoints-onlysftppackb`));
      } finally {
        await sftp.close();
        await runtime.removeVolume(source).catch(() => undefined);
        await runtime.removeVolume(target).catch(() => undefined);
      }
    },
    LONG,
  );
});
