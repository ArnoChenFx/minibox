import type { HelperSpec } from "../../src/runtime";
import type { FakeRuntime } from "./fake-runtime";

/**
 * Makes the clone helper of `runtime` write `files` into the volume it is given, the way a clone leaves a repository
 * there. Every other helper run goes to the fake's built-in answers.
 */
export function serveRepository(runtime: FakeRuntime, files: Map<string, string>): void {
  const builtIn = runtime.helperHandler;
  runtime.helperHandler = (spec: HelperSpec) => {
    if (spec.cmd[0] !== "sh") return builtIn(spec);
    const volume = spec.mounts?.[0]?.source ?? "";
    for (const [path, text] of files) {
      runtime.seedVolumeFile(volume, path, { type: "file", content: Buffer.from(text) });
    }
    return { exitCode: 0, logs: "" };
  };
}

/** The devcontainer.json a declared template in these tests is built from. */
export const DEVCONTAINER_WITH_SETUP =
  '{"image": "alpine:3.20", "postCreateCommand": "npm install", "forwardPorts": [3000]}';
