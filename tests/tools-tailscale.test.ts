import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCatalogEntry } from "../src/tools/catalog";
import { renderCommand } from "../src/tools/commands";

// The install and the wrapper run against a fake pkgs.tailscale.com (a directory of fixtures served by a fake curl),
// fake tailscale and tailscaled scripts, and the real jq, sha256sum, tar, flock and setsid.
const READY =
  process.platform === "linux" &&
  ["flock", "jq", "setsid", "sha256sum", "tar", "awk", "mktemp", "sh"].every((tool) => Bun.which(tool) !== null);

const VERSION = "1.2.3";
const LOGIN_URL = "https://login.example.test/a/abc123";

const TAILSCALE = parseCatalogEntry(
  JSON.parse(readFileSync(join(import.meta.dir, "..", "catalog", "tailscale.json"), "utf8")),
  "catalog/tailscale.json",
);

/** A `sh` script from lines of source. The lines are plain strings, so a shell `$` needs no escaping. */
function shell(...lines: string[]): string {
  return ["#!/bin/sh", ...lines, ""].join("\n");
}

const FAKE_CURL = shell(
  "out=",
  "url=",
  "while [ $# -gt 0 ]; do",
  '  case "$1" in',
  "    -o) out=$2; shift 2 ;;",
  "    -*) shift ;;",
  "    *) url=$1; shift ;;",
  "  esac",
  "done",
  'printf \'%s\\n\' "$url" >>"$FAKE_CURL_LOG"',
  'case "$url" in',
  "  *'?mode=json') name=index.json ;;",
  "  *) name=${url##*/} ;;",
  "esac",
  '[ -f "$FAKE_SITE/$name" ] || { echo "curl: (22) 404 for $url" >&2; exit 22; }',
  'cp "$FAKE_SITE/$name" "$out"',
);

const FAKE_UNAME = shell('[ "$1" = -m ] && echo "$FAKE_MACHINE" || echo Linux');

const FAKE_TAILSCALED = shell(
  'for arg in "$@"; do',
  '  case "$arg" in --socket=*) : >"${arg#--socket=}" ;; esac',
  "done",
  'printf \'%s\\n\' "$*" >>"$FAKE_DAEMON_LOG"',
  "while :; do sleep 1; done",
);

const FAKE_TAILSCALE = shell(
  "sock=",
  'case "${1:-}" in --socket=*) sock=${1#--socket=}; shift ;; esac',
  'case "${1:-}" in',
  `  version) echo ${VERSION} ;;`,
  '  status) [ -e "$sock" ] || { echo "failed to connect to local tailscaled" >&2; exit 1; }; echo \'{"BackendState":"NeedsLogin"}\' ;;',
  "  up)",
  '    echo "$*" >>"$FAKE_UP_LOG"',
  "    echo 'To authenticate, visit:'",
  `    echo '  ${LOGIN_URL}'`,
  '    if [ -n "${FAKE_UP_BLOCK:-}" ]; then while :; do sleep 1; done; fi ;;',
  '  *) echo "unexpected: $*" >&2; exit 2 ;;',
  "esac",
);

interface Sandbox {
  root: string;
  site: string;
  prefix: string;
  home: string;
  bin: string;
  curlLog: string;
  daemonLog: string;
  upLog: string;
}

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function writeTarball(site: string, stage: string, arch: string): string {
  const dir = `tailscale_${VERSION}_${arch}`;
  mkdirSync(join(stage, dir), { recursive: true });
  writeFileSync(join(stage, dir, "tailscale"), FAKE_TAILSCALE, { mode: 0o755 });
  writeFileSync(join(stage, dir, "tailscaled"), FAKE_TAILSCALED, { mode: 0o755 });
  const tarball = `${dir}.tgz`;
  const made = Bun.spawnSync({ cmd: ["tar", "-czf", join(site, tarball), "-C", stage, dir] });
  expect(made.exitCode).toBe(0);
  writeChecksum(site, tarball);
  return tarball;
}

/** Writes the sidecar the way pkgs.tailscale.com does: the bare hex digest of the tarball. */
function writeChecksum(site: string, tarball: string, hex?: string): void {
  const digest = hex ?? new Bun.CryptoHasher("sha256").update(readFileSync(join(site, tarball))).digest("hex");
  writeFileSync(join(site, `${tarball}.sha256`), `${digest}\n`);
}

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "mb-tailscale-"));
  const site = join(root, "site");
  const stage = join(root, "stage");
  const bin = join(root, "fake-bin");
  const home = join(root, "home");
  for (const dir of [site, stage, bin, home]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
  writeFileSync(join(bin, "uname"), FAKE_UNAME, { mode: 0o755 });
  const amd64 = writeTarball(site, stage, "amd64");
  const arm64 = writeTarball(site, stage, "arm64");
  writeFileSync(join(site, "index.json"), JSON.stringify({ Version: VERSION, Tarballs: { amd64, arm64 } }));
  return {
    root,
    site,
    prefix: join(root, "tools"),
    home,
    bin,
    curlLog: join(root, "curl.log"),
    daemonLog: join(root, "daemon.log"),
    upLog: join(root, "up.log"),
  };
}

