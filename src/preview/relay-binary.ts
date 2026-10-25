import { createHash } from "node:crypto";

import { RuntimeError } from "../runtime";
import { RELAY_BINARIES } from "./relay-binary.generated";

/**
 * The static Rust relay (`relay/`), placed into a box on demand and run instead of the python3
 * script when the box's architecture has a build. The binary is embedded in this process, so a
 * deployment carries its own relay and no download step exists. One cache entry per container:
 * a box rebuilt under the same id lands in a fresh container, and the new writable layer starts
 * without the file.
 */
const RELAY_PATH = "/tmp/.minibox-relay";

/** Maps a machine architecture, as the engine reports it, to the embedded build for it. */
const ARCH_TARGETS: Readonly<Record<string, string>> = {
  x86_64: "x86_64-unknown-linux-musl",
  amd64: "x86_64-unknown-linux-musl",
  aarch64: "aarch64-unknown-linux-musl",
  arm64: "aarch64-unknown-linux-musl",
};

/** The paths the relay binary is placed at. Tests use them to recognise a relay's argv. */
export const RELAY_PATHS: readonly string[] = ["/tmp/.minibox-relay"];

/**
 * Places the relay binary in the box and returns the argv that runs it. The written bytes are
 * checked against the hash recorded at build time, so a truncated or corrupted embed fails the
 * write instead of starting a broken relay. Each call verifies, and the per-container caller
 * caches the result so the cost is paid once per box container.
 */
export function placeRelay(arch: string | null | undefined): { path: string; bytes: Buffer; sha256: string } | null {
  const target = arch === null || arch === undefined ? undefined : ARCH_TARGETS[arch];
  const entry = target === undefined ? undefined : RELAY_BINARIES[target];
  if (!entry) return null;
  const bytes = Buffer.from(entry.base64, "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== entry.sha256) {
    throw new RuntimeError("engine", `the embedded relay for ${target} does not match its recorded hash`);
  }
  return { path: RELAY_PATH, bytes, sha256 };
}

/** The argv of the relay run from the placed binary. */
export function relayArgv(path: string, port: number): string[] {
  return [path, String(port)];
}
