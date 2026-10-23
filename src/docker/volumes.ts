import { RuntimeError, isRuntimeError, type VolumeInfo, type Runtime } from "../runtime";
import { call, type Engine } from "./engine";
import { runHelper } from "./helpers";

const ROOT_OWNER_MOUNT = "/minibox-volume";

/**
 * The helper could not be created or started. MiniBox built that container from its own settings, so the engine's
 * refusal is an engine failure, whatever status it sent. An unreachable engine stays unavailable.
 */
function helperFailure(volume: string, e: unknown): RuntimeError {
  if (isRuntimeError(e, "unavailable")) return e;
  const reason = e instanceof RuntimeError ? e.detail : String(e);
  return new RuntimeError("engine", `the chown helper for ${volume} could not run: ${reason}`, reason);
}

function volumeInfo(info: {
  Name: string;
  Labels?: Record<string, string> | null;
  Driver?: string;
  Options?: Record<string, string> | null;
}): VolumeInfo {
  return {
    name: info.Name,
    labels: info.Labels ?? {},
    driver: info.Driver,
    options: info.Options ?? undefined,
  };
}

type VolumeMethods = Pick<
  Runtime,
  "setVolumeRootOwner" | "inspectVolume" | "listVolumes" | "createVolume" | "removeVolume"
>;

export function volumeMethods(engine: Engine): VolumeMethods {
  const { docker } = engine;

  return {
    async setVolumeRootOwner(volume, owner, image) {
      await call(() => docker.getVolume(volume).inspect());
      // Inspecting first matters: a mount of a missing named volume makes the engine create it.
      let result: { exitCode: number; logs: string };
      try {
        result = await runHelper(docker, {
          image,
          cmd: ["chown", `${owner.uid}:${owner.gid}`, ROOT_OWNER_MOUNT],
          user: "0:0",
          capAdd: ["CHOWN"],
          mounts: [{ source: volume, target: ROOT_OWNER_MOUNT, mode: "rw" }],
        });
      } catch (e) {
        throw helperFailure(volume, e);
      }
      if (result.exitCode !== 0) {
        const output = result.logs.trim();
        const suffix = output ? `: ${output}` : "";
        throw new RuntimeError("engine", `chown of ${volume} exited with status ${result.exitCode}${suffix}`);
      }
    },

    async inspectVolume(name) {
      const info = await call(() => docker.getVolume(name).inspect());
      return volumeInfo(info);
    },

    async listVolumes() {
      const listed = await call(() => docker.listVolumes());
      return (listed.Volumes ?? []).map((info) => volumeInfo(info));
    },

    async createVolume(name, labels, opts) {
      try {
        await call(() =>
          docker.createVolume({
            Name: name,
            Labels: labels,
            Driver: opts?.driver,
            DriverOpts: opts?.driverOpts,
          }),
        );
      } catch (e) {
        // An existing volume keeps the labels and options it was created with.
        if (e instanceof RuntimeError && e.kind === "conflict") return;
        throw e;
      }
    },

    async removeVolume(name) {
      await call(() => docker.getVolume(name).remove());
    },
  };
}
