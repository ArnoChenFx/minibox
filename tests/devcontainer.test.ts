import { describe, expect, test } from "bun:test";

import { DEVCONTAINER_PATHS, envInstructions, readDevcontainer } from "../src/lib/devcontainer";
import { parseJsonc } from "../src/lib/jsonc";

function planOf(text: string) {
  const reading = readDevcontainer(text);
  if (!("plan" in reading)) throw new Error(`expected a plan, got ${reading.problem.key}`);
  return reading.plan;
}

function problemOf(text: string) {
  const reading = readDevcontainer(text);
  if ("plan" in reading) throw new Error("expected a problem, got a plan");
  return reading.problem;
}

describe("parseJsonc", () => {
  test("reads line and block comments and trailing commas", () => {
    const value = parseJsonc('{\n  "a": 1, // the first\n  /* the second */ "b": [1, 2,],\n}');
    expect(value).toEqual({ a: 1, b: [1, 2] });
  });

  test("keeps comment markers that sit inside a string", () => {
    expect(parseJsonc('{"url": "https://x.test/a//b", "esc": "a\\"//c"}')).toEqual({
      url: "https://x.test/a//b",
      esc: 'a"//c',
    });
  });

  test("strips a byte order mark", () => {
    expect(parseJsonc("\uFEFF{}")).toEqual({});
  });

  test("throws on an unterminated string or comment", () => {
    expect(() => parseJsonc('{"a": "open')).toThrow(SyntaxError);
    expect(() => parseJsonc("{ /* never closed")).toThrow(SyntaxError);
  });
});

describe("devcontainer.json as a plan", () => {
  test("the locations searched, in order, start with the spec's path", () => {
    expect(DEVCONTAINER_PATHS).toEqual([".devcontainer/devcontainer.json", ".devcontainer.json"]);
  });

  test("an image becomes the base, with containerEnv, and nothing else is set", () => {
    expect(planOf('{"image": "node:24-bookworm-slim", "containerEnv": {"NODE_ENV": "development"}}')).toEqual({
      base: { kind: "image", image: "node:24-bookworm-slim" },
      env: { NODE_ENV: "development" },
      forwardPorts: [],
      warnings: [],
    });
  });

  test("a build gives the Dockerfile, the context and the build args, and the context defaults to the file's directory", () => {
    expect(planOf('{"build": {"dockerfile": "Dockerfile", "args": {"VERSION": "2"}}}')).toMatchObject({
      base: { kind: "build", dockerfile: "Dockerfile", context: ".", args: { VERSION: "2" } },
      env: {},
    });
    expect(planOf('{"build": {"dockerfile": "../Dockerfile", "context": "..", "args": {}}}').base).toEqual({
      kind: "build",
      dockerfile: "../Dockerfile",
      context: "..",
      args: {},
    });
  });

  test("build.target names the stage to build", () => {
    expect(planOf('{"build": {"dockerfile": "Dockerfile", "target": "dev"}}').base).toEqual({
      kind: "build",
      dockerfile: "Dockerfile",
      context: ".",
      args: {},
      target: "dev",
    });
  });

  test("$schema and name are metadata and change nothing", () => {
    expect(planOf('{"$schema": "https://x.test/s.json", "name": "dev", "image": "alpine:3.20"}')).toMatchObject({
      base: { kind: "image", image: "alpine:3.20" },
      warnings: [],
    });
  });

  test("a file with neither an image nor a build, or with both, is refused", () => {
    expect(problemOf("{}").key).toBe("devcontainer_source");
    expect(problemOf('{"image": "alpine", "build": {"dockerfile": "Dockerfile"}}').key).toBe("devcontainer_source");
  });

  test("an image reference with characters a registry name cannot hold is refused", () => {
    expect(problemOf('{"image": "node 24"}').key).toBe("image_ref_invalid");
    expect(problemOf('{"image": 24}').key).toBe("image_ref_invalid");
  });

  test("a file that is not JSON, or not an object, is refused as invalid", () => {
    expect(problemOf("{").key).toBe("devcontainer_invalid");
    expect(problemOf("[]").key).toBe("devcontainer_invalid");
    expect(problemOf('"text"').key).toBe("devcontainer_invalid");
  });
});

