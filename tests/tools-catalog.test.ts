import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppError } from "../src/lib/errors";
import { desiredToolsOf, installEnv } from "../src/services/tools";
import { findCatalogEntry, loadCatalog, parseCatalogEntry } from "../src/tools/catalog";
import { commandFor, detectCommand, packageSpec, renderCommand } from "../src/tools/commands";
import type { CatalogEntry } from "../src/tools/types";

const sample: CatalogEntry = {
  id: "claude-code",
  name: "Claude Code",
  description: "test",
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

describe("tool catalog parse", () => {
  test("accepts a valid entry and rejects a bad id", () => {
    const entry = parseCatalogEntry({ ...sample, requires: "Node ≥ 20" }, "x.json");
    expect(entry.requires).toBe("Node ≥ 20");
    expect(() => parseCatalogEntry({ ...sample, id: "Bad_ID" }, "x.json")).toThrow(AppError);
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

describe("tool command generation", () => {
  test("pins npm and pip package specs", () => {
    expect(packageSpec(sample, "latest")).toBe("@anthropic-ai/claude-code@latest");
    expect(packageSpec(sample, "1.2.3")).toBe("@anthropic-ai/claude-code@1.2.3");
    const pip: CatalogEntry = { ...sample, id: "aider", source: "pip", package: "aider-chat", bin: "aider" };
    expect(packageSpec(pip, "latest")).toBe("aider-chat");
    expect(packageSpec(pip, "0.80.0")).toBe("aider-chat==0.80.0");
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
    const catalog = loadCatalog(mkdtempSync(join(tmpdir(), "mb-tools-empty-")));
    expect(desiredToolsOf(["claude-code", "claude-code"], catalog)).toEqual([{ id: "claude-code", version: "latest" }]);
    expect(() => desiredToolsOf(["no-such-tool"], catalog)).toThrow(AppError);
  });
});
