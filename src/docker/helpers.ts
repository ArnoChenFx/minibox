import { randomBytes } from "node:crypto";

import Docker from "dockerode";

import { type Mount, type HelperSpec, HELPER_SECRETS_DIR, HELPER_SECRETS_LABEL, type Runtime } from "../runtime";
import { secretsArchive } from "./archive";
import { applyHardening } from "./containers";
import { within, call, type Engine } from "./engine";
import { demuxLogs } from "./logs";

/** Memory and process limits for a helper. Each helper runs one short command, so both are small. */
const HELPER_MEMORY_BYTES = 256 * 1024 * 1024;

const HELPER_PIDS_LIMIT = 64;

/** Scratch space for a helper's `/tmp`. Nothing is run from it. */
const HELPER_TMPFS = "rw,noexec,nosuid,nodev,size=16m";

function helperTmpfs(bytes: number | undefined): string {
  return bytes === undefined ? HELPER_TMPFS : `rw,noexec,nosuid,nodev,size=${bytes}`;
}

/**
 * Helper mounts use the Mounts form, and named volumes are NoCopy. Without it Docker copies the image's directory at the
 * target into an empty volume and takes that directory's owner and mode, so a helper at `/mnt` would reset a volume an
 * earlier helper had chowned.
 */
function helperMountOf(mount: Mount): Docker.MountSettings {
  const shared = { Target: mount.target, Source: mount.source, ReadOnly: mount.mode === "ro" };
  if (mount.kind === "bind") return { ...shared, Type: "bind" };
  // @types/dockerode also requires Labels and DriverConfig here; the engine accepts NoCopy alone.
  return { ...shared, Type: "volume", VolumeOptions: { NoCopy: true } } as Docker.MountSettings;
}

/**
 * The options for a helper container. It joins no network, has a read-only root filesystem and only the capabilities it
 * names, cannot gain privileges, and is capped on memory and processes. AutoRemove lets the engine delete it on exit.
 * It starts in `/`, not in the image's working directory, which can be a path on a volume the helper mounts.
 */
export function toHelperOptions(spec: HelperSpec, name: string): Docker.ContainerCreateOptions {
  const memory = spec.memoryBytes ?? HELPER_MEMORY_BYTES;
  const readonlyRoot = spec.readonlyRoot !== false;
  const hostConfig: Docker.HostConfig = {
    Mounts: (spec.mounts ?? []).map(helperMountOf),
    NetworkMode: spec.network ? "bridge" : "none",
    ReadonlyRootfs: readonlyRoot,
    Memory: memory,
    MemorySwap: memory,
    AutoRemove: true,
  };
  if (readonlyRoot) hostConfig.Tmpfs = { "/tmp": helperTmpfs(spec.tmpfsBytes) };
  applyHardening(hostConfig, {
    capDrop: ["ALL"],
    capAdd: spec.capAdd,
    noNewPrivileges: true,
    pidsLimit: spec.pidsLimit ?? HELPER_PIDS_LIMIT,
  });
  const opts: Docker.ContainerCreateOptions = {
    Image: spec.image,
    name,
    Cmd: spec.cmd,
    WorkingDir: "/",
    HostConfig: hostConfig,
  };
  if (spec.user !== undefined) opts.User = spec.user;
  if (spec.labels !== undefined) opts.Labels = spec.labels;
  if (spec.env !== undefined) opts.Env = spec.env;
  return opts;
}

