import { describe, expect, test } from "bun:test";

import { BOX_PROFILES, isBoxProfile } from "../src/box-profile";
import { hostConfigFor, STANDARD_CAPS } from "../src/docker/hardening";

const hardening = { pidsLimit: 1024, runtime: null };

describe("box profiles", () => {
  test("exactly the documented profiles are accepted", () => {
    expect(BOX_PROFILES).toEqual(["standard", "strict", "relaxed"]);
    for (const ok of BOX_PROFILES) expect(isBoxProfile(ok)).toBe(true);
    for (const bad of ["Strict", "", " strict", "privileged", undefined, 1, null]) {
      expect(isBoxProfile(bad)).toBe(false);
    }
  });
});

describe("hostConfigFor", () => {
  test("every profile limits processes, disables privileged mode and turns off core dumps", () => {
    for (const profile of BOX_PROFILES) {
      const hc = hostConfigFor(profile, { pidsLimit: 512, runtime: null });
      expect(hc.PidsLimit).toBe(512);
      expect(hc.Privileged).toBe(false);
      expect(hc.Ulimits).toContainEqual({ Name: "core", Soft: 0, Hard: 0 });
    }
  });

  test("standard drops every capability and adds back only the trimmed set", () => {
    const hc = hostConfigFor("standard", hardening);
    expect(hc.CapDrop).toEqual(["ALL"]);
    expect(hc.CapAdd).toEqual([...STANDARD_CAPS]);
    expect(hc.SecurityOpt).toBeUndefined();
  });

  test("the standard capability set has no kernel-level capabilities", () => {
    for (const cap of [
      "SYS_ADMIN",
      "NET_ADMIN",
      "SYS_PTRACE",
      "SYS_MODULE",
      "SYS_RAWIO",
      "SYS_TIME",
      "DAC_READ_SEARCH",
      "MKNOD",
      "SYS_CHROOT",
      "SETPCAP",
    ]) {
      expect(STANDARD_CAPS).not.toContain(cap);
    }
  });

  test("strict drops every capability and sets no-new-privileges", () => {
    const hc = hostConfigFor("strict", hardening);
    expect(hc.CapDrop).toEqual(["ALL"]);
    expect(hc.CapAdd).toEqual([]);
    expect(hc.SecurityOpt).toEqual(["no-new-privileges"]);
  });

  test("relaxed keeps Docker's default capabilities and does not set no-new-privileges", () => {
    const hc = hostConfigFor("relaxed", hardening);
    expect(hc.CapDrop).toBeUndefined();
    expect(hc.CapAdd).toBeUndefined();
    expect(hc.SecurityOpt).toBeUndefined();
  });

  test("a configured runtime is passed through, otherwise the daemon default applies", () => {
    expect(hostConfigFor("standard", { pidsLimit: 1024, runtime: "runsc" }).Runtime).toBe("runsc");
    expect(hostConfigFor("standard", hardening).Runtime).toBeUndefined();
  });
});
