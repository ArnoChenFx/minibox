import { beforeEach, afterEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import type { HelperResult, HelperSpec } from "../src/runtime";
import { HELPER_SECRETS_DIR } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import { assertRepoSecretSet, cloneInto, cloneIntoWorkspace, scrubSecret, WORKSPACE } from "../src/services/git-clone";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

let restoreLogs: () => void;
beforeEach(() => {
  restoreLogs = silenceLogs();
});
afterEach(() => restoreLogs());

interface Lab {
  readonly app: App;
  readonly runtime: FakeRuntime;
  readonly host: HostCtx;
  readonly helpers: HelperSpec[];
}

/** An app whose base template is seeded. Every helper run is recorded and answered by `answer`. */
function lab(answer: (spec: HelperSpec) => HelperResult = () => ({ exitCode: 0, logs: "" })): Lab {
  const { app, runtime } = createTestApp({ labelPrefix: "mbtest" });
  const host = app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true", [host.keys.templateName]: "base" });
  const helpers: HelperSpec[] = [];
  runtime.helperHandler = (spec) => {
    helpers.push(spec);
    return answer(spec);
  };
  return { app, runtime, host, helpers };
}

describe("cloning a repository into a volume", () => {
  test("runs git in a helper with a credential helper, the branch, and the target and URL as arguments", async () => {
    const l = lab();
    await l.runtime.createVolume("mbtest-src-1", {});

    await cloneInto(l.host, {
      repo: { url: "https://github.com/org/repo.git", branch: "dev" },
      volume: "mbtest-src-1",
      path: "/work",
      owner: { uid: 0, gid: 0 },
    });

    const [spec] = l.helpers;
    expect(spec?.image).toBe(l.host.baseTemplateTag);
    expect(spec?.network).toBe(true);
    expect(spec?.mounts).toEqual([{ source: "mbtest-src-1", target: "/work", mode: "rw" }]);
    expect(spec?.cmd.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(spec?.cmd[2]).toContain("credential.helper=");
    expect(spec?.cmd[2]).toContain("--single-branch --branch");
    expect(spec?.cmd.slice(3)).toEqual(["minibox", "/work", "https://github.com/org/repo.git", "dev", ""]);
    expect(spec?.env).toEqual(
      expect.arrayContaining(["GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_NOSYSTEM=1", "GIT_ALLOW_PROTOCOL=https:ssh"]),
    );
    expect((spec?.env ?? []).some((entry) => entry.startsWith("MINIBOX_TOKEN_FILE="))).toBe(false);
    expect(spec?.secrets ?? []).toEqual([]);
  });

  test("with no branch, the default branch is cloned and the branch argument is empty", async () => {
    const l = lab();
    await l.runtime.createVolume("mbtest-src-2", {});
    await cloneInto(l.host, {
      repo: { url: "https://github.com/org/repo.git" },
      volume: "mbtest-src-2",
      path: "/work",
      owner: { uid: 0, gid: 0 },
    });
    expect(l.helpers[0]?.cmd[6]).toBe("");
    expect(l.helpers[0]?.cmd[5]).toBe("https://github.com/org/repo.git");
  });

  test("a token is staged as a secret file and named by MINIBOX_TOKEN_FILE, never in the command or the environment", async () => {
    const l = lab();
    l.host.secrets.set("gh-token", "ghp_example_value", "2026-10-22T00:00:00.000Z");
    await l.runtime.createVolume("mbtest-src-3", {});

    await cloneInto(l.host, {
      repo: { url: "https://github.com/org/private.git", secretRef: "gh-token" },
      volume: "mbtest-src-3",
      path: "/work",
      owner: { uid: 1000, gid: 1000 },
    });

    const spec = l.helpers[0];
    expect(spec?.env).toContain(`MINIBOX_TOKEN_FILE=${HELPER_SECRETS_DIR}/gh-token`);
    expect(spec?.secrets).toEqual([{ name: "gh-token", value: "ghp_example_value" }]);
    expect(spec?.secretsOwner).toEqual({ uid: 1000, gid: 1000 });
    expect(spec?.cmd.join(" ")).not.toContain("ghp_example_value");
    expect((spec?.env ?? []).join(" ")).not.toContain("ghp_example_value");
    expect(spec?.user).toBe("1000:1000");
  });

  test("a deploy key is named by path and the SSH command pins the key and its own known-hosts file", async () => {
    const l = lab();
    l.host.secrets.set("deploy", "c3NoIGtleQ==", "2026-10-22T00:00:00.000Z");
    await l.runtime.createVolume("mbtest-src-4", {});

    await cloneInto(l.host, {
      repo: { url: "git@github.com:org/private.git", secretRef: "deploy" },
      volume: "mbtest-src-4",
      path: "/work",
      owner: { uid: 0, gid: 0 },
    });

    const spec = l.helpers[0];
    expect(spec?.cmd.at(-1)).toBe(`${HELPER_SECRETS_DIR}/deploy`);
    expect((spec?.env ?? []).find((entry) => entry.startsWith("GIT_SSH_COMMAND="))).toContain("-o IdentitiesOnly=yes");
    expect((spec?.env ?? []).some((entry) => entry.startsWith("MINIBOX_TOKEN_FILE="))).toBe(false);
  });

  test("the clone's output reaches the log with the secret value removed", async () => {
    const l = lab(() => ({ exitCode: 0, logs: "Cloning into '/work'...\nremote: token ghp_example_value\n" }));
    l.host.secrets.set("gh-token", "ghp_example_value", "2026-10-22T00:00:00.000Z");
    await l.runtime.createVolume("mbtest-src-5", {});
    const lines: string[] = [];

    await cloneInto(l.host, {
      repo: { url: "https://github.com/org/private.git", secretRef: "gh-token" },
      volume: "mbtest-src-5",
      path: "/work",
      owner: { uid: 0, gid: 0 },
      log: (text) => lines.push(text),
    });

    const logged = lines.join("");
    expect(logged).toContain("Cloning into '/work'");
    expect(logged).toContain("[secret]");
    expect(logged).not.toContain("ghp_example_value");
  });

  test("a failed clone is refused with the tail of its output, and the secret is not in it", async () => {
    const long = `${"x".repeat(600)}\nfatal: Authentication failed for ghp_example_value\n`;
    const l = lab(() => ({ exitCode: 128, logs: long }));
    l.host.secrets.set("gh-token", "ghp_example_value", "2026-10-22T00:00:00.000Z");
    await l.runtime.createVolume("mbtest-src-6", {});

    const error = await rejectionOf(
      cloneInto(l.host, {
        repo: { url: "https://github.com/org/private.git", secretRef: "gh-token" },
        volume: "mbtest-src-6",
        path: "/work",
        owner: { uid: 0, gid: 0 },
      }),
    );

    expect(error).toMatchObject({ status: 400, key: "clone_failed" });
    const detail = (error as { params?: { detail?: string } }).params?.detail ?? "";
    expect(detail.length).toBeLessThanOrEqual(400);
    expect(detail).toContain("fatal: Authentication failed for [secret]");
    expect(detail).not.toContain("ghp_example_value");
  });

  test("a secret the repository names but the store does not hold is refused before the helper runs", async () => {
    const l = lab();
    await l.runtime.createVolume("mbtest-src-7", {});

    const error = await rejectionOf(
      cloneInto(l.host, {
        repo: { url: "https://github.com/org/private.git", secretRef: "missing" },
        volume: "mbtest-src-7",
        path: "/work",
        owner: { uid: 0, gid: 0 },
      }),
    );

    expect(error).toMatchObject({ status: 400, key: "repo_secret_missing" });
    expect(l.helpers).toEqual([]);
  });

  test("assertRepoSecretSet refuses an unset secret and passes a set one or none", () => {
    const l = lab();
    l.host.secrets.set("here", "v", "2026-10-22T00:00:00.000Z");
    expect(() => assertRepoSecretSet(l.host, undefined)).not.toThrow();
    expect(() => assertRepoSecretSet(l.host, { url: "https://x.test/r.git" })).not.toThrow();
    expect(() => assertRepoSecretSet(l.host, { url: "https://x.test/r.git", secretRef: "here" })).not.toThrow();
    expect(() => assertRepoSecretSet(l.host, { url: "https://x.test/r.git", secretRef: "gone" })).toThrow();
  });

  test("scrubSecret replaces every occurrence and leaves text alone without a secret", () => {
    expect(scrubSecret("a tok b tok", "tok")).toBe("a [secret] b [secret]");
    expect(scrubSecret("nothing here", null)).toBe("nothing here");
    expect(scrubSecret("nothing here", "")).toBe("nothing here");
  });
});

describe("cloning into a box's workspace", () => {
  test("clones into the writable /workspace of the box, as the owner of its volume", async () => {
    const l = lab();
    const box = await boxes.createBox(l.host, { name: "alpha", cpus: 1, memoryMb: 256 });
    l.helpers.length = 0;

    await cloneIntoWorkspace(l.host, box.boxId, { url: "https://github.com/org/repo.git" });

    const spec = l.helpers[0];
    expect(spec?.mounts?.[0]).toMatchObject({ target: WORKSPACE, mode: "rw" });
    expect(spec?.cmd[4]).toBe(WORKSPACE);
    expect(spec?.cmd[5]).toBe("https://github.com/org/repo.git");
  });

  test("a box with no writable workspace is refused", async () => {
    const l = lab();
    const box = await boxes.createBox(l.host, { name: "alpha", cpus: 1, memoryMb: 256, mounts: [] });
    const error = await rejectionOf(cloneIntoWorkspace(l.host, box.boxId, { url: "https://github.com/org/repo.git" }));
    expect(error).toMatchObject({ status: 400, key: "repo_needs_workspace" });
    expect(l.helpers).toEqual([]);
  });
});
