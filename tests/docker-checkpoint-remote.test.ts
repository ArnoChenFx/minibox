import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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
import { createDockerRuntime } from "../src/docker/runtime";
import { createLocalHost, type HostCtx } from "../src/host/registry";
import { probePublicKey, publicKeyTextOf } from "../src/host/ssh";
import type { Runtime } from "../src/runtime";
import { rejectionOf, silenceLogs, testConfig } from "./support/app";
import { createS3Bucket, type S3Proxy, startS3Proxy } from "./support/s3proxy";
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
        const copy = JSON.parse(await client.file(snapshots[0] ?? "").text()) as { original?: string };
        expect(copy.original).toBe(snapshotId);

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
});
