import pkg from "../package.json";
import { ROOT } from "./config";

/** Strip a leading "v" from tags such as v1.2.3. */
export const normalizeVersion = (v: string): string => v.trim().replace(/^v(?=\d)/, "");

function fromGit(): string | null {
  try {
    const res = Bun.spawnSync(["git", "describe", "--tags", "--match", "v[0-9]*", "--dirty"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (res.exitCode !== 0) return null;
    const out = res.stdout.toString().trim();
    return out ? normalizeVersion(out) : null;
  } catch {
    return null; // git not installed (e.g. in the Docker image)
  }
}

/**
 * Resolve the running version.
 * Order: MINIBOX_VERSION env (set at image build from the release tag)
 *      > `git describe --tags` (dev checkouts, e.g. 0.2.0-3-gabc1234)
 *      > package.json version.
 */
export function resolveVersion(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.MINIBOX_VERSION?.trim();
  if (fromEnv) return normalizeVersion(fromEnv);
  return fromGit() ?? pkg.version;
}
