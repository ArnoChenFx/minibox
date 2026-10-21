import type { HostCtx } from "../host/registry";
import type { ContainerInfo } from "../runtime";
import { detectDrift } from "../specs/drift";
import type { BoxMount, BoxSpec } from "../specs/types";
import { poolsUsed } from "../volumes/engine";
import type { Box, BoxMountView } from "./boxes";

function workspaceVolume(spec: BoxSpec): string {
  const workspace = spec.mounts.find((mount) => mount.path === "/workspace");
  return workspace?.volume ?? "";
}

function mountViews(host: HostCtx, mounts: BoxMount[]): BoxMountView[] {
  return mounts.map((mount) => {
    const volume = host.volumes.findByEngine(host.host.id, mount.volume);
    return {
      ...mount,
      volumeId: volume?.id ?? null,
      volumeName: volume?.name ?? null,
      role: volume?.role ?? null,
      pool: volume?.pool ?? null,
    };
  });
}

function storageOf(host: HostCtx, spec: BoxSpec): Box["storage"] {
  const names = poolsUsed(host, spec.mounts);
  if (names.length === 0) return { status: "ok", pools: [] };
  const pools = names.map((name) => {
    const known = host.volumes.healthOf(host.host.id, name);
    return { name, status: known?.status ?? ("unknown" as const) };
  });
  const status = pools.some((pool) => pool.status === "unreachable")
    ? "unreachable"
    : pools.some((pool) => pool.status === "unknown")
      ? "unknown"
      : "ok";
  return { status, pools };
}

/**
 * The box as a live frame carries it. Environment variables go out by name only: a frame reaches every open stream, and a
 * value can be a secret. The REST reads keep the values.
 */
export function liveBox(box: Box): Box {
  return { ...box, env: box.env.map(({ name }) => ({ name })) };
}

/** Observed container fields stay on the box so drift is visible. Desired fields come from the spec. */
export function projectBox(host: HostCtx, spec: BoxSpec, info: ContainerInfo): Box {
  return {
    id: info.id,
    boxId: spec.id,
    name: spec.name,
    state: info.state,
    status: info.state,
    running: info.running,
    image: info.image,
    template: spec.template.ref,
    profile: spec.profile,
    network: info.network,
    cpus: info.cpus,
    memory: info.memoryBytes,
    pids: info.pidsLimit,
    createdAt: spec.createdAt,
    startedAt: info.startedAt,
    volume: workspaceVolume(spec),
    revision: spec.revision,
    desired: spec.lifecycle.desired,
    idleTimeoutSec: spec.lifecycle.idleTimeoutSec,
    ttlSec: spec.lifecycle.ttlSec,
    stopReason: spec.lifecycle.stopReason ?? null,
    sleeping:
      !info.running &&
      spec.lifecycle.desired === "stopped" &&
      (spec.lifecycle.stopReason === "idle" || spec.lifecycle.stopReason === "ttl"),
    lastActivityAt: host.pulse.lastActivityAt(spec.id),
    labels: spec.labels,
    createdBy: spec.createdBy,
    containerName: info.name,
    drift: detectDrift(spec, info),
    recovery: spec.recovery,
    mounts: mountViews(host, spec.mounts),
    env: spec.env,
    tools: spec.tools,
    storage: storageOf(host, spec),
  };
}
