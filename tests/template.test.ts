import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BASE_DESCRIPTION } from "../src/services/templates";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const dockerfile = read("templates/base/Dockerfile");
const { scripts } = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
const aptInstall = dockerfile.slice(dockerfile.indexOf("apt-get install"), dockerfile.indexOf("rm -rf /var/lib/apt"));

describe("base template", () => {
  test("runs as the non-root dev user with the convention uid and gid", () => {
    expect(dockerfile).toContain("ARG DEV_UID=1000");
    expect(dockerfile).toContain("ARG DEV_GID=1000");
    expect(dockerfile).toMatch(/^USER dev$/m);
    expect(dockerfile).toContain('CMD ["sleep", "infinity"]');
  });

  test("labels record the uid convention", () => {
    expect(dockerfile).toContain("minibox.template.user=dev");
    expect(dockerfile).toContain('minibox.template.uid="${DEV_UID}"');
    expect(dockerfile).toContain('minibox.template.gid="${DEV_GID}"');
  });

  test("the description matches the server build and build:template", () => {
    expect(dockerfile).toContain(`minibox.template.description="${BASE_DESCRIPTION}"`);
    expect(scripts["build:template"]).toContain(BASE_DESCRIPTION);
  });

  test("installs the box tools and keeps the existing ones", () => {
    for (const pkg of ["tmux", "jq", "ripgrep", "openssh-client", "unzip", "sudo", "git", "curl", "python3"]) {
      expect(aptInstall).toContain(pkg);
    }
  });

  test("mount points and cache variables follow the convention", () => {
    expect(dockerfile).toContain("mkdir -p /workspace /opt/minibox/tools/bin /home/dev/.cache");
    expect(dockerfile).toContain("chown dev:dev /workspace /home/dev/.cache");
    expect(dockerfile).not.toMatch(/chown[^\n]*\/opt\/minibox/);
    expect(dockerfile).toContain("npm_config_cache=/home/dev/.cache/npm");
    expect(dockerfile).toContain("PIP_CACHE_DIR=/home/dev/.cache/pip");
    expect(dockerfile).toContain("PATH=/home/dev/.npm-global/bin:$PATH:/opt/minibox/tools/bin");
  });
});
