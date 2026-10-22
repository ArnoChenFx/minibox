import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { type CliBuildJob, type CliBuilder } from "../src/cli-dist/build";
import { CliDistribution, CliUnavailableError } from "../src/cli-dist/distribution";
import { FixedWindowLimiter, Gate } from "../src/cli-dist/limits";
import { renderInstallScript, requestOrigin } from "../src/cli-dist/scripts";
import { CLI_TARGETS, type CliTarget, cliTargetByFileName, hostCliTarget } from "../src/cli-dist/targets";
import { ROOT } from "../src/config";
import { rejectionOf, silenceLogs } from "./support/app";
import { startHarness } from "./support/tokens";

const POSIX = process.platform === "linux" || process.platform === "darwin";
const HOST = hostCliTarget();
const PWSH = Bun.which("pwsh");
const SHELLCHECK = Bun.which("shellcheck");
const REAL_BUILD_MS = 180_000;

/** The binary the installer tests serve: a shell script, so it runs on any POSIX machine the tests run on. */
const STUB_CLI = `#!/bin/sh
case "$1" in
  --version) echo "minibox 0.0.0-test" ;;
  ssh-config) echo "minibox ssh-config [--append]" ;;
  *) exit 2 ;;
esac
`;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

let restoreLogs: () => void;
beforeEach(() => {
  restoreLogs = silenceLogs();
});
afterEach(() => restoreLogs());

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "minibox-cli-dist-"));
  dirs.push(dir);
  return dir;
}

const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function target(fileName: string): CliTarget {
  const found = cliTargetByFileName(fileName);
  if (found === null) throw new Error(`no published target ${fileName}`);
  return found;
}

function hostTarget(): CliTarget {
  if (HOST === null) throw new Error("this machine has no published CLI target");
  return HOST;
}

/** A stand-in for the repository. The cache key reads its src/cli.ts, so each test controls the source it sees. */
function fakeRoot(source = "console.log('minibox');\n"): string {
  const root = tempDir();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "cli.ts"), source);
  return root;
}

