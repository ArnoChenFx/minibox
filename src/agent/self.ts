import { readFileSync } from "node:fs";
import { hostname } from "node:os";

import type { Runtime } from "../runtime";
import type { AgentSelf } from "./scope";

/**
 * The ids a container's own mounts name. An engine bind-mounts `/etc/hostname`, `/etc/hosts` and `/etc/resolv.conf` from
 * `/var/lib/docker/containers/<id>/`, so the mount table of a process in the container says which container it is,
 * whichever cgroup version the host runs.
 */
export function containerIdsIn(mountinfo: string): string[] {
  const ids = new Set<string>();
  for (const found of mountinfo.matchAll(/\/containers\/([0-9a-f]{64})\//g)) {
    if (found[1] !== undefined) ids.add(found[1]);
  }
  return [...ids];
}

export interface SelfSources {
  readonly mountinfo?: () => string;
  readonly hostname?: () => string;
}

/**
 * The container this agent runs in, or null when it cannot tell, such as an agent run outside a container. It reads its
 * mount table first, then its hostname, which an engine sets to the container's short id unless a person overrode it,
 * and accepts a candidate only if the engine knows a container by that id.
 */
export async function findSelf(
  runtime: Pick<Runtime, "inspectContainer">,
  sources: SelfSources = {},
): Promise<AgentSelf | null> {
  const read = sources.mountinfo ?? (() => readFileSync("/proc/self/mountinfo", "utf8"));
  const name = sources.hostname ?? hostname;
  const candidates: string[] = [];
  try {
    candidates.push(...containerIdsIn(read()));
  } catch {
    // No mount table, as on a platform without /proc: the hostname is next.
  }
  const short = name();
  if (/^[0-9a-f]{12}$/.test(short)) candidates.push(short);
  for (const candidate of candidates) {
    try {
      const info = await runtime.inspectContainer(candidate);
      return { containerId: info.id, volumes: new Set(info.mounts.map((mount) => mount.source)) };
    } catch {
      // Not a container this engine knows: try the next one.
    }
  }
  return null;
}