describe("settings minibox does not apply are warnings", () => {
  test("a top-level setting minibox does not read is listed by name and the plan is still made", () => {
    const plan = planOf('{"image": "alpine", "features": {"ghcr.io/x/y:1": {}}}');
    expect(plan.base).toEqual({ kind: "image", image: "alpine" });
    expect(plan.warnings).toEqual(["features is not supported, so it was not applied."]);
  });

  test("lifecycle commands other than postCreateCommand are warned about and never run", () => {
    const plan = planOf(
      '{"image": "alpine", "initializeCommand": "make", "onCreateCommand": "make", "postStartCommand": "make", "mounts": []}',
    );
    expect(plan.postCreate).toBeUndefined();
    expect(plan.warnings).toEqual([
      "initializeCommand is not supported, so it was not applied.",
      "onCreateCommand is not supported, so it was not applied.",
      "postStartCommand is not supported, so it was not applied.",
      "mounts is not supported, so it was not applied.",
    ]);
  });

  test("a build setting minibox does not read is listed as a warning, with the build target kept", () => {
    const plan = planOf('{"build": {"dockerfile": "Dockerfile", "target": "dev", "cacheFrom": "x"}}');
    expect(plan.base).toMatchObject({ kind: "build", target: "dev" });
    expect(plan.warnings).toEqual(["build.cacheFrom is not supported, so it was not applied."]);
  });

  test("remoteUser is applied when it is dev or 1000, and warned about otherwise", () => {
    expect(planOf('{"image": "alpine", "remoteUser": "dev"}').warnings).toEqual([]);
    expect(planOf('{"image": "alpine", "remoteUser": 1000}').warnings).toEqual([]);
    expect(planOf('{"image": "alpine", "remoteUser": "root"}').warnings).toEqual([
      'remoteUser "root" is not supported, because MiniBox runs commands as dev. It was not applied.',
    ]);
  });

  test("a remoteEnv entry set to null is left out with a warning, since minibox cannot unset a variable", () => {
    const plan = planOf('{"image": "alpine", "remoteEnv": {"GONE": null, "KEEP": "yes"}}');
    expect(plan.env).toEqual({ KEEP: "yes" });
    expect(plan.warnings).toEqual([
      "remoteEnv.GONE is null, which would unset it. MiniBox cannot unset a variable, so it was not applied.",
    ]);
  });

  test("a forwardPorts entry that is not a port in the box is listed with a warning, and the ports are kept", () => {
    const plan = planOf('{"image": "alpine", "forwardPorts": [3000, "8080", "db:5432", 3000]}');
    expect(plan.forwardPorts).toEqual([3000, 8080]);
    expect(plan.warnings).toEqual(['forwardPorts entry "db:5432" is not a port in the box, so it was not forwarded.']);
  });

  test("an object-form postCreateCommand runs several commands in parallel, so it is warned about and not run", () => {
    const plan = planOf('{"image": "alpine", "postCreateCommand": {"a": "npm ci", "b": "make"}}');
    expect(plan.postCreate).toBeUndefined();
    expect(plan.warnings).toEqual([
      "postCreateCommand as an object runs several commands in parallel, which is not supported, so it was not run.",
    ]);
  });
});

