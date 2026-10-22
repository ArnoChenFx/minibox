import { describe, expect, test } from "bun:test";

import {
  contextUrlProblem,
  DOCKERFILE_MAX_BYTES,
  dockerfileProblem,
  isSshRepoUrl,
  relativePathProblem,
  repoBranchProblem,
  repoUrlProblem,
  resolveInside,
  SOURCE_URL_MAX,
} from "../src/lib/source";

describe("build context URLs", () => {
  test("accept http and https with no credentials", () => {
    expect(contextUrlProblem("https://example.com/ctx.tar.gz")).toBeNull();
    expect(contextUrlProblem("http://example.com/ctx.tar")).toBeNull();
  });

  test("refuse other schemes, credentials, whitespace, control characters and length", () => {
    expect(contextUrlProblem("ftp://example.com/ctx.tar")).toBe("scheme");
    expect(contextUrlProblem("file:///etc/passwd")).toBe("scheme");
    expect(contextUrlProblem("https://user:secret@example.com/ctx.tar")).toBe("credentials");
    expect(contextUrlProblem("https://example.com/a b.tar")).toBe("whitespace");
    expect(contextUrlProblem("https://example.com/a\u0007.tar")).toBe("whitespace");
    expect(contextUrlProblem(`https://example.com/${"a".repeat(SOURCE_URL_MAX)}`)).toBe("too long");
    expect(contextUrlProblem("not a url")).toBe("whitespace");
    expect(contextUrlProblem("notaurl")).toBe("not a URL");
  });
});

describe("repository URLs", () => {
  test("accept https, ssh and the scp-like form", () => {
    expect(repoUrlProblem("https://github.com/org/repo.git")).toBeNull();
    expect(repoUrlProblem("ssh://git@github.com/org/repo.git")).toBeNull();
    expect(repoUrlProblem("git@github.com:org/repo.git")).toBeNull();
  });

  test("refuse a password in the address, so a credential goes in a secret", () => {
    expect(repoUrlProblem("https://user:token@github.com/org/repo.git")).toBe("credentials");
    expect(repoUrlProblem("ssh://git:pw@github.com/org/repo.git")).toBe("credentials");
  });

  test("refuse file URLs, option-like values, missing hosts and whitespace", () => {
    expect(repoUrlProblem("file:///tmp/repo")).toBe("syntax");
    expect(repoUrlProblem("-oProxyCommand=touch /tmp/x")).toBe("syntax");
    expect(repoUrlProblem("https://")).toBe("syntax");
    expect(repoUrlProblem("git@github.com:org/repo name")).toBe("syntax");
    expect(repoUrlProblem("plain-name")).toBe("syntax");
  });

  test("SSH addresses are the ones a deploy key authenticates", () => {
    expect(isSshRepoUrl("ssh://git@github.com/org/repo.git")).toBe(true);
    expect(isSshRepoUrl("git@github.com:org/repo.git")).toBe(true);
    expect(isSshRepoUrl("https://github.com/org/repo.git")).toBe(false);
  });
});

describe("branch names", () => {
  test("accept ordinary names and refuse the ones git would reject", () => {
    expect(repoBranchProblem("main")).toBe(false);
    expect(repoBranchProblem("release/v1.2-rc_1")).toBe(false);
    expect(repoBranchProblem("-rf")).toBe(true);
    expect(repoBranchProblem("a..b")).toBe(true);
    expect(repoBranchProblem("a//b")).toBe(true);
    expect(repoBranchProblem("feature/")).toBe(true);
    expect(repoBranchProblem("main.lock")).toBe(true);
    expect(repoBranchProblem("has space")).toBe(true);
    expect(repoBranchProblem("")).toBe(true);
  });
});

describe("relative paths inside a source", () => {
  test("accept paths that stay below the root", () => {
    expect(relativePathProblem("apps/web")).toBe(false);
    expect(relativePathProblem("./docker")).toBe(false);
  });

  test("refuse absolute paths, parent parts, control characters and empty paths", () => {
    expect(relativePathProblem("/etc")).toBe(true);
    expect(relativePathProblem("../outside")).toBe(true);
    expect(relativePathProblem("a/../b")).toBe(true);
    expect(relativePathProblem("a\u0001b")).toBe(true);
    expect(relativePathProblem("")).toBe(true);
    expect(relativePathProblem("a".repeat(513))).toBe(true);
  });
});

describe("resolveInside", () => {
  test("joins a relative path onto its base, and lets .. climb only to the root", () => {
    expect(resolveInside([".devcontainer"], "../src")).toEqual(["src"]);
    expect(resolveInside(["a"], "b/../../c")).toEqual(["c"]);
    expect(resolveInside(["a"], "./b/")).toEqual(["a", "b"]);
  });

  test("returns null for anything that would leave the repository or is not relative", () => {
    expect(resolveInside([], "../x")).toBeNull();
    expect(resolveInside(["a"], "../../x")).toBeNull();
    expect(resolveInside([], "/abs")).toBeNull();
    expect(resolveInside([], "a\0b")).toBeNull();
  });
});

describe("Dockerfile text", () => {
  test("accept a Dockerfile with a FROM instruction", () => {
    expect(dockerfileProblem("FROM alpine:3.20\nRUN true\n")).toBeNull();
    expect(dockerfileProblem("# note\nfrom alpine\n")).toBeNull();
  });

  test("refuse text without FROM, with a NUL byte, or over the size limit", () => {
    expect(dockerfileProblem("RUN true\n")).toBe("not a Dockerfile");
    expect(dockerfileProblem("FROM alpine\0")).toBe("not a Dockerfile");
    expect(dockerfileProblem(`FROM alpine\n${"#".repeat(DOCKERFILE_MAX_BYTES)}`)).toBe("too large");
  });
});