function envFor(sandbox: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${sandbox.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: sandbox.home,
    TMPDIR: sandbox.root,
    FAKE_SITE: sandbox.site,
    FAKE_MACHINE: "x86_64",
    FAKE_CURL_LOG: sandbox.curlLog,
    FAKE_DAEMON_LOG: sandbox.daemonLog,
    FAKE_UP_LOG: sandbox.upLog,
    ...extra,
  };
}

function run(cmd: string[], env: Record<string, string>): Run {
  const result = Bun.spawnSync({ cmd, env, stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function install(sandbox: Sandbox, machine = "x86_64"): Run {
  const script = renderCommand(TAILSCALE.install, TAILSCALE, { version: "latest", prefix: sandbox.prefix });
  return run(["sh", "-c", script], envFor(sandbox, { FAKE_MACHINE: machine }));
}

function wrapperPath(sandbox: Sandbox): string {
  return join(sandbox.prefix, "bin", "minibox-tailscale");
}

function wrapper(sandbox: Sandbox, args: string[]): Run {
  return run([wrapperPath(sandbox), ...args], envFor(sandbox));
}

function stateDir(sandbox: Sandbox): string {
  return join(sandbox.home, ".local", "state", "tailscale");
}

function daemonPid(sandbox: Sandbox): number {
  return Number(readFileSync(join(stateDir(sandbox), "tailscaled.pid"), "utf8").trim());
}

/** The state and ppid fields of `/proc/<pid>/stat`, or null when the process is gone. */
function procStat(pid: number): { state: string; ppid: number } | null {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return { state: fields[0] ?? "", ppid: Number(fields[1]) };
}

/** A zombie has exited already, so it does not count as alive. */
function isAlive(pid: number): boolean {
  const stat = procStat(pid);
  return stat !== null && stat.state !== "Z" && stat.state !== "X";
}

async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the fake tailscaled");
    await Bun.sleep(25);
  }
}

function removeSandbox(sandbox: Sandbox): void {
  if (existsSync(wrapperPath(sandbox))) wrapper(sandbox, ["stop"]);
  rmSync(sandbox.root, { recursive: true, force: true });
}

describe.skipIf(!READY)("tailscale install", () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = makeSandbox();
  });

  afterEach(() => {
    removeSandbox(sandbox);
  });

  test("installs tailscale, tailscaled and the wrapper once the published checksum matches", () => {
    const result = install(sandbox);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain(`installed tailscale ${VERSION} (amd64) into ${sandbox.prefix}/bin`);
    expect(readdirSync(join(sandbox.prefix, "bin")).toSorted()).toEqual([
      "minibox-tailscale",
      "tailscale",
      "tailscaled",
    ]);
    for (const name of ["tailscale", "tailscaled", "minibox-tailscale"]) {
      expect(statSync(join(sandbox.prefix, "bin", name)).mode & 0o777).toBe(0o755);
    }
    expect(run(["sh", "-n", wrapperPath(sandbox)], envFor(sandbox))).toMatchObject({ exitCode: 0 });
  });

  test("a tarball that does not match its published checksum installs nothing", () => {
    writeChecksum(sandbox.site, `tailscale_${VERSION}_amd64.tgz`, "0".repeat(64));
    const result = install(sandbox);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("FAILED");
    expect(existsSync(join(sandbox.prefix, "bin", "tailscale"))).toBe(false);
    expect(existsSync(join(sandbox.prefix, "bin", "minibox-tailscale"))).toBe(false);
  });

  test("an empty or malformed published checksum installs nothing", () => {
    for (const hex of ["", "not-a-digest", "a".repeat(63)]) {
      writeChecksum(sandbox.site, `tailscale_${VERSION}_amd64.tgz`, hex);
      const result = install(sandbox);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("malformed sha256");
      expect(existsSync(join(sandbox.prefix, "bin", "tailscale"))).toBe(false);
    }
  });

  test("an index that names an unexpected tarball is refused before anything is downloaded", () => {
    writeFileSync(
      join(sandbox.site, "index.json"),
      JSON.stringify({ Version: VERSION, Tarballs: { amd64: "../elsewhere/tailscale_1.2.3_amd64.tgz" } }),
    );
    const result = install(sandbox);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no usable tailscale tarball for amd64");
    expect(readFileSync(sandbox.curlLog, "utf8")).not.toContain(".tgz");
  });

  test("an aarch64 machine gets the arm64 tarball", () => {
    const result = install(sandbox, "aarch64");
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain("(arm64)");
    const requests = readFileSync(sandbox.curlLog, "utf8");
    expect(requests).toContain(`tailscale_${VERSION}_arm64.tgz`);
    expect(requests).not.toContain(`tailscale_${VERSION}_amd64.tgz`);
  });

  test("a machine without a supported architecture stops before fetching a tarball", () => {
    const result = install(sandbox, "riscv64");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unsupported architecture: riscv64");
    expect(readFileSync(sandbox.curlLog, "utf8")).not.toContain(".tgz");
  });
});

