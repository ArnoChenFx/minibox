import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";
import { OFFICIAL_NAMES } from "../src/services/official-templates";

/**
 * The CI workflow is not run by `bun test`, so these tests read it. They pin the arm64 smoke checks of the official
 * templates: a Dockerfile that only builds on one architecture is caught by CI, and a step that quietly stops loading
 * the arm64 image would leave the job green while checking nothing.
 */
const WORKFLOW = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
const DEV_DOCS = readFileSync(join(ROOT, "docs", "development.md"), "utf8");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

interface Job {
  steps: Step[];
  strategy?: { matrix?: { include?: Record<string, unknown>[] } };
}

const parsed = Bun.YAML.parse(WORKFLOW) as { jobs: Record<string, Job> };
const job = parsed.jobs["official-templates"];
const steps = job?.steps ?? [];
const stepNamed = (name: string) => steps.find((step) => step.name === name);

/** The minimal template has no language toolchain, so its job names the tools the image ships. */
const MINIMAL_TOOLS = "git curl ps tmux jq rg ssh unzip less vim.tiny ping socat bwrap python3";

describe("the official templates are built and checked for both architectures", () => {
  test("the workflow parses and keeps the job, its matrix and the amd64 check", () => {
    expect(job).toBeDefined();
    const templates = (job?.strategy?.matrix?.include ?? []).map((entry) => entry.template);
    expect(templates).toEqual([...OFFICIAL_NAMES]);
    const amd64 = stepNamed("Build the ${{ matrix.template }} template for linux/amd64");
    expect(amd64?.with?.platforms).toBe("linux/amd64");
    expect(amd64?.with?.load).toBe(true);
    const checks = steps.filter(
      (step) => step.run === "scripts/check-box-image.sh minibox-official:${{ matrix.template }}",
    );
    expect(checks).toHaveLength(1);
  });

  test("the runner emulates arm64", () => {
    expect(steps.map((step) => step.uses)).toContain("docker/setup-qemu-action@v4");
  });

  test("both platforms go into one cache scope before either image is loaded", () => {
    const scope = "type=gha,scope=official-${{ matrix.template }}";
    const warm = stepNamed("The ${{ matrix.template }} template builds for linux/amd64 and linux/arm64");
    expect(warm?.with).toMatchObject({
      platforms: "linux/amd64,linux/arm64",
      push: false,
      outputs: "type=cacheonly",
      "cache-from": scope,
      "cache-to": "type=gha,mode=max,scope=official-${{ matrix.template }}",
    });
    // The warm-up is the only step that writes the cache, and it runs before the two loaded builds.
    expect(steps.filter((step) => step.with?.["cache-to"] !== undefined).map((step) => step.name)).toEqual([
      warm?.name,
    ]);
    const loads = steps.filter((step) => step.with?.load === true).map((step) => step.with?.platforms);
    expect(loads).toEqual(["linux/amd64", "linux/arm64"]);
    for (const step of steps.filter((candidate) => candidate.with?.load === true)) {
      expect(step.with?.["cache-from"]).toBe(scope);
    }
  });

  test("the arm64 image is loaded under its own tag and checked with PLATFORM set", () => {
    const arm64 = stepNamed("Build the ${{ matrix.template }} template for linux/arm64 (emulated)");
    expect(arm64?.with).toMatchObject({
      context: "templates/official/${{ matrix.template }}",
      platforms: "linux/arm64",
      load: true,
      tags: "minibox-official:${{ matrix.template }}-arm64",
    });
    const check = stepNamed("Box checks on linux/arm64 (emulated)");
    expect(check?.run).toBe(
      "PLATFORM=linux/arm64 scripts/check-box-image.sh minibox-official:${{ matrix.template }}-arm64",
    );
    // The check runs after the image is loaded, and PLATFORM makes the script verify the architecture itself.
    expect(steps.indexOf(check as Step)).toBeGreaterThan(steps.indexOf(arm64 as Step));
  });

  test("the minimal template checks only the tools it ships, on both architectures", () => {
    const minimal = (job?.strategy?.matrix?.include ?? []).find((entry) => entry.template === "minimal");
    expect(minimal?.tools).toBe(MINIMAL_TOOLS);
    const required = steps.filter((step) => step.env?.REQUIRED_TOOLS === "${{ matrix.tools }}");
    expect(required.map((step) => step.name)).toEqual([
      "Box checks on linux/amd64",
      "Box checks on linux/arm64 (emulated)",
    ]);
  });

  test("the action versions are pinned the way the rest of the workflow pins them", () => {
    const versions = new Set(steps.flatMap((step) => (step.uses ? [step.uses] : [])));
    expect(versions).toEqual(
      new Set([
        "actions/checkout@v7",
        "docker/setup-qemu-action@v4",
        "docker/setup-buildx-action@v4",
        "docker/build-push-action@v7",
      ]),
    );
  });
});

describe("the docs describe the arm64 check", () => {
  test("the CI table in docs/development.md names the arm64 build of the official templates", () => {
    const row = DEV_DOCS.split("\n").find((line) => line.startsWith("| CI (`ci.yml`)"));
    expect(row).toContain("`official-templates` job builds each official template for `linux/amd64` and `linux/arm64`");
    expect(row).toContain("QEMU");
  });

  test("both template guides say CI checks the official templates on arm64", () => {
    for (const path of ["docs/user-guide/templates.md", "docs/zh-CN/user-guide/templates.md"]) {
      const text = readFileSync(join(ROOT, path), "utf8");
      expect([path, /`linux\/amd64`/.test(text) && /`linux\/arm64`/.test(text) && /QEMU/.test(text)]).toEqual([
        path,
        true,
      ]);
      expect([path, text.includes("`official-templates`")]).toEqual([path, true]);
    }
  });
});
