import type { HostCtx } from "../host/registry";
import { volumeName } from "../labels";
import type { ContainerInfo } from "../runtime";
import { detectDrift } from "../specs/drift";
import type { BoxSpec } from "../specs/types";
import type { Box } from "./boxes";

function workspaceVolume(host: HostCtx, spec: BoxSpec): string {
  const workspace = spec.mounts.find((mount) => mount.path === "/workspace");
  return workspace?.volume ?? volumeName(host.prefix, spec.createdName);
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
    volume: workspaceVolume(host, spec),
    revision: spec.revision,
    desired: spec.lifecycle.desired,
    idleTimeoutSec: spec.lifecycle.idleTimeoutSec,
    ttlSec: spec.lifecycle.ttlSec,
    labels: spec.labels,
    createdBy: spec.createdBy,
    containerName: info.name,
    drift: detectDrift(spec, info),
    recovery: spec.recovery,
    mounts: spec.mounts,
    env: spec.env,
  };
}