describe.skipIf(!READY)("minibox-tailscale", () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = makeSandbox();
    expect(install(sandbox)).toMatchObject({ exitCode: 0 });
  });

  afterEach(() => {
    removeSandbox(sandbox);
  });

  test("up starts tailscaled once in userspace mode behind the proxy, prints the login URL, and reuses the daemon", () => {
    const first = wrapper(sandbox, ["up"]);
    expect(first).toMatchObject({ exitCode: 0 });
    expect(first.stdout).toContain(LOGIN_URL);
    expect(wrapper(sandbox, ["up"])).toMatchObject({ exitCode: 0 });

    const starts = readFileSync(sandbox.daemonLog, "utf8").trim().split("\n");
    expect(starts).toHaveLength(1);
    const state = stateDir(sandbox);
    expect(starts[0]).toContain("--tun=userspace-networking");
    expect(starts[0]).toContain(`--state=${state}/tailscaled.state`);
    expect(starts[0]).toContain(`--socket=${state}/tailscaled.sock`);
    expect(starts[0]).toContain("--socks5-server=localhost:1055");
    expect(starts[0]).toContain("--outbound-http-proxy-listen=localhost:1055");
  }, 15_000);

  test("up waits for a tailscaled that is still starting instead of starting a second one", async () => {
    expect(wrapper(sandbox, ["up"])).toMatchObject({ exitCode: 0 });
    const sock = join(stateDir(sandbox), "tailscaled.sock");
    rmSync(sock);
    const again = Bun.spawn([wrapperPath(sandbox), "up"], { env: envFor(sandbox), stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(300);
    writeFileSync(sock, "");
    expect(await again.exited).toBe(0);
    expect(readFileSync(sandbox.daemonLog, "utf8").trim().split("\n")).toHaveLength(1);
  }, 15_000);

  test("up passes its other arguments to tailscale up", () => {
    expect(wrapper(sandbox, ["up", "--accept-dns=false"])).toMatchObject({ exitCode: 0 });
    expect(readFileSync(sandbox.upLog, "utf8")).toContain("up --accept-dns=false");
  }, 15_000);

  test("the daemon is not a child of the up command, so killing that command leaves tailscaled running", async () => {
    const up = Bun.spawn([wrapperPath(sandbox), "up"], {
      env: envFor(sandbox, { FAKE_UP_BLOCK: "1" }),
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await waitUntil(() => existsSync(sandbox.daemonLog));
      const pid = daemonPid(sandbox);
      expect(procStat(pid)?.ppid).not.toBe(up.pid);
      up.kill();
      await up.exited;
      expect(isAlive(pid)).toBe(true);
      const sock = join(stateDir(sandbox), "tailscaled.sock");
      const status = run(
        [join(sandbox.prefix, "bin", "tailscale"), `--socket=${sock}`, "status", "--json"],
        envFor(sandbox),
      );
      expect(status).toMatchObject({ exitCode: 0 });
    } finally {
      up.kill();
      await up.exited;
    }
  }, 15_000);

  test("stop ends tailscaled, and a second stop finds nothing running", () => {
    expect(wrapper(sandbox, ["up"])).toMatchObject({ exitCode: 0 });
    const pid = daemonPid(sandbox);
    expect(isAlive(pid)).toBe(true);

    const stopped = wrapper(sandbox, ["stop"]);
    expect(stopped).toMatchObject({ exitCode: 0 });
    expect(stopped.stdout).toContain("tailscaled stopped");
    expect(isAlive(pid)).toBe(false);

    const again = wrapper(sandbox, ["stop"]);
    expect(again).toMatchObject({ exitCode: 0 });
    expect(again.stdout).toContain("tailscaled is not running");
  }, 15_000);

  test("stop leaves a process alone when the pidfile names something other than tailscaled", () => {
    const bystander = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      mkdirSync(stateDir(sandbox), { recursive: true });
      writeFileSync(join(stateDir(sandbox), "tailscaled.pid"), `${bystander.pid}\n`);
      const result = wrapper(sandbox, ["stop"]);
      expect(result).toMatchObject({ exitCode: 0 });
      expect(result.stdout).toContain("tailscaled is not running");
      expect(isAlive(bystander.pid)).toBe(true);
    } finally {
      bystander.kill();
    }
  });

  test("other tailscale commands need tailscaled to be running", () => {
    const result = wrapper(sandbox, ["status"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("tailscaled is not running; start it with: minibox-tailscale up");
  });

  test("with no arguments it prints the usage, which names the proxy", () => {
    const result = wrapper(sandbox, []);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain("minibox-tailscale up");
    expect(result.stdout).toContain("ALL_PROXY=socks5h://localhost:1055");
  });
});