async function readAll(stream: AsyncIterable<Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Exit code of a helper that ran past its timeout and was killed. */
const HELPER_TIMEOUT_EXIT = 124;

/** Longest a helper is waited for to exit after a kill, or to be removed after it exited. */
const HELPER_SETTLE_MS = 10_000;

async function exitCodeOf(
  container: Docker.Container,
  exited: Promise<{ StatusCode?: number }>,
  timeoutMs: number,
): Promise<number> {
  const status = await within(exited, timeoutMs);
  if (status) return status.StatusCode ?? 1;
  await container.kill().catch(() => undefined);
  await within(exited, HELPER_SETTLE_MS).catch(() => undefined);
  return HELPER_TIMEOUT_EXIT;
}

/**
 * Runs a helper to completion. Output comes from an attach made before the container starts, and the exit is waited for
 * before it starts too: AutoRemove deletes the container as soon as it exits, so neither can be read afterwards. Once it
 * has started the engine removes it, even if this process goes away. Until then nothing does, so a failed start removes
 * it here. Returns after the removal, so a volume the helper used can be removed straight after.
 */
export async function runHelper(docker: Docker, spec: HelperSpec): Promise<{ exitCode: number; logs: string }> {
  if (!spec.secrets?.length) return runContainer(docker, spec);
  const volume = await stageSecrets(docker, spec);
  try {
    const mounts = [...(spec.mounts ?? []), { source: volume, target: HELPER_SECRETS_DIR, mode: "ro" as const }];
    return await runContainer(docker, { ...spec, mounts });
  } finally {
    await removeStagedVolume(docker, volume);
  }
}

/**
 * Writes a helper's secrets into a new volume. The files go in through a container that is created but never started,
 * so the helper's own root filesystem is untouched, and the volume is mounted read-only in the helper afterwards.
 */
async function stageSecrets(docker: Docker, spec: HelperSpec): Promise<string> {
  const volume = `mbhsec${randomBytes(6).toString("hex")}`;
  await call(() => docker.createVolume({ Name: volume, Labels: { ...spec.labels, [HELPER_SECRETS_LABEL]: "true" } }));
  try {
    const stage = await call(() =>
      docker.createContainer({
        Image: spec.image,
        name: `${volume}-stage`,
        HostConfig: {
          Mounts: [helperMountOf({ source: volume, target: HELPER_SECRETS_DIR, mode: "rw" })],
          NetworkMode: "none",
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
        },
      }),
    );
    const container = docker.getContainer(stage.id);
    try {
      await call(() =>
        container.putArchive(secretsArchive(spec.secrets ?? [], spec.secretsOwner), { path: HELPER_SECRETS_DIR }),
      );
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  } catch (e) {
    await removeStagedVolume(docker, volume);
    throw e;
  }
  return volume;
}

async function removeStagedVolume(docker: Docker, volume: string): Promise<void> {
  await docker
    .getVolume(volume)
    .remove({ force: true })
    .catch(() => undefined);
}

async function runContainer(docker: Docker, spec: HelperSpec): Promise<{ exitCode: number; logs: string }> {
  const name = `mbxhlp${randomBytes(4).toString("hex")}`;
  const created = await call(() => docker.createContainer(toHelperOptions(spec, name)));
  const container = docker.getContainer(created.id);
  let started = false;
  try {
    const attached = await call(() => container.attach({ stream: true, stdout: true, stderr: true }));
    const output = readAll(attached).catch(() => Buffer.alloc(0));
    const exited = call(() => container.wait({ condition: "next-exit" })) as Promise<{ StatusCode?: number }>;
    exited.catch(() => undefined);
    await call(() => container.start());
    started = true;
    const exitCode = await exitCodeOf(container, exited, (spec.timeoutSec ?? 30) * 1000);
    const logs = demuxLogs(await output);
    await within(
      call(() => container.wait({ condition: "removed" })).catch(() => undefined),
      HELPER_SETTLE_MS,
    );
    return { exitCode, logs };
  } catch (e) {
    if (started) await container.kill().catch(() => undefined);
    else await container.remove({ force: true }).catch(() => undefined);
    throw e;
  }
}

type HelperMethods = Pick<Runtime, "runHelper">;

export function helperMethods(engine: Engine): HelperMethods {
  const { docker } = engine;

  return {
    async runHelper(spec) {
      return runHelper(docker, spec);
    },
  };
}
