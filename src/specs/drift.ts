import type { ContainerInfo, ContainerMount } from "../runtime";
import type { BoxDrift, BoxMount, BoxSpec } from "./types";

const show = (value: number | null): string => (value === null ? "unlimited" : String(value));

function canon(mounts: { volume: string; path: string; mode: string }[]): string {
  const rows = mounts.map((mount) => ({ volume: mount.volume, path: mount.path, mode: mount.mode }));
  rows.sort((a, b) => `${a.path}\0${a.volume}`.localeCompare(`${b.path}\0${b.volume}`));
  return JSON.stringify(rows);
}

function fromInspect(mounts: ContainerMount[]): { volume: string; path: string; mode: string }[] {
  return mounts.map((mount) => ({ volume: mount.source, path: mount.target, mode: mount.mode }));
}

function fromSpec(mounts: BoxMount[]): { volume: string; path: string; mode: string }[] {
  return mounts.map((mount) => ({ volume: mount.volume, path: mount.path, mode: mount.mode }));
}

const sameNumber = (expected: number | null, actual: number | null): boolean => {
  if (expected === null || actual === null) return expected === actual;
  return Math.round(expected * 100) === Math.round(actual * 100);
};

/**
 * Compares a live inspect with the spec. Label contents are not hashed and are not part of the comparison:
 * labels are immutable and would disagree with every in-place update.
 */
export function detectDrift(spec: BoxSpec, info: ContainerInfo): BoxDrift[] {
  const drift: BoxDrift[] = [];
  const push = (field: string, expected: string, actual: string) => {
    if (expected !== actual) drift.push({ field, expected, actual });
  };

  if (!sameNumber(spec.resources.cpus, info.cpus)) push("cpus", show(spec.resources.cpus), show(info.cpus));
  if (spec.resources.memoryBytes !== info.memoryBytes) {
    push("memory", show(spec.resources.memoryBytes), show(info.memoryBytes));
  }
  if (spec.resources.pids !== info.pidsLimit) push("pids", show(spec.resources.pids), show(info.pidsLimit));
  push("restart", spec.restart, info.restart);
  push("image", spec.template.image, info.image);
  if (spec.template.digest) push("digest", spec.template.digest, info.imageId);
  push("mounts", canon(fromSpec(spec.mounts)), canon(fromInspect(info.mounts)));
  push("network", spec.network, info.network);
  push("containerName", spec.containerName, info.name);
  return drift;
}
