type CliOs = "linux" | "darwin" | "windows";
type CliArch = "x64" | "arm64";

export interface CliTarget {
  /** The `<os>-<arch>` part of the download path, for example `linux-x64`. */
  readonly id: string;
  readonly os: CliOs;
  readonly arch: CliArch;
  /** The `--target` argument of `bun build --compile`. */
  readonly bunTarget: string;
  /** The download's file name, and the name checksums.txt lists it under. */
  readonly fileName: string;
}

function targetFor(os: CliOs, arch: CliArch): CliTarget {
  const id = `${os}-${arch}`;
  return {
    id,
    os,
    arch,
    bunTarget: `bun-${id}`,
    fileName: os === "windows" ? `minibox-${id}.exe` : `minibox-${id}`,
  };
}

export const CLI_TARGETS: readonly CliTarget[] = [
  targetFor("linux", "x64"),
  targetFor("linux", "arm64"),
  targetFor("darwin", "x64"),
  targetFor("darwin", "arm64"),
  targetFor("windows", "x64"),
];

const BY_FILE_NAME = new Map(CLI_TARGETS.map((target) => [target.fileName, target]));

/**
 * The target a download path names. Only the exact names in CLI_TARGETS match, so a request can never choose a file
 * on disk: the file name is looked up here, not joined into a path.
 */
export function cliTargetByFileName(name: string): CliTarget | null {
  return BY_FILE_NAME.get(name) ?? null;
}

/** The target for this process's platform, or null when MiniBox does not publish one for it. */
export function hostCliTarget(platform: string = process.platform, arch: string = process.arch): CliTarget | null {
  const os = platform === "win32" ? "windows" : platform;
  return CLI_TARGETS.find((target) => target.id === `${os}-${arch}`) ?? null;
}
