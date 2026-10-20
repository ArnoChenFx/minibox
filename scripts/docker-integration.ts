/**
 * Runs the real-engine integration tests (tests/docker-runtime.test.ts) against the local Docker engine.
 *
 *   bun run test:docker
 *
 * Every run gets its own label prefix, so nothing it creates can be mistaken for a real install. Containers, images
 * and volumes that carry the prefix are removed afterwards, even when the tests fail.
 *
 * Environment: DOCKER_SOCKET (default /var/run/docker.sock), MINIBOX_TEST_IMAGE (default alpine:3.20).
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const socket = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const image = process.env.MINIBOX_TEST_IMAGE ?? "alpine:3.20";
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
  const present = await docker(["image", "inspect", image]).then(
    () => true,
    () => false,
  );
  if (!present) {
    console.log(`[docker-integration] pulling ${image}`);
    const pull = Bun.spawn(["docker", "-H", `unix://${socket}`, "pull", image], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await pull.exited) !== 0) throw new Error(`could not pull ${image}`);
  }
}

async function runTests(): Promise<number> {
  const tests = Bun.spawn([process.execPath, "test", "tests/docker-runtime.test.ts"], {
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
  return tests.exited;
}

/** Removes everything this run labelled, containers first so that images and volumes are no longer in use. */
async function sweep(): Promise<void> {
  const containers = lines(await docker(["ps", "-aq", "--filter", `label=${prefix}`]));
  if (containers.length > 0) await docker(["rm", "-f", ...containers]);

  const images = [
    ...lines(await docker(["images", "-q", "--filter", `label=${prefix}.snapshot`])),
    ...lines(await docker(["images", "-q", "--filter", `label=${prefix}.template`])),
  ];
  const uniqueImages = [...new Set(images)];
  if (uniqueImages.length > 0) await docker(["rmi", "-f", ...uniqueImages]);

  const volumes = lines(await docker(["volume", "ls", "-q", "--filter", `label=${prefix}`]));
  if (volumes.length > 0) await docker(["volume", "rm", ...volumes]);

  console.log(
    `[docker-integration] swept ${containers.length} containers, ${uniqueImages.length} images, ${volumes.length} volumes`,
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
