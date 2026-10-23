import { describe, expect, test } from "bun:test";

import { cloneRepo, imageRefOk, KIND_LABEL_KEYS, SOURCE_KINDS, templateSource } from "../web/js/lib/template-source.js";

describe("image references", () => {
  test("accept a name, a tag, a registry path and a digest", () => {
    for (const ref of [
      "node:24-bookworm-slim",
      "ghcr.io/org/app:1.2",
      "registry.local:5000/team/app@sha256:0123456789abcdef",
    ]) {
      expect([ref, imageRefOk(ref)]).toEqual([ref, true]);
    }
  });

  test("trim the surrounding space before the rule is applied", () => {
    expect(imageRefOk("  alpine:3.20  ")).toBe(true);
  });

  test("refuse an empty value, a value with a space, a leading dash and one over 255 characters", () => {
    for (const ref of ["", "   ", "two words", "-flag", "a".repeat(256), undefined]) {
      expect([ref, imageRefOk(ref)]).toEqual([ref, false]);
    }
  });
});

describe("template sources", () => {
  test("a Dockerfile is sent as typed, without trimming", () => {
    expect(templateSource("dockerfile", { text: "FROM alpine\n" })).toEqual({
      source: { kind: "dockerfile", text: "FROM alpine\n" },
    });
  });

  test("an empty Dockerfile is refused with the message for the text field", () => {
    expect(templateSource("dockerfile", { text: "  \n " })).toEqual({ problem: "text", key: "tp.errDockerfile" });
  });

  test("a git source trims its fields and leaves out the empty ones", () => {
    expect(
      templateSource("git", {
        url: " https://github.com/org/app.git ",
        branch: " main ",
        subdir: "",
        dockerfile: "docker/Dockerfile",
        secretRef: "",
      }),
    ).toEqual({
      source: { kind: "git", url: "https://github.com/org/app.git", branch: "main", dockerfile: "docker/Dockerfile" },
    });
  });

  test("a git source without a URL is refused with the URL message", () => {
    expect(templateSource("git", { url: "  ", branch: "main" })).toEqual({ problem: "url", key: "src.errUrl" });
  });

  test("a build context sends only its URL and Dockerfile path", () => {
    expect(
      templateSource("context", {
        url: "https://example.com/context.tar.gz",
        branch: "ignored",
        dockerfile: "Dockerfile.dev",
      }),
    ).toEqual({ source: { kind: "context", url: "https://example.com/context.tar.gz", dockerfile: "Dockerfile.dev" } });
  });

  test("a devcontainer source sends its path, branch and secret when they are filled", () => {
    expect(
      templateSource("devcontainer", {
        url: "git@github.com:org/app.git",
        branch: "",
        path: ".devcontainer/dev.json",
        secretRef: "DEPLOY_KEY",
      }),
    ).toEqual({
      source: {
        kind: "devcontainer",
        url: "git@github.com:org/app.git",
        path: ".devcontainer/dev.json",
        secretRef: "DEPLOY_KEY",
      },
    });
  });

  test("a kind the dialog does not offer is refused", () => {
    expect(templateSource("snapshot", { url: "x" })).toEqual({ problem: "kind", key: "tp.errKind" });
  });

  test("every source kind has a label key for the dialog and the template card", () => {
    expect(SOURCE_KINDS.map((kind) => KIND_LABEL_KEYS[kind])).toEqual([
      "tp.kindDockerfile",
      "tp.kindGit",
      "tp.kindContext",
      "tp.kindDevcontainer",
    ]);
  });

  test("an official template has a label of its own, and the dialog offers it as no source", () => {
    expect(KIND_LABEL_KEYS.official).toBe("tp.kindOfficial");
    expect(SOURCE_KINDS).not.toContain("official");
  });
});

describe("clone fields on the create-box dialog", () => {
  test("an empty URL means the box gets no repository", () => {
    expect(cloneRepo({ url: "  ", branch: "", secretRef: "" })).toEqual({ repo: null });
  });

  test("a branch or a secret without a URL is a problem with the URL", () => {
    expect(cloneRepo({ url: "", branch: "main" })).toEqual({ problem: "url", key: "src.errUrl" });
    expect(cloneRepo({ url: "", secretRef: "GH_TOKEN" })).toEqual({ problem: "url", key: "src.errUrl" });
  });

  test("a URL carries its trimmed branch and secret name", () => {
    expect(cloneRepo({ url: " https://github.com/org/app.git ", branch: " dev ", secretRef: "GH_TOKEN" })).toEqual({
      repo: { url: "https://github.com/org/app.git", branch: "dev", secretRef: "GH_TOKEN" },
    });
  });

  test("a URL alone is sent without a branch or secret", () => {
    expect(cloneRepo({ url: "https://github.com/org/app.git" })).toEqual({
      repo: { url: "https://github.com/org/app.git" },
    });
  });
});
