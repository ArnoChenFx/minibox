import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";

import { RuntimeError, type Runtime } from "../runtime";
import { parsePathStat, readFirstEntryOwner } from "./archive";
import { call, type Engine } from "./engine";

type ContainerArchiveMethods = Pick<Runtime, "putArchive" | "getArchive" | "statPath" | "volumeRootOwner">;

export function containerArchiveMethods(engine: Engine): ContainerArchiveMethods {
  const { docker } = engine;

  return {
    async putArchive(id, path, tar) {
      await call(() => docker.getContainer(id).putArchive(tar, { path }));
    },

    async getArchive(id, path) {
      return call(async () => (await docker.getContainer(id).getArchive({ path })) as Readable);
    },

    async statPath(id, path) {
      const res = await call(
        async () => (await docker.getContainer(id).infoArchive({ path })) as unknown as IncomingMessage,
      );
      res.destroy();
      return parsePathStat(res.headers["x-docker-container-path-stat"], path);
    },

    async volumeRootOwner(containerId, path) {
      const stream = await call(() => docker.getContainer(containerId).getArchive({ path }) as Promise<Readable>);
      try {
        return await readFirstEntryOwner(stream);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        throw new RuntimeError("engine", `could not read the owner of ${path} in ${containerId}: ${reason}`);
      }
    },
  };
}
