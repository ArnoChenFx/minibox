import { join } from "node:path";

import type { HostCtx } from "../host/registry";
import { isRuntimeError } from "../runtime";

const builds = new WeakMap<HostCtx, Promise<string>>();

/**
 * Archive-only mounts need no programs. An empty image avoids copying the whole base template just to read a HEAD
 * stat, particularly on Docker's vfs storage driver. Built locally without downloads, reused, and never started.
 */
export async function metadataImage(host: HostCtx): Promise<string> {
  const image = `${host.prefix}-file-metadata:internal`;
  try {
    await host.runtime.inspectImage(image);
    return image;
  } catch (e) {
    if (!isRuntimeError(e, "not_found")) throw e;
  }
  const pending = builds.get(host);
  if (pending) return pending;
  const build = host.runtime
    .buildImage({
      contextDir: join(host.templatesDir, "file-metadata"),
      dockerfile: "Dockerfile",
      tag: image,
      labels: { [host.keys.internal]: "true", [host.prefix]: "true" },
    })
    .then(() => image)
    .finally(() => builds.delete(host));
  builds.set(host, build);
  return build;
}
