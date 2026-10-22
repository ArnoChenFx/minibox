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
  return reading;
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

  test("an image becomes the base, with containerEnv", () => {
    expect(planOf('{"image": "node:24-bookworm-slim", "containerEnv": {"NODE_ENV": "development"}}')).toEqual({
      base: { kind: "image", image: "node:24-bookworm-slim" },
      env: { NODE_ENV: "development" },
    });
  });

  test("a build gives the Dockerfile, the context and the build args, and the context defaults to the file's directory", () => {
    expect(planOf('{"build": {"dockerfile": "Dockerfile", "args": {"VERSION": "2"}}}')).toEqual({
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

  test("$schema and name are metadata and change nothing", () => {
    expect(planOf('{"$schema": "https://x.test/s.json", "name": "dev", "image": "alpine:3.20"}').base).toEqual({
      kind: "image",
      image: "alpine:3.20",
    });
  });

  test("a file with neither an image nor a build, or with both, is refused", () => {
    expect(problemOf("{}").problem.key).toBe("devcontainer_source");
    expect(problemOf('{"image": "alpine", "build": {"dockerfile": "Dockerfile"}}').problem.key).toBe(
      "devcontainer_source",
    );
  });

  test("a top-level setting minibox does not read is refused by name, with a hint", () => {
    const reading = problemOf('{"image": "alpine", "features": {"ghcr.io/x/y:1": {}}}');
    expect(reading.problem.key).toBe("devcontainer_unsupported");
    expect(reading.problem.params).toEqual({ keys: "features" });
    expect(reading.hint?.key).toBe("devcontainer_unsupported_hint");
  });

  test("postCreateCommand is refused with the hint that explains why it is not run", () => {
    const reading = problemOf('{"image": "alpine", "postCreateCommand": "npm install"}');
    expect(reading.problem.key).toBe("devcontainer_unsupported");
    expect(reading.hint?.key).toBe("devcontainer_post_create");
  });

  test("a build setting minibox does not read is refused", () => {
    const reading = problemOf('{"build": {"dockerfile": "Dockerfile", "target": "dev"}}');
    expect(reading.problem.params).toEqual({ keys: "build.target" });
  });

  test("an image reference with characters a registry name cannot hold is refused", () => {
    expect(problemOf('{"image": "node 24"}').problem.key).toBe("image_ref_invalid");
    expect(problemOf('{"image": 24}').problem.key).toBe("image_ref_invalid");
  });

  test("a containerEnv name that is not an identifier, or a value that uses ${…}, is refused", () => {
    expect(problemOf('{"image": "alpine", "containerEnv": {"1A": "x"}}').problem.key).toBe(
      "devcontainer_value_invalid",
    );
    expect(problemOf('{"image": "alpine", "containerEnv": {"PATH_X": "${localEnv:HOME}"}}').problem.key).toBe(
      "devcontainer_value_invalid",
    );
    expect(problemOf('{"image": "alpine", "containerEnv": {"A": "line\\nbreak"}}').problem.key).toBe(
      "devcontainer_value_invalid",
    );
  });

  test("a file that is not JSON, or not an object, is refused as invalid", () => {
    expect(problemOf("{").problem.key).toBe("devcontainer_invalid");
    expect(problemOf("[]").problem.key).toBe("devcontainer_invalid");
    expect(problemOf('"text"').problem.key).toBe("devcontainer_invalid");
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
