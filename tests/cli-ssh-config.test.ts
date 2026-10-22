import { describe, expect, test } from "bun:test";

import { type SshHost, sshConfigBlock, sshLayout } from "../src/cli";

const LINUX: SshHost = { platform: "linux", homedir: "/home/arno", execPath: "/usr/bin/bun", compiled: false };
const COMPILED_LINUX: SshHost = { ...LINUX, execPath: "/home/arno/.local/bin/minibox", compiled: true };
const WINDOWS: SshHost = {
  platform: "win32",
  homedir: "C:\\Users\\Arno Chen",
  execPath: "C:\\Users\\Arno Chen\\.local\\bin\\minibox.exe",
  compiled: true,
};

describe("ssh-config layout", () => {
  test("POSIX hosts keep their files under HOME, or the account's home folder when HOME is unset", () => {
    expect(sshLayout({ HOME: "/srv/home" }, LINUX).sshDir).toBe("/srv/home/.ssh");
    expect(sshLayout({ HOME: "" }, LINUX).configPath).toBe("/home/arno/.ssh/config");
    expect(sshLayout({ HOME: "/srv/home" }, LINUX).credentialsPath).toBe(
      "/srv/home/.config/minibox/ssh-credentials.json",
    );
  });

  test("on Windows the profile folder is used, and the POSIX HOME that MSYS sets is ignored", () => {
    expect(sshLayout({ HOME: "/c/Users/arno", USERPROFILE: "C:\\Users\\arno" }, WINDOWS)).toEqual({
      sshDir: "C:\\Users\\arno\\.ssh",
      configPath: "C:\\Users\\arno\\.ssh\\config",
      pinPath: "C:\\Users\\arno\\.ssh\\minibox_known_hosts",
      credentialsDir: "C:\\Users\\arno\\.config\\minibox",
      credentialsPath: "C:\\Users\\arno\\.config\\minibox\\ssh-credentials.json",
    });
  });

  test("without USERPROFILE, Windows falls back to the account's profile folder", () => {
    expect(sshLayout({ HOME: "/c/Users/arno" }, WINDOWS).sshDir).toBe("C:\\Users\\Arno Chen\\.ssh");
  });
});

describe("ssh-config block", () => {
  test("a Windows CLI is named by a quoted absolute path with forward slashes, for CreateProcess and ssh", () => {
    expect(sshConfigBlock({}, WINDOWS)).toBe(
      [
        "# BEGIN minibox ssh-config",
        "Host *.minibox",
        "  User dev",
        '  ProxyCommand "C:/Users/Arno Chen/.local/bin/minibox.exe" ssh-proxy %h',
        '  UserKnownHostsFile "C:/Users/Arno Chen/.ssh/minibox_known_hosts"',
        "  StrictHostKeyChecking yes",
        "  ServerAliveInterval 15",
        "# END minibox ssh-config",
        "",
      ].join("\n"),
    );
  });

  test("the Windows block has no backslash, which ssh would read as an escape", () => {
    expect(sshConfigBlock({}, WINDOWS)).not.toContain("\\");
  });

  test("a source run on Windows names minibox, which PATH resolves", () => {
    expect(sshConfigBlock({}, { ...WINDOWS, compiled: false })).toContain("  ProxyCommand minibox ssh-proxy %h\n");
  });

  test("a compiled CLI on POSIX is named by its absolute path, quoted for sh", () => {
    expect(sshConfigBlock({}, COMPILED_LINUX)).toContain(
      '  ProxyCommand "/home/arno/.local/bin/minibox" ssh-proxy %h\n',
    );
  });

  test("$, backticks and spaces in a POSIX path stay literal inside the quotes sh reads", () => {
    const host = { ...COMPILED_LINUX, execPath: "/home/arno/My $tools/`bin`/minibox" };
    expect(sshConfigBlock({}, host)).toContain(
      '  ProxyCommand "/home/arno/My \\$tools/\\`bin\\`/minibox" ssh-proxy %h\n',
    );
  });

  test("a percent sign is doubled, because ssh expands % tokens in these values", () => {
    expect(sshConfigBlock({ HOME: "/srv/100%" }, LINUX)).toContain(
      '  UserKnownHostsFile "/srv/100%%/.ssh/minibox_known_hosts"\n',
    );
    expect(sshConfigBlock({}, { ...WINDOWS, execPath: "C:\\100%\\minibox.exe" })).toContain(
      '  ProxyCommand "C:/100%%/minibox.exe" ssh-proxy %h\n',
    );
  });

  test("a double quote in a path is refused, because no quoting makes it safe in a config line", () => {
    expect(() => sshConfigBlock({ HOME: '/srv/a"b' }, LINUX)).toThrow("contains a double quote");
    expect(() => sshConfigBlock({}, { ...COMPILED_LINUX, execPath: '/opt/"x"/minibox' })).toThrow(
      "contains a double quote",
    );
  });
});
