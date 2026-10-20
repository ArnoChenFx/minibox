import type Docker from "dockerode";

import type { BoxProfile } from "../box-profile";

export interface Hardening {
  defaultProfile: BoxProfile;
  pidsLimit: number;
  runtime: string | null;
}

/**
 * Capabilities the standard profile keeps: what apt, sudo, chown and ping need. Everything else is dropped,
 * including SYS_ADMIN, NET_ADMIN, SYS_PTRACE, MKNOD, SYS_CHROOT and SETPCAP.
 */
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

interface ProfileRules {
  dropAll: boolean;
  capAdd: readonly string[];
  noNewPrivileges: boolean;
}

/**
 * no-new-privileges makes sudo refuse to run, so only `strict` sets it. In `standard` and `relaxed` the dev user's
 * passwordless sudo gives root inside the container, limited to that profile's capabilities.
 */
const RULES: Record<BoxProfile, ProfileRules> = {
  standard: { dropAll: true, capAdd: STANDARD_CAPS, noNewPrivileges: false },
  strict: { dropAll: true, capAdd: [], noNewPrivileges: true },
  relaxed: { dropAll: false, capAdd: [], noNewPrivileges: false },
};

export function hostConfigFor(
  profile: BoxProfile,
  hardening: Pick<Hardening, "pidsLimit" | "runtime">,
): Docker.HostConfig {
  const rules = RULES[profile];
  return {
    Privileged: false,
    PidsLimit: hardening.pidsLimit,
    Ulimits: [
      { Name: "core", Soft: 0, Hard: 0 },
      { Name: "nofile", Soft: 65536, Hard: 65536 },
    ],
    ...(rules.dropAll ? { CapDrop: ["ALL"], CapAdd: [...rules.capAdd] } : {}),
    ...(rules.noNewPrivileges ? { SecurityOpt: ["no-new-privileges"] } : {}),
    ...(hardening.runtime ? { Runtime: hardening.runtime } : {}),
  };
}