/** A builder that writes `content` as the binary and counts its calls. The file is executable, as Bun's output is. */
function stubBuilder(content: (job: CliBuildJob) => string | Uint8Array = (job) => `binary for ${job.target.id}\n`) {
  const jobs: CliBuildJob[] = [];
  const build: CliBuilder = async (job) => {
    jobs.push(job);
    await Bun.write(job.outFile, content(job));
    chmodSync(job.outFile, 0o755);
  };
  return { build, jobs };
}

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a command to its end. Async, so a server in this process keeps answering while the command waits on it. */
async function capture(argv: string[], env: Record<string, string> = {}): Promise<Ran> {
  const proc = Bun.spawn(argv, {
    env: { ...(process.env as Record<string, string>), ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** An install into `dir`: its own HOME, and an install folder of `dir/bin`. The local server is never sent to a proxy. */
function installEnv(dir: string): Record<string, string> {
  return {
    HOME: dir,
    MINIBOX_INSTALL_DIR: join(dir, "bin"),
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
}

function curlInstall(base: string): string[] {
  return ["sh", "-c", `curl -fsSL ${base}/cli/install.sh | sh`];
}

describe("CLI targets", () => {
  test("the published targets carry the file names and Bun targets the installers ask for", () => {
    expect(CLI_TARGETS.map((t) => t.fileName)).toEqual([
      "minibox-linux-x64",
      "minibox-linux-arm64",
      "minibox-darwin-x64",
      "minibox-darwin-arm64",
      "minibox-windows-x64.exe",
    ]);
    expect(CLI_TARGETS.map((t) => t.bunTarget)).toEqual([
      "bun-linux-x64",
      "bun-linux-arm64",
      "bun-darwin-x64",
      "bun-darwin-arm64",
      "bun-windows-x64",
    ]);
  });

  test("only the exact published names resolve, so a request never names a path on disk", () => {
    for (const t of CLI_TARGETS) expect(cliTargetByFileName(t.fileName)).toBe(t);
    for (const name of [
      "",
      "install.sh",
      "minibox-linux-x86",
      "minibox-linux-x64.exe",
      "minibox-windows-x64",
      "minibox-linux-x64.sha256",
      "minibox-linux-x64.tmp",
      ".minibox-download",
      "../minibox-linux-x64",
      "../../etc/passwd",
      "minibox-linux-x64/../../etc/passwd",
      "/etc/passwd",
    ]) {
      expect({ name, found: cliTargetByFileName(name) }).toEqual({ name, found: null });
    }
  });

  test("hostCliTarget maps Node's platform names, and returns null for a platform MiniBox does not publish", () => {
    expect(hostCliTarget("linux", "x64")?.id).toBe("linux-x64");
    expect(hostCliTarget("darwin", "arm64")?.id).toBe("darwin-arm64");
    expect(hostCliTarget("win32", "x64")?.fileName).toBe("minibox-windows-x64.exe");
    expect(hostCliTarget("freebsd", "x64")).toBeNull();
    expect(hostCliTarget("linux", "ia32")).toBeNull();
  });
});

describe("installer scripts", () => {
  test("the server's origin replaces the placeholder in both installers", () => {
    const sh = renderInstallScript("install.sh", "https://minibox.example:8443");
    expect(sh).toContain('MINIBOX_ORIGIN="https://minibox.example:8443"');
    expect(sh).not.toContain("__MINIBOX_ORIGIN__");
    const ps = renderInstallScript("install.ps1", "http://[::1]:3920");
    expect(ps).toContain("$origin = 'http://[::1]:3920'");
    expect(ps).not.toContain("__MINIBOX_ORIGIN__");
  });

  test("an origin that is not a plain scheme, host and port never reaches a script", () => {
    for (const origin of [
      'https://a.example";rm -rf ~;"',
      "https://a.example'; calc; '",
      "https://a.example/path",
      "https://user@a.example",
      "https://a b.example",
      "ftp://a.example",
      "https://a.example:99999999",
      "",
    ]) {
      expect(() => renderInstallScript("install.sh", origin)).toThrow("not a plain http(s) origin");
      expect(() => renderInstallScript("install.ps1", origin)).toThrow("not a plain http(s) origin");
    }
  });

  test.skipIf(!POSIX)("install.sh cut short anywhere by curl | sh runs none of its steps", () => {
    const bin = tempDir();
    const marker = join(bin, "ran");
    for (const tool of ["curl", "uname", "mkdir", "awk"]) {
      writeFileSync(join(bin, tool), `#!/bin/sh\necho ${tool} >> '${marker}'\n`);
      chmodSync(join(bin, tool), 0o755);
    }
    const script = renderInstallScript("install.sh", "https://minibox.example");
    expect(script.trimEnd().endsWith('main "$@"')).toBe(true);
    const lines = script.split("\n");
    const cut = lines.findLastIndex((line) => line.startsWith("main "));
    for (let end = 1; end < cut; end += 1) {
      const run = spawnSync("sh", ["-s"], {
        input: `${lines.slice(0, end).join("\n")}\n`,
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin },
        encoding: "utf8",
      });
      expect(run.stdout).toBe("");
      expect(statSync(marker, { throwIfNoEntry: false })).toBeUndefined();
    }
  });

  test.skipIf(SHELLCHECK === null)("install.sh is shellcheck-clean as POSIX sh, template and rendered", () => {
    const template = spawnSync(SHELLCHECK ?? "shellcheck", ["-s", "sh", join(ROOT, "src", "cli-dist", "install.sh")], {
      encoding: "utf8",
    });
    expect(template.stdout + template.stderr).toBe("");
    expect(template.status).toBe(0);
    const rendered = spawnSync(SHELLCHECK ?? "shellcheck", ["-s", "sh", "-"], {
      input: renderInstallScript("install.sh", "https://minibox.example"),
      encoding: "utf8",
    });
    expect(rendered.stdout + rendered.stderr).toBe("");
    expect(rendered.status).toBe(0);
  });
});

describe("requestOrigin", () => {
  const plain = { trustProxy: false, allowedOrigins: [] as string[] };

  test("the origin is the Host the request arrived under, over the scheme of the connection", () => {
    const req = new Request("http://minibox.internal:3920/cli/install.sh", {
      headers: { host: "minibox.internal:3920" },
    });
    expect(requestOrigin(req, plain)).toBe("http://minibox.internal:3920");
  });

  test("an ALLOWED_ORIGINS entry for the same host supplies the exact origin, scheme included", () => {
    const req = new Request("http://127.0.0.1/cli/install.sh", { headers: { host: "minibox.example.com" } });
    expect(requestOrigin(req, { trustProxy: false, allowedOrigins: ["https://minibox.example.com"] })).toBe(
      "https://minibox.example.com",
    );
  });

  test("X-Forwarded-Host and X-Forwarded-Proto count only behind a trusted proxy", () => {
    const req = new Request("http://127.0.0.1/cli/install.sh", {
      headers: { host: "127.0.0.1:3920", "x-forwarded-host": "minibox.example.com", "x-forwarded-proto": "https" },
    });
    expect(requestOrigin(req, plain)).toBe("http://127.0.0.1:3920");
    expect(requestOrigin(req, { trustProxy: true, allowedOrigins: [] })).toBe("https://minibox.example.com");
  });

  test("a Host that would break the script is refused", () => {
    const req = new Request("http://127.0.0.1/cli/install.sh", { headers: { host: 'a.example";touch x' } });
    expect(requestOrigin(req, plain)).toBeNull();
  });
});

describe("FixedWindowLimiter and Gate", () => {
  test("a client gets max requests per window, then the seconds until the window ends", () => {
    let now = 1_000;
    const limiter = new FixedWindowLimiter(2, 60_000, () => now);
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(60);
    expect(limiter.take("b")).toBe(0);
    now += 30_000;
    expect(limiter.take("a")).toBe(30);
    now += 30_000;
    expect(limiter.take("a")).toBe(0);
  });

  test("a gate runs at most its limit at once", async () => {
    const gate = new Gate(2);
    let running = 0;
    let peak = 0;
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        gate.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await Bun.sleep(5);
          running -= 1;
          return n;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(results).toEqual([1, 2, 3, 4, 5]);
  });

  test("a task that throws gives its slot to the next waiter", async () => {
    const gate = new Gate(1);
    await expect(
      gate.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await gate.run(async () => "next")).toBe("next");
  });
});

describe("CliDistribution", () => {
  test("concurrent requests for one target share one build, and every caller gets its result", async () => {
    const stub = stubBuilder();
    const dist = new CliDistribution({ dataDir: tempDir(), version: "1.0.0", root: fakeRoot(), build: stub.build });
    const linux = target("minibox-linux-x64");
    const [a, b, c] = await Promise.all([dist.artifact(linux), dist.artifact(linux), dist.artifact(linux)]);
    expect(stub.jobs).toHaveLength(1);
    expect([b, c]).toEqual([a, a]);
    expect(a.sha256).toBe(sha256("binary for linux-x64\n"));
    expect(a.size).toBe(Buffer.byteLength("binary for linux-x64\n"));
    expect(a.version).toBe("1.0.0");
  });

  test("a built binary lives under DATA_DIR/cli, so a new process serves it without building again", async () => {
    const dataDir = tempDir();
    const root = fakeRoot();
    const linux = target("minibox-linux-x64");
    const first = stubBuilder();
    const built = await new CliDistribution({ dataDir, version: "1.0.0", root, build: first.build }).artifact(linux);
    expect(first.jobs).toHaveLength(1);
    expect(built.path.startsWith(join(dataDir, "cli", "1.0.0-"))).toBe(true);
    expect(basename(built.path)).toBe("minibox-linux-x64");
    expect(statSync(built.path).mode & 0o111).not.toBe(0);

    const second = stubBuilder();
    const again = await new CliDistribution({ dataDir, version: "1.0.0", root, build: second.build }).artifact(linux);
    expect(second.jobs).toHaveLength(0);
    expect(again).toEqual(built);
  });

  test("a failed build reports its reason, leaves no partial file, and is tried again on the next request", async () => {
    const dataDir = tempDir();
    const linuxArm = target("minibox-linux-arm64");
    let attempts = 0;
    const build: CliBuilder = async (job) => {
      attempts += 1;
      await Bun.write(job.outFile, "partial");
      if (attempts === 1) throw new Error("Failed to download 'bun-linux-aarch64-v1.4.3': ConnectionRefused");
      await Bun.write(job.outFile, "ok");
    };
    const dist = new CliDistribution({ dataDir, version: "1.0.0", root: fakeRoot(), build });

    const failure = await rejectionOf(dist.artifact(linuxArm));
    expect(failure).toBeInstanceOf(CliUnavailableError);
    expect((failure as CliUnavailableError).target).toBe(linuxArm);
    expect((failure as CliUnavailableError).message).toContain("ConnectionRefused");
    const versionDir = join(dataDir, "cli", readdirSync(join(dataDir, "cli"))[0] ?? "");
    expect(readdirSync(versionDir)).toEqual([]);

    const retried = await dist.artifact(linuxArm);
    expect(attempts).toBe(2);
    expect(readFileSync(retried.path, "utf8")).toBe("ok");
  });

  test("a new version builds into its own directory, removes the old one, and keeps the runtimes cache", async () => {
    const dataDir = tempDir();
    const root = fakeRoot();
    const linux = target("minibox-linux-x64");
    await new CliDistribution({ dataDir, version: "1.0.0", root, build: stubBuilder().build }).artifact(linux);
    mkdirSync(join(dataDir, "cli", "runtimes"), { recursive: true });
    const runtime = `bun-linux-aarch64-v${Bun.version}`;
    writeFileSync(join(dataDir, "cli", "runtimes", runtime), "runtime");
    writeFileSync(join(dataDir, "cli", "runtimes", "bun-linux-aarch64-v0.9.0"), "an older Bun's runtime");

    const next = stubBuilder();
    const artifact = await new CliDistribution({ dataDir, version: "2.0.0", root, build: next.build }).artifact(linux);
    expect(next.jobs).toHaveLength(1);
    const versionDir = basename(dirname(artifact.path));
    expect(versionDir.startsWith("2.0.0-")).toBe(true);
    expect(readdirSync(join(dataDir, "cli")).toSorted()).toEqual([versionDir, "runtimes"].toSorted());
    expect(readdirSync(join(dataDir, "cli", "runtimes"))).toEqual([runtime]);
    expect(readFileSync(join(dataDir, "cli", "runtimes", runtime), "utf8")).toBe("runtime");
  });

  test("a partial build left by a crash is removed when the cache is first used, and the binary is still served", async () => {
    const dataDir = tempDir();
    const root = fakeRoot();
    const linux = target("minibox-linux-x64");
    const built = await new CliDistribution({ dataDir, version: "1.0.0", root, build: stubBuilder().build }).artifact(
      linux,
    );
    const partial = join(dirname(built.path), `.${crypto.randomUUID()}.minibox-linux-arm64`);
    writeFileSync(partial, "half a build");

    const restarted = stubBuilder();
    const again = await new CliDistribution({ dataDir, version: "1.0.0", root, build: restarted.build }).artifact(
      linux,
    );
    expect(restarted.jobs).toHaveLength(0);
    expect(again.path).toBe(built.path);
    expect(readdirSync(dirname(built.path)).filter((name) => name.startsWith("."))).toEqual([]);
  });

  test("an edit to the CLI source rebuilds even when the version has not changed", async () => {
    const dataDir = tempDir();
    const root = fakeRoot("console.log(1);\n");
    const linux = target("minibox-linux-x64");
    const before = await new CliDistribution({ dataDir, version: "1.0.0", root, build: stubBuilder().build }).artifact(
      linux,
    );
    writeFileSync(join(root, "src", "cli.ts"), "console.log(2);\n");
    const next = stubBuilder();
    const after = await new CliDistribution({ dataDir, version: "1.0.0", root, build: next.build }).artifact(linux);
    expect(next.jobs).toHaveLength(1);
    expect(after.path).not.toBe(before.path);
  });

  test("checksums lists the binaries built so far, in sha256sum format and target order", async () => {
    const dist = new CliDistribution({
      dataDir: tempDir(),
      version: "1.0.0",
      root: fakeRoot(),
      build: stubBuilder().build,
    });
    expect(await dist.checksums()).toBe("");
    await dist.artifact(target("minibox-windows-x64.exe"));
    await dist.artifact(target("minibox-linux-x64"));
    expect(await dist.checksums()).toBe(
      `${sha256("binary for linux-x64\n")}  minibox-linux-x64\n` +
        `${sha256("binary for windows-x64\n")}  minibox-windows-x64.exe\n`,
    );
  });

  test("each binary has a sha256 sidecar, and a missing one is written again without a rebuild", async () => {
    const dataDir = tempDir();
    const root = fakeRoot();
    const linux = target("minibox-linux-x64");
    const built = await new CliDistribution({ dataDir, version: "1.0.0", root, build: stubBuilder().build }).artifact(
      linux,
    );
    expect(readFileSync(`${built.path}.sha256`, "utf8")).toBe(`${built.sha256}  minibox-linux-x64\n`);

    rmSync(`${built.path}.sha256`);
    const next = stubBuilder();
    const again = await new CliDistribution({ dataDir, version: "1.0.0", root, build: next.build }).artifact(linux);
    expect(next.jobs).toHaveLength(0);
    expect(again.sha256).toBe(built.sha256);
    expect(readFileSync(`${built.path}.sha256`, "utf8")).toBe(`${built.sha256}  minibox-linux-x64\n`);
  });

  test("at most maxConcurrentBuilds compile at once, and every target is still built", async () => {
    let running = 0;
    let peak = 0;
    const build: CliBuilder = async (job) => {
      running += 1;
      peak = Math.max(peak, running);
      await Bun.sleep(10);
      await Bun.write(job.outFile, job.target.id);
      running -= 1;
    };
    const dist = new CliDistribution({
      dataDir: tempDir(),
      version: "1.0.0",
      root: fakeRoot(),
      build,
      maxConcurrentBuilds: 1,
    });
    const artifacts = await Promise.all(CLI_TARGETS.map((t) => dist.artifact(t)));
    expect(peak).toBe(1);
    expect(artifacts.map((a) => a.target.id)).toEqual(CLI_TARGETS.map((t) => t.id));
  });

  test.skipIf(HOST === null)(
    "a real build for this machine runs, and reports the version it was built from",
    async () => {
      const dist = new CliDistribution({ dataDir: tempDir(), version: "0.0.0-real", root: ROOT });
      const artifact = await dist.artifact(hostTarget());
      const ran = await capture([artifact.path, "--version"]);
      expect(ran.code).toBe(0);
      expect(ran.stdout).toBe("minibox 0.0.0-real\n");
      expect(sha256(readFileSync(artifact.path))).toBe(artifact.sha256);
    },
    REAL_BUILD_MS,
  );
});

describe("the /cli routes", () => {
  test("GET /cli/<binary> streams the file under its name, with its checksum and build version", async () => {
    const h = startHarness({}, { cliBuild: stubBuilder().build });
    try {
      const res = await fetch(`${h.base}/cli/minibox-linux-x64`);
      const body = new Uint8Array(await res.arrayBuffer());
      expect(res.status).toBe(200);
      expect(Buffer.from(body).toString()).toBe("binary for linux-x64\n");
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="minibox-linux-x64"');
      expect(res.headers.get("x-checksum-sha256")).toBe(sha256(body));
      expect(res.headers.get("x-minibox-version")).toBe("0.0.0-test");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    } finally {
      h.stop();
    }
  });

  test("every published target is served under its own file name, including the Windows .exe", async () => {
    const h = startHarness({}, { cliBuild: stubBuilder().build });
    try {
      for (const t of CLI_TARGETS) {
        const res = await fetch(`${h.base}/cli/${t.fileName}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${t.fileName}"`);
        expect(await res.text()).toBe(`binary for ${t.id}\n`);
      }
    } finally {
      h.stop();
    }
  });

  test("GET /cli/checksums.txt lists the binaries built so far", async () => {
    const h = startHarness({}, { cliBuild: stubBuilder().build });
    try {
      const empty = await fetch(`${h.base}/cli/checksums.txt`);
      expect(empty.status).toBe(200);
      expect(await empty.text()).toBe("");
      await (await fetch(`${h.base}/cli/minibox-linux-x64`)).arrayBuffer();
      const res = await fetch(`${h.base}/cli/checksums.txt`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await res.text()).toBe(`${sha256("binary for linux-x64\n")}  minibox-linux-x64\n`);
    } finally {
      h.stop();
    }
  });

  test("GET /cli/install.sh and install.ps1 serve the installers with this server's address", async () => {
    const h = startHarness({}, { cliBuild: stubBuilder().build });
    try {
      const sh = await fetch(`${h.base}/cli/install.sh`);
      const shText = await sh.text();
      expect(sh.status).toBe(200);
      expect(sh.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(sh.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(shText.startsWith("#!/bin/sh\n")).toBe(true);
      expect(shText).toContain(`MINIBOX_ORIGIN="${h.base}"`);
      expect(shText).not.toContain("__MINIBOX_ORIGIN__");

      const ps = await fetch(`${h.base}/cli/install.ps1`);
      const psText = await ps.text();
      expect(ps.status).toBe(200);
      expect(psText).toContain(`$origin = '${h.base}'`);
      expect(psText).not.toContain("__MINIBOX_ORIGIN__");
    } finally {
      h.stop();
    }
  });

  test("only the whitelisted names are served: no other path reaches the build or the disk", async () => {
    const stub = stubBuilder();
    const h = startHarness({}, { cliBuild: stub.build });
    try {
      for (const path of [
        "/cli/",
        "/cli/minibox-linux-x86",
        "/cli/minibox-linux-x64.sha256",
        "/cli/minibox-windows-x64",
        "/cli/minibox-linux-x64/extra",
        "/cli/install.sh/extra",
        "/cli/nope/minibox-linux-x64",
        "/cli/..%2F..%2Fetc%2Fpasswd",
        "/cli/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
        "/cli/%E0%A4%A",
      ]) {
        const res = await fetch(`${h.base}${path}`);
        expect({ path, status: res.status }).toEqual({ path, status: 404 });
      }
      expect(stub.jobs).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("the CLI routes accept GET only, and answer anything else with 405 and Allow: GET", async () => {
    const stub = stubBuilder();
    const h = startHarness({}, { cliBuild: stub.build });
    try {
      for (const path of ["/cli/install.sh", "/cli/install.ps1", "/cli/checksums.txt", "/cli/minibox-linux-x64"]) {
        const res = await fetch(`${h.base}${path}`, { method: "POST", body: "x" });
        expect({ path, status: res.status, allow: res.headers.get("allow") }).toEqual({
          path,
          status: 405,
          allow: "GET",
        });
      }
      expect(stub.jobs).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("a target that cannot be built answers 503 with the reason and the fallbacks", async () => {
    const h = startHarness(
      {},
      {
        cliBuild: async () => {
          throw new Error("Failed to download 'bun-linux-aarch64-v1.4.3': ConnectionRefused");
        },
      },
    );
    try {
      const res = await fetch(`${h.base}/cli/minibox-linux-arm64`);
      const body = await res.text();
      expect(res.status).toBe(503);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(body).toContain("MiniBox could not build the CLI for linux-arm64 on this server");
      expect(body).toContain("ConnectionRefused");
      expect(body).toContain("Fallback: build it from a checkout with bun run build:cli");
      expect(body).toContain("HTTPS_PROXY");
    } finally {
      h.stop();
    }
  });

  test("a client that makes more than 120 requests in a minute is refused until the window ends", async () => {
    const h = startHarness({}, { cliBuild: stubBuilder().build });
    try {
      for (let i = 0; i < 120; i += 1) {
        const res = await fetch(`${h.base}/cli/install.sh`);
        expect(res.status).toBe(200);
        await res.arrayBuffer();
      }
      const refused = await fetch(`${h.base}/cli/install.sh`);
      expect(refused.status).toBe(429);
      const wait = Number(refused.headers.get("retry-after"));
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(60);
    } finally {
      h.stop();
    }
  });

  test.skipIf(HOST === null)(
    "the default builder serves a real binary whose checksum header matches its bytes",
    async () => {
      const h = startHarness();
      try {
        const res = await fetch(`${h.base}/cli/${hostTarget().fileName}`);
        const body = new Uint8Array(await res.arrayBuffer());
        expect(res.status).toBe(200);
        expect(res.headers.get("x-checksum-sha256")).toBe(sha256(body));
      } finally {
        h.stop();
      }
    },
    REAL_BUILD_MS,
  );
});

describe.skipIf(!POSIX || HOST === null)("install.sh, run as curl | sh", () => {
  test("installs the binary the server built after checking it against checksums.txt, and prints the next steps", async () => {
    const h = startHarness({}, { cliBuild: stubBuilder(() => STUB_CLI).build });
    const work = tempDir();
    try {
      const ran = await capture(curlInstall(h.base), installEnv(work));
      expect(ran.stderr).toBe("");
      expect(ran.code).toBe(0);
      const installed = join(work, "bin", "minibox");
      expect(ran.stdout).toContain(`Installed ${installed} (minibox 0.0.0-test)`);
      expect(ran.stdout).toContain(`${join(work, "bin")} is not on your PATH yet`);
      expect(ran.stdout).toContain(`MINIBOX_URL=${h.base} MINIBOX_ACCESS_KEY=<token> minibox ssh-config --append`);
      expect(readdirSync(join(work, "bin"))).toEqual(["minibox"]);
      expect(statSync(installed).mode & 0o777).toBe(0o755);
      expect(readFileSync(installed, "utf8")).toBe(STUB_CLI);
    } finally {
      h.stop();
    }
  });

  test("a binary that differs from its published checksum is not installed", async () => {
    const h = startHarness({}, { cliBuild: stubBuilder(() => STUB_CLI).build });
    const work = tempDir();
    try {
      const artifact = await h.app.cli.artifact(hostTarget());
      writeFileSync(`${artifact.path}.sha256`, `${sha256("not the binary")}  ${artifact.target.fileName}\n`);
      const ran = await capture(curlInstall(h.base), installEnv(work));
      expect(ran.code).not.toBe(0);
      expect(ran.stderr).toContain(`checksum mismatch for ${artifact.target.fileName}`);
      expect(ran.stderr).toContain("Nothing was installed.");
      expect(readdirSync(join(work, "bin"))).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test("when the server cannot build the binary, the installer stops and shows the server's reason", async () => {
    const h = startHarness(
      {},
      {
        cliBuild: async () => {
          throw new Error("Failed to download 'bun-linux-aarch64-v1.4.3': ConnectionRefused");
        },
      },
    );
    const work = tempDir();
    try {
      const ran = await capture(curlInstall(h.base), installEnv(work));
      expect(ran.code).not.toBe(0);
      expect(ran.stderr).toContain(`answered HTTP 503 for minibox-${hostTarget().id}`);
      expect(ran.stderr).toContain(`could not build the CLI for ${hostTarget().id}`);
      expect(ran.stderr).toContain("ConnectionRefused");
      expect(ran.stderr).toContain("HTTPS_PROXY");
      expect(readdirSync(join(work, "bin"))).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test(
    "the real build installs with curl | sh, and the installed CLI reports its version and its ssh-config help",
    async () => {
      const h = startHarness();
      const work = tempDir();
      try {
        const ran = await capture(curlInstall(h.base), installEnv(work));
        expect(ran.code).toBe(0);
        expect(ran.stdout).toContain("(minibox 0.0.0-test)");
        const installed = join(work, "bin", "minibox");
        const version = await capture([installed, "--version"]);
        expect(version.code).toBe(0);
        expect(version.stdout).toBe("minibox 0.0.0-test\n");
        const help = await capture([installed, "ssh-config", "--help"]);
        expect(help.code).toBe(0);
        expect(help.stdout).toContain("minibox ssh-config [--append]");
      } finally {
        h.stop();
      }
    },
    REAL_BUILD_MS,
  );
});

/** Runs one PowerShell command line, as `irm <url> | iex` would be typed into pwsh. */
function powershell(command: string, env: Record<string, string>): Promise<Ran> {
  return capture([PWSH ?? "pwsh", "-NoProfile", "-NonInteractive", "-Command", command], env);
}

describe.skipIf(PWSH === null || process.platform !== "linux")("install.ps1 under PowerShell on Linux", () => {
  test("the installer parses without errors", async () => {
    const file = join(tempDir(), "install.ps1");
    writeFileSync(file, renderInstallScript("install.ps1", "https://minibox.example"));
    const parsed = await powershell(
      `$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$errors); $errors | ForEach-Object { $_.Message }; exit $errors.Count`,
      {},
    );
    expect(parsed.stdout + parsed.stderr).toBe("");
    expect(parsed.code).toBe(0);
  }, 60_000);

  test("a download that differs from its published checksum is not installed", async () => {
    const h = startHarness({}, { cliBuild: stubBuilder(() => STUB_CLI).build });
    const work = tempDir();
    try {
      const artifact = await h.app.cli.artifact(target("minibox-windows-x64.exe"));
      writeFileSync(`${artifact.path}.sha256`, `${sha256("not the binary")}  minibox-windows-x64.exe\n`);
      const ran = await powershell(`irm ${h.base}/cli/install.ps1 | iex`, installEnv(work));
      expect(ran.code).not.toBe(0);
      expect(ran.stdout + ran.stderr).toContain("Checksum mismatch for minibox-windows-x64.exe");
      expect(ran.stdout + ran.stderr).toContain("Nothing was installed.");
      expect(readdirSync(join(work, "bin"))).toEqual([]);
    } finally {
      h.stop();
    }
  }, 60_000);

  test("a matching download is saved as minibox.exe, and the run step refuses it on Linux", async () => {
    const h = startHarness({}, { cliBuild: stubBuilder(() => STUB_CLI).build });
    const work = tempDir();
    try {
      const ran = await powershell(`irm ${h.base}/cli/install.ps1 | iex`, installEnv(work));
      const output = ran.stdout + ran.stderr;
      expect(ran.code).not.toBe(0);
      expect(output).not.toContain("Checksum mismatch");
      expect(output).toContain("was installed, but it does not run on this machine");
      expect(readFileSync(join(work, "bin", "minibox.exe"), "utf8")).toBe(STUB_CLI);
      expect(readdirSync(join(work, "bin"))).toEqual(["minibox.exe"]);
    } finally {
      h.stop();
    }
  }, 60_000);
});
