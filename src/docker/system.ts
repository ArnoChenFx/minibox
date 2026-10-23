import { statfsSync } from "node:fs";

import { type DiskUsage, RuntimeError, type Runtime } from "../runtime";
import { call, type Engine } from "./engine";

type SystemMethods = Pick<Runtime, "ping" | "info" | "diskUsage">;

export function systemMethods(engine: Engine): SystemMethods {
  const { docker } = engine;

  return {
    async ping() {
      await call(() => docker.ping());
    },

    async info() {
      const [info, version] = await call(() =>
        Promise.all([docker.info() as Promise<Record<string, unknown>>, docker.version()]),
      );
      return {
        version: version.Version ?? null,
        rootDir: (info.DockerRootDir as string) ?? null,
        containers: { running: Number(info.ContainersRunning ?? 0), total: Number(info.Containers ?? 0) },
        images: Number(info.Images ?? 0),
        cpus: typeof info.NCPU === "number" ? info.NCPU : null,
        memoryBytes: typeof info.MemTotal === "number" ? info.MemTotal : null,
      };
    },

    async diskUsage(path): Promise<DiskUsage> {
      try {
        const stat = statfsSync(path);
        return { totalBytes: stat.blocks * stat.bsize, freeBytes: stat.bavail * stat.bsize };
      } catch (e) {
        const code = typeof e === "object" && e !== null && "code" in e ? String(e.code) : "";
        if (code === "ENOENT") throw new RuntimeError("not_found", `path not found: ${path}`);
        throw new RuntimeError("engine", e instanceof Error ? e.message : String(e));
      }
    },
  };
}
