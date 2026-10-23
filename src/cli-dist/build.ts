import type { CliTarget } from "./targets";

/** A cross-target build downloads the target's Bun runtime (about 90 MB) the first time, so the limit is generous. */
export const CLI_BUILD_TIMEOUT_MS = 5 * 60_000;

export interface CliBuildJob {
  readonly target: CliTarget;
  readonly version: string;
  /**
   * The CLI's entry point. The CLI imports only Node built-ins and the modules under src/cli, so those files are the
   * whole build input.
   */
  readonly entry: string;
  readonly outFile: string;
  /** Where Bun keeps the target runtimes it downloads, so a later build of the same runtime needs no network. */
  readonly runtimeCache: string;
  readonly cwd: string;
}

export type CliBuilder = (job: CliBuildJob) => Promise<void>;

export class CliBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliBuildError";
  }
}

/** The only environment a build sees. The access key and agent tokens of the server are not passed on. */
const BUILD_ENV = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "SYSTEMROOT",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

/** Compiles the CLI for one target with the running Bun, which is the same version that serves the request. */
export async function compileWithBun(job: CliBuildJob, timeoutMs = CLI_BUILD_TIMEOUT_MS): Promise<void> {
  const env: Record<string, string> = {};
  for (const name of BUILD_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.MINIBOX_CLI_BUILD_VERSION = job.version;
  env.MINIBOX_CLI_BUILD_COMPILED = "1";
  env.BUN_INSTALL_CACHE_DIR = job.runtimeCache;
  const proc = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      `--target=${job.target.bunTarget}`,
      "--env=MINIBOX_CLI_BUILD_*",
      "--outfile",
      job.outFile,
      job.entry,
    ],
    { cwd: job.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) throw new CliBuildError(`the build did not finish within ${Math.round(timeoutMs / 1000)} seconds`);
    if (code !== 0) throw new CliBuildError(lastLines(stderr || stdout) || `bun build exited with code ${code}`);
  } finally {
    clearTimeout(timer);
  }
}

/** The last lines of build output. Bun's error is at the end, and the full log would bury the reason. */
function lastLines(output: string): string {
  return output.trim().split("\n").slice(-3).join(" ").slice(-400);
}
