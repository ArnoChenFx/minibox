import { finished } from "node:stream/promises";

import type { HostCtx } from "../host/registry";
import type { VolumeRecord } from "../volumes/types";
import { containerPath } from "./files-path";
import type { MountAccess } from "./files-volume";
import { within } from "./tmux-exec";

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
 * for every refresh. Stopped boxes, images without GNU find, and mounts shadowed by another mount use the isolated
 * helper instead. No box is started and no helper image is needed on the fast path.
 */
export async function listInMount(
  host: HostCtx,
  volume: VolumeRecord,
  access: MountAccess,
  physical: string,
  maxDepth: number,
): Promise<{ logs: string; search: string } | null> {
  const info = access.container;
  if (!info?.running) return null;
  if (!info.mounts.some((mount) => mount.source === volume.engineName && mount.target === access.mountPath))
    return null;
  const prefix = access.mountPath === "/" ? "/" : `${access.mountPath}/`;
  if (info.mounts.some((mount) => mount.target !== access.mountPath && mount.target.startsWith(prefix))) return null;

  const search = containerPath(access.mountPath, physical);
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
        ? { logs: Buffer.concat(chunks).toString("utf8"), search }
        : null;
    }
    if (Date.now() >= deadline) {
      await exec.kill().catch(() => undefined);
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
