import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const DOCKER_DIR = join(SRC, "docker");
const isWithin = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

interface SourceFile {
  path: string;
  rel: string;
  imports: string[];
}

function listSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** Module specifiers of static imports, re-exports, side-effect imports and dynamic imports. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

function readSources(): SourceFile[] {
  return listSources(SRC).map((path) => ({
    path,
    rel: relative(SRC, path),
    imports: [...readFileSync(path, "utf8").matchAll(SPECIFIER)].map((m) => m[1] ?? ""),
  }));
}

describe("runtime boundary", () => {
  const files = readSources();
  const bySource = (rel: string) => files.find((f) => f.rel === rel);

  test("the scan covers the source tree, so the rules below cannot pass vacuously", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.map((f) => f.rel)).toEqual(
      expect.arrayContaining(["app.ts", "docker/runtime.ts", "services/boxes.ts", "ws/terminal.ts", "host/metrics.ts"]),
    );
    expect(bySource("docker/runtime.ts")?.imports).toContain("dockerode");
    expect(bySource("app.ts")?.imports).toContain("./docker/runtime");
  });

  test("only src/docker imports dockerode", () => {
    const offenders = files
      .filter((f) => !isWithin(f.path, DOCKER_DIR))
      .filter((f) => f.imports.some((s) => s === "dockerode" || s.startsWith("dockerode/")))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  test("only the composition root (app.ts) and src/docker import the Docker adapter", () => {
    const offenders = files
      .filter((f) => f.rel !== "app.ts" && !isWithin(f.path, DOCKER_DIR))
      .filter((f) => f.imports.some((s) => s.startsWith(".") && isWithin(resolve(dirname(f.path), s), DOCKER_DIR)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});

/** The module, relative to src, that a relative import points at. Package imports have no target. */
function targetOf(file: SourceFile, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  return relative(SRC, resolve(dirname(file.path), specifier));
}

const reaches = (target: string, module: string) => target === module || target.startsWith(module + sep);

const inDir = (file: SourceFile, dir: string) => file.rel.startsWith(dir + sep);

describe("operation boundary", () => {
  const files = readSources();
  const HTTP_AND_ROOT = ["app", "server", "guard", "static", "ws", "routes", "lib/http"];

  test("the scan covers the operation layer", () => {
    expect(files.filter((f) => inDir(f, "operations")).length).toBeGreaterThan(5);
  });

  test("the operation layer does not depend on HTTP or the composition root", () => {
    const offenders = files
      .filter((f) => inDir(f, "operations"))
      .flatMap((f) =>
        f.imports
          .filter((s) => {
            const target = targetOf(f, s);
            return target !== undefined && HTTP_AND_ROOT.some((module) => reaches(target, module));
          })
          .map((s) => `${f.rel} imports ${s}`),
      );
    expect(offenders).toEqual([]);
  });

  test("the REST adapter reaches the engine only through the operations", () => {
    const adapter = files.find((f) => f.rel === join("routes", "operations.ts"));
    expect(adapter).toBeDefined();
    const offenders = (adapter?.imports ?? []).filter((s) => {
      const target = adapter ? targetOf(adapter, s) : undefined;
      return target !== undefined && ["services", "runtime", "docker"].some((module) => reaches(target, module));
    });
    expect(offenders).toEqual([]);
  });
});
