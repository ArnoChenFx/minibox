/**
 * A box's self token on a real engine. The file reaches the box as a 0600 file its dev user owns, and the token never
 * enters the writable layer or the container's configuration. A stop ends the token, a start issues a new one, and a
 * delete ends it too. A write that goes beneath the tmpfs mount would leave the file hidden from the box, so this file
 * is what catches that.
 *
 *   bun run test:docker
 *
 * That script (scripts/docker-integration.ts) pulls the image, picks a fresh label prefix and sweeps what the run left
 * behind. To run this file directly:
 * MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbit<id> bun test tests/docker-self-token.test.ts
 *
 * Optional: DOCKER_SOCKET (default /var/run/docker.sock) and MINIBOX_TEST_IMAGE (default alpine:3.20). The image must
 * already be present locally. The prefix must start with "mbit", so the cleanup can never touch a real MiniBox install.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Docker from "dockerode";

import { createDockerRuntime } from "../src/docker/runtime";
import { createLocalHost, type HostCtx } from "../src/host/registry";
import type { Runtime } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { silenceLogs, testConfig } from "./support/app";

const enabled = process.env.MINIBOX_TEST_DOCKER === "1";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const IMAGE = process.env.MINIBOX_TEST_IMAGE ?? "alpine:3.20";
const LONG = 120_000;
const TOKEN_PATH = "/run/minibox/self-token";
const TOKEN_SHAPE = /^mbx_[A-Za-z0-9_-]{43}$/;

const PREFIX_PATTERN = /^mbit[a-z0-9-]{3,40}$/;
const prefix = process.env.MINIBOX_TEST_PREFIX ?? `mbit${Date.now().toString(36)}`;
if (enabled && !PREFIX_PATTERN.test(prefix)) throw new Error(`MINIBOX_TEST_PREFIX must match ${PREFIX_PATTERN}`);
const runtime: Runtime = createDockerRuntime(SOCKET);
const docker = new Docker({ socketPath: SOCKET });

/** Runs a shell snippet inside a box as `user` and returns what it printed, trimmed. */
async function run(id: string, user: string, script: string): Promise<string> {
  const session = await runtime.startExec(id, {
    cmd: ["/bin/sh", "-c", script],
    env: [],
    workingDir: "/",
    tty: false,
    user,
  });
  session.stream.end();
  let out = "";
  for await (const chunk of session.stdout) out += String(chunk);
  return out.trim();
}

/** The token file as the box's dev user sees it: its mode, owner and group, and the token it holds. */
async function readTokenFile(id: string): Promise<{ facts: string; secret: string }> {
  const facts = await run(id, "1000:1000", `stat -c '%a %u %g' ${TOKEN_PATH}`);
  const secret = await run(id, "1000:1000", `cat ${TOKEN_PATH}`);
  return { facts, secret };
}

describe.skipIf(!enabled)("a self token against a real engine", () => {
  let dataDir = "";
  let host: HostCtx;
  let restoreLogs: () => void;

  const createSelfBox = (name: string) =>
    boxes.createBox(host, { name, image: IMAGE, cpus: 0.5, memoryMb: 64, createdBy: "tester", selfToken: true });

  beforeAll(() => {
    restoreLogs = silenceLogs();
    dataDir = mkdtempSync(join(tmpdir(), "minibox-self-token-docker-"));
    host = createLocalHost(
      testConfig({ labelPrefix: prefix, dockerSocket: SOCKET, baseTemplateTag: IMAGE, dataDir }),
      runtime,
    );
  });

  afterAll(async () => {
    for (const c of await runtime.listContainers({ labels: { [host.prefix]: "true" } })) {
      await runtime.removeContainer(c.id, { force: true }).catch(() => {});
    }
    const { Volumes } = await docker.listVolumes();
    for (const volume of Volumes ?? []) {
      if (volume.Labels?.[host.prefix] === "true" || volume.Name.startsWith(`${host.prefix}-`)) {
        await docker
          .getVolume(volume.Name)
          .remove()
          .catch(() => {});
      }
    }
    await docker
      .getNetwork(host.security.network)
      .remove()
      .catch(() => {});
    restoreLogs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test(
    "the token reaches the box as a 0600 file its dev user owns, and never enters the writable layer or the container config",
    async () => {
      const box = await createSelfBox("token-src");
      const { facts, secret } = await readTokenFile(box.id);
      expect(facts).toBe("600 1000 1000");
      expect(secret).toMatch(TOKEN_SHAPE);
      expect(host.selfTokens.authenticate(secret)?.id).toBe(box.boxId);

      const changes = await runtime.containerDiff(box.id);
      expect(changes.map((change) => change.path)).not.toContain(TOKEN_PATH);
      expect(JSON.stringify(await docker.getContainer(box.id).inspect())).not.toContain(secret);
    },
    LONG,
  );

  test(
    "a stop ends the token, a start issues a new one, and a delete ends that one too",
    async () => {
      const box = await createSelfBox("token-life");
      const { secret: first } = await readTokenFile(box.id);

      await boxes.stopBox(host, box.boxId);
      expect(host.selfTokens.authenticate(first)).toBeNull();

      await boxes.startBox(host, box.boxId);
      const { facts, secret: second } = await readTokenFile(box.id);
      expect(facts).toBe("600 1000 1000");
      expect(second).toMatch(TOKEN_SHAPE);
      expect(second).not.toBe(first);
      expect(host.selfTokens.authenticate(second)?.id).toBe(box.boxId);

      await boxes.deleteBox(host, box.boxId, true);
      expect(host.selfTokens.authenticate(second)).toBeNull();
    },
    LONG,
  );
});
