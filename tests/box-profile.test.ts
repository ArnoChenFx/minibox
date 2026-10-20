import { describe, expect, test } from "bun:test";

import { BOX_PROFILES, hardeningFor, isBoxProfile, STANDARD_CAPS } from "../src/box-profile";

const settings = { pidsLimit: 1024, runtime: null };

describe("box profiles", () => {
  test("isBoxProfile accepts only the three profile ids", () => {
    expect(BOX_PROFILES).toEqual(["standard", "strict", "relaxed"]);
    for (const p of BOX_PROFILES) expect(isBoxProfile(p)).toBe(true);
    for (const bad of ["", "Standard", "root", null, 1, undefined]) expect(isBoxProfile(bad)).toBe(false);
  });

  test("standard drops every capability, adds back the allowlist and leaves sudo working", () => {
    const h = hardeningFor("standard", settings);
    expect(h.capDrop).toEqual(["ALL"]);
    expect(h.capAdd).toEqual([...STANDARD_CAPS]);
    expect(h.noNewPrivileges).toBeUndefined();
  });

  test("strict drops every capability, adds none and sets no-new-privileges", () => {
    const h = hardeningFor("strict", settings);
    expect(h.capDrop).toEqual(["ALL"]);
    expect(h.capAdd).toBeUndefined();
    expect(h.noNewPrivileges).toBe(true);
  });

  test("relaxed keeps the engine's default capabilities and privilege rules", () => {
    const h = hardeningFor("relaxed", settings);
    expect(h.capDrop).toBeUndefined();
    expect(h.capAdd).toBeUndefined();
    expect(h.noNewPrivileges).toBeUndefined();
  });

  test("every profile applies the process limit and ulimits, and the runtime only when configured", () => {
    for (const p of BOX_PROFILES) {
      const h = hardeningFor(p, { pidsLimit: 512, runtime: null });
      expect(h.pidsLimit).toBe(512);
      expect(h.ulimits).toEqual([
        { name: "core", soft: 0, hard: 0 },
        { name: "nofile", soft: 65536, hard: 65536 },
      ]);
      expect(h.runtime).toBeUndefined();
      expect(hardeningFor(p, { pidsLimit: 512, runtime: "runsc" }).runtime).toBe("runsc");
    }
  });

  test("the standard allowlist is Docker's default set without MKNOD, SETPCAP and SYS_CHROOT", () => {
    expect(STANDARD_CAPS).toHaveLength(11);
    for (const cap of ["MKNOD", "SETPCAP", "SYS_CHROOT", "SYS_ADMIN", "NET_ADMIN"]) {
      expect(STANDARD_CAPS).not.toContain(cap);
    }
  });

  test("returned ulimits are copies, so a caller cannot change the defaults for later boxes", () => {
    hardeningFor("standard", settings).ulimits?.push({ name: "memlock", soft: 1, hard: 1 });
    expect(hardeningFor("standard", settings).ulimits).toHaveLength(2);
  });
});
