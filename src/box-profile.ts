import type { ContainerHardening, Ulimit } from "./runtime";

export const BOX_PROFILES = ["standard", "strict", "relaxed"] as const;
export type BoxProfile = (typeof BOX_PROFILES)[number];

export const DEFAULT_BOX_PROFILE: BoxProfile = "standard";
export const DEFAULT_PIDS_LIMIT = 1024;

export function isBoxProfile(value: unknown): value is BoxProfile {
  return typeof value === "string" && (BOX_PROFILES as readonly string[]).includes(value);
}

/** Docker's default capabilities minus MKNOD, SETPCAP and SYS_CHROOT. Used with `CapDrop: ALL` by `standard`. */
export const STANDARD_CAPS = [
  "AUDIT_WRITE",
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "FSETID",
  "KILL",
  "NET_BIND_SERVICE",
  "NET_RAW",
  "SETFCAP",
  "SETGID",
  "SETUID",
] as const;

/** Core dumps can hold secrets and fill the workspace, so they stay off in every profile. */
const ULIMITS: Ulimit[] = [
  { name: "core", soft: 0, hard: 0 },
  { name: "nofile", soft: 65536, hard: 65536 },
];

export interface HardeningSettings {
  pidsLimit: number;
  runtime: string | null;
}

/** The engine settings for a box created with `profile` on a host configured with `settings`. */
export function hardeningFor(profile: BoxProfile, settings: HardeningSettings): ContainerHardening {
  const common: ContainerHardening = {
    pidsLimit: settings.pidsLimit,
    ulimits: ULIMITS.map((u) => ({ ...u })),
  };
  if (settings.runtime) common.runtime = settings.runtime;
  switch (profile) {
    case "standard":
      return { ...common, capDrop: ["ALL"], capAdd: [...STANDARD_CAPS] };
    case "strict":
      return { ...common, capDrop: ["ALL"], noNewPrivileges: true };
    case "relaxed":
      return common;
  }
}
