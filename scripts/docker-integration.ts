/**
 * Runs the real-engine integration tests (tests/docker-runtime.test.ts, tests/docker-checkpoint.test.ts,
 * tests/docker-sessions.test.ts, tests/docker-startup-command.test.ts, tests/docker-ssh.test.ts,
 * tests/docker-templates.test.ts, tests/docker-declared-templates.test.ts, tests/docker-tools.test.ts,
 * tests/docker-hosts.test.ts, tests/docker-move.test.ts, tests/docker-agent.test.ts, tests/docker-files.test.ts and
 * tests/docker-trash.test.ts, tests/docker-self-token.test.ts) against the local Docker engine, one file per process.
 *
 *   bun run test:docker
 *
 * Every run gets its own label prefix, so nothing it creates can be mistaken for a real install. Containers, images
 * and volumes labelled with the prefix, volumes named with it (the checkpoint repository is one), and networks named
 * with it are removed afterwards, even when the tests fail.
 *
 * Environment: DOCKER_SOCKET (default /var/run/docker.sock), MINIBOX_TEST_IMAGE (default alpine:3.20). The SSH test
 * builds its box image on debian:bookworm-slim, and the tools test builds its box from templates/base on
 * node:26-bookworm-slim. Those base images are pulled here too when the engine does not have them.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { RESTIC_IMAGE } from "../src/checkpoints/restic";

const ROOT = join(import.meta.dir, "..");
const socket = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const image = process.env.MINIBOX_TEST_IMAGE ?? "alpine:3.20";
const SSH_FIXTURE_BASE = "debian:bookworm-slim";
/** The FROM image of templates/base/Dockerfile. A build pulls it anyway, so this only moves the pull earlier. */
const TEMPLATE_BASE = "node:26-bookworm-slim";
const prefix = `mbit${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

const lines = (text: string) => [
  ...new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  ),
];

async function docker(args: string[]): Promise<string> {
  const proc = Bun.spawn(["docker", "-H", `unix://${socket}`, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`docker ${args.join(" ")} failed: ${err.trim()}`);
  return out;
}

/** Pulls an image unless the engine already has it. */
async function ensureImage(ref: string): Promise<void> {
  const present = await docker(["image", "inspect", ref]).then(
    () => true,
    () => false,
  );
  if (present) return;
  console.log(`[docker-integration] pulling ${ref}`);
  const pull = Bun.spawn(["docker", "-H", `unix://${socket}`, "pull", ref], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await pull.exited) !== 0) throw new Error(`could not pull ${ref}`);
}

async function preflight(): Promise<void> {
  try {
    await docker(["version", "--format", "{{.Server.Version}}"]);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `the Docker engine is not reachable at unix://${socket} (${reason}). Start Docker or set DOCKER_SOCKET.`,
      { cause: e },
    );
  }
  for (const ref of new Set([image, RESTIC_IMAGE, SSH_FIXTURE_BASE, TEMPLATE_BASE])) await ensureImage(ref);
}

const TEST_FILES = [
  "tests/docker-runtime.test.ts",
  "tests/docker-checkpoint.test.ts",
  "tests/docker-sessions.test.ts",
  "tests/docker-startup-command.test.ts",
  "tests/docker-ssh.test.ts",
  "tests/docker-templates.test.ts",
  "tests/docker-declared-templates.test.ts",
  "tests/docker-tools.test.ts",
  "tests/docker-hosts.test.ts",
  "tests/docker-move.test.ts",
  "tests/docker-agent.test.ts",
  "tests/docker-files.test.ts",
  "tests/docker-trash.test.ts",
  "tests/docker-self-token.test.ts",
];

/**
 * Runs each file in its own process and sweeps after it, so a file starts on an engine with nothing the file before it
 * left behind. A leftover volume with this prefix would be claimed by any host whose records do not know it. The first
 * failure is the status.
 */
async function runTests(): Promise<number> {
  let status = 0;
  for (const file of TEST_FILES) {
    const tests = Bun.spawn([process.execPath, "test", file], {
      cwd: ROOT,
      env: {
        ...process.env,
        MINIBOX_TEST_DOCKER: "1",
        MINIBOX_TEST_PREFIX: prefix,
        MINIBOX_TEST_IMAGE: image,
        DOCKER_SOCKET: socket,
      },
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await tests.exited;
    await sweep();
    if (code !== 0 && status === 0) status = code;
  }
  return status;
}

/** Removes everything this run made, containers first so that images and volumes are no longer in use. */
async function sweep(): Promise<void> {
  const containers = lines(await docker(["ps", "-aq", "--filter", `label=${prefix}`]));
  if (containers.length > 0) await docker(["rm", "-f", ...containers]);

  const images = [
    ...lines(await docker(["images", "-q", "--filter", `label=${prefix}.snapshot`])),
    ...lines(await docker(["images", "-q", "--filter", `label=${prefix}.template`])),
    ...lines(await docker(["images", "-q", "--filter", `label=${prefix}`])),
  ];
  const uniqueImages = [...new Set(images)];
  if (uniqueImages.length > 0) await docker(["rmi", "-f", ...uniqueImages]);

  const volumes = [
    ...new Set([
      ...lines(await docker(["volume", "ls", "-q", "--filter", `label=${prefix}`])),
      ...lines(await docker(["volume", "ls", "-q"])).filter((name) => name.startsWith(`${prefix}-`)),
    ]),
  ];
  if (volumes.length > 0) await docker(["volume", "rm", ...volumes]);

  const networks = lines(await docker(["network", "ls", "--format", "{{.Name}}"])).filter((name) =>
    name.startsWith(`${prefix}-`),
  );
  for (const network of networks) await docker(["network", "rm", network]);

  console.log(
    `[docker-integration] swept ${containers.length} containers, ${uniqueImages.length} images, ${volumes.length} volumes, ${networks.length} networks`,
  );
}

async function main(): Promise<number> {
  await preflight();
  console.log(`[docker-integration] prefix=${prefix} image=${image} socket=${socket}`);
  let status = 1;
  try {
    status = await runTests();
  } finally {
    await sweep();
    // A test process killed mid-run can leave a daemon operation, such as a snapshot commit, still finishing.
    if (status !== 0) {
      await Bun.sleep(5_000);
      await sweep();
    }
  }
  return status;
}

try {
  process.exitCode = await main();
} catch (e) {
  console.error(`[docker-integration] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
