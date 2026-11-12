import { finished } from "node:stream/promises";

import type { HostCtx } from "../host/registry";
import { isRuntimeError, type PathStat } from "../runtime";
import type { VolumeRecord } from "../volumes/types";
import { containerPath } from "./files-path";
import type { MountAccess } from "./files-volume";
import { within } from "./tmux-exec";

/** Mounts whose contents hide part of the volume as seen from this box. */
export function nestedMounts(access: MountAccess): string[] {
  const prefix = access.mountPath === "/" ? "/" : `${access.mountPath}/`;
  return (access.container?.mounts ?? [])
    .filter((mount) => mount.target !== access.mountPath && mount.target.startsWith(prefix))
    .map((mount) => mount.target);
}

/** GNU find's NUL-delimited format keeps tabs and newlines in file names intact. */
export function listingCommand(search: string, maxDepth: number): string[] {
  return [
    "find",
    "-P",
    search,
    "-maxdepth",
    String(maxDepth),
    "(",
    "-type",
    "f",
    "-o",
    "-type",
    "d",
    "-o",
    "-type",
    "l",
    ")",
    "-printf",
    "%y\\t%s\\t%T@\\t%p\\0",
  ];
}

/**
 * A running box already has the volume mounted. Reading there avoids creating, starting and removing a container
 * for every refresh. A nested mount beyond the requested depth does not affect a listing. At the depth boundary,
 * only its metadata is visible: read that metadata from the volume's isolated archive mount instead of the covering
 * volume. Queries inside or through a nested mount still use the find helper. Archive mounts are never started.
 */
export async function listInMount(
  host: HostCtx,
  volume: VolumeRecord,
  access: MountAccess,
  physical: string,
  maxDepth: number,
  metadata: MountAccess = access,
): Promise<{ logs: string; search: string; boundary: Map<string, PathStat | null> } | null> {
  const info = access.container;
  if (!info?.running) return null;
  if (!info.mounts.some((mount) => mount.source === volume.engineName && mount.target === access.mountPath))
    return null;
  const search = containerPath(access.mountPath, physical);
  const boundaryPaths: string[] = [];
  for (const path of nestedMounts(access)) {
    if (search === path || search.startsWith(`${path}/`)) return null;
    if (!path.startsWith(`${search}/`)) continue;
    const depth = path.slice(search.length + 1).split("/").length;
    if (depth < maxDepth) return null;
    if (depth === maxDepth) boundaryPaths.push(path);
  }
  // A covering mount must never supply even the boundary entry's type or modification time.
  if (boundaryPaths.length > 0 && metadata.containerId === access.containerId) return null;
  const boundary = new Map<string, PathStat | null>(
    await Promise.all(
      boundaryPaths.map(async (path) => {
        const relative = path.slice(access.mountPath.length + 1);
        try {
          return [
            path,
            await host.runtime.statPath(metadata.containerId, containerPath(metadata.mountPath, relative)),
          ] as const;
        } catch (e) {
          if (isRuntimeError(e, "not_found")) return [path, null] as const;
          throw e;
        }
      }),
    ),
  );
  let exec;
  try {
    exec = await host.runtime.startExec(access.containerId, {
      cmd: listingCommand(search, maxDepth),
      env: ["LC_ALL=C"],
      workingDir: "/",
      user: "1000:1000",
      tty: false,
    });
  } catch {
    // A box may stop between inspect and exec, or its image may not contain find.
    return null;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  const maxBytes = 16 * 1024 * 1024;
  exec.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= maxBytes) chunks.push(Buffer.from(chunk));
  });
  exec.stderr.resume();
  const closed = await within(
    Promise.all([finished(exec.stdout), finished(exec.stderr)]).then(
      () => true,
      () => false,
    ),
    5000,
  );
  if (closed !== true) {
    await exec.kill().catch(() => undefined);
    return null;
  }
  // Docker can close the streams just before the exec's exit status becomes available.
  const deadline = Date.now() + 1000;
  for (;;) {
    const status = await exec.inspect();
    if (!status.running) {
      return status.exitCode === 0 && bytes > 0 && bytes <= maxBytes
        ? { logs: Buffer.concat(chunks).toString("utf8"), search, boundary }
        : null;
    }
    if (Date.now() >= deadline) {
      await exec.kill().catch(() => undefined);
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