describe("the setup a plan keeps", () => {
  test("a string postCreateCommand runs under /bin/sh -c, and a list runs as written", () => {
    expect(planOf('{"image": "alpine", "postCreateCommand": "npm ci && npm test"}').postCreate).toEqual([
      "/bin/sh",
      "-c",
      "npm ci && npm test",
    ]);
    expect(planOf('{"image": "alpine", "postCreateCommand": ["make", "install"]}').postCreate).toEqual([
      "make",
      "install",
    ]);
  });

  test("an empty postCreateCommand is no command at all", () => {
    expect(planOf('{"image": "alpine", "postCreateCommand": ""}').postCreate).toBeUndefined();
    expect(planOf('{"image": "alpine", "postCreateCommand": []}').postCreate).toBeUndefined();
  });

  test("forwardPorts keeps each TCP port in the box once, as a number", () => {
    expect(planOf('{"image": "alpine", "forwardPorts": [5173, "5173", 8000]}').forwardPorts).toEqual([5173, 8000]);
  });

  test("remoteEnv sets over containerEnv with the same name", () => {
    expect(
      planOf('{"image": "alpine", "containerEnv": {"A": "from-container"}, "remoteEnv": {"A": "from-remote"}}').env,
    ).toEqual({ A: "from-remote" });
  });
});

describe("values minibox cannot apply as written are refused", () => {
  test("a containerEnv or remoteEnv name that is not an identifier, or a value that uses ${…} or a line break, is refused", () => {
    expect(problemOf('{"image": "alpine", "containerEnv": {"1A": "x"}}').key).toBe("devcontainer_value_invalid");
    expect(problemOf('{"image": "alpine", "containerEnv": {"PATH_X": "${localEnv:HOME}"}}').key).toBe(
      "devcontainer_value_invalid",
    );
    expect(problemOf('{"image": "alpine", "containerEnv": {"A": "line\\nbreak"}}').key).toBe(
      "devcontainer_value_invalid",
    );
    expect(problemOf('{"image": "alpine", "remoteEnv": {"A": "${containerEnv:B}"}}').key).toBe(
      "devcontainer_value_invalid",
    );
  });

  test("a postCreateCommand that names a devcontainer variable is refused, because minibox does not expand it", () => {
    expect(problemOf('{"image": "alpine", "postCreateCommand": "cd ${containerWorkspaceFolder} && make"}')).toEqual(
      expect.objectContaining({
        key: "devcontainer_variable",
        params: { name: "postCreateCommand", variable: "${containerWorkspaceFolder}" },
      }),
    );
    expect(problemOf('{"image": "alpine", "postCreateCommand": ["echo", "${localEnv:HOME}"]}').key).toBe(
      "devcontainer_variable",
    );
  });

  test("a postCreateCommand longer than 64 KB is refused", () => {
    const long = "x".repeat(64 * 1024 + 1);
    expect(problemOf(`{"image": "alpine", "postCreateCommand": "${long}"}`).key).toBe("devcontainer_invalid");
  });

  test("a postCreateCommand that is neither a string nor a list of strings is refused as invalid", () => {
    expect(problemOf('{"image": "alpine", "postCreateCommand": 3}').key).toBe("devcontainer_invalid");
    expect(problemOf('{"image": "alpine", "postCreateCommand": ["ok", 3]}').key).toBe("devcontainer_invalid");
  });

  test("forwardPorts that is not a list is refused as invalid", () => {
    expect(problemOf('{"image": "alpine", "forwardPorts": 3000}').key).toBe("devcontainer_invalid");
  });

  test("a build target that is not a stage name is refused", () => {
    expect(problemOf('{"build": {"dockerfile": "Dockerfile", "target": "dev stage"}}').key).toBe(
      "devcontainer_target_invalid",
    );
    expect(problemOf('{"build": {"dockerfile": "Dockerfile", "target": 3}}').key).toBe("devcontainer_target_invalid");
  });
});

describe("envInstructions", () => {
  test("one ENV line per entry, with backslashes, quotes and dollar signs escaped", () => {
    expect(envInstructions({ A: 'say "hi"', B: "C:\\tmp", D: "$HOME and ${X}" })).toBe(
      'ENV A="say \\"hi\\""\nENV B="C:\\\\tmp"\nENV D="\\$HOME and \\${X}"\n',
    );
  });

  test("no entries write nothing", () => {
    expect(envInstructions({})).toBe("");
  });
});
