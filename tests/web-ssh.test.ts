import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import {
  connectCommands,
  installCommands,
  setupCommands,
  sshHost,
  windowsInstallCommands,
  windowsSetupCommands,
} from "../web/js/lib/ssh.js";

const ORIGIN = "https://minibox.example";
const PWSH = Bun.which("pwsh");

describe("SSH dialog commands", () => {
  test("a box answers to <name>.minibox, the host pattern ssh-config matches", () => {
    expect(sshHost("dev-box.1")).toBe("dev-box.1.minibox");
  });

  test("the connect commands name the box's host for ssh and scp", () => {
    expect(connectCommands("sshbox")).toBe("ssh sshbox.minibox\nscp ./file sshbox.minibox:/workspace/");
  });

  test("the install command fetches the CLI from the server the dialog was opened on", () => {
    expect(installCommands("https://minibox.example")).toBe("curl -fsSL https://minibox.example/cli/install.sh | sh");
  });

  test("the Windows install command runs the PowerShell installer from the same server", () => {
    expect(windowsInstallCommands("https://minibox.example")).toBe("irm https://minibox.example/cli/install.ps1 | iex");
  });

  test("the setup command passes the server and token to ssh-config, which saves them for the ProxyCommand", () => {
    expect(setupCommands("https://minibox.example")).toBe(
      ["MINIBOX_URL=https://minibox.example \\", "  MINIBOX_ACCESS_KEY=<token> minibox ssh-config --append"].join("\n"),
    );
  });

  test("the Windows setup command sets both variables with $env: and runs ssh-config on one line", () => {
    expect(windowsSetupCommands(ORIGIN)).toBe(
      '$env:MINIBOX_URL="https://minibox.example"; $env:MINIBOX_ACCESS_KEY="<token>"; minibox ssh-config --append',
    );
  });

  test("no SSH step asks the user to build the CLI from a checkout", () => {
    for (const text of [installCommands(ORIGIN), windowsInstallCommands(ORIGIN), setupCommands(ORIGIN)]) {
      expect(text).not.toContain("build:cli");
    }
  });

  test("the POSIX commands parse as sh, so a pasted line is not a syntax error", () => {
    for (const text of [installCommands(ORIGIN), setupCommands(ORIGIN)]) {
      const checked = spawnSync("sh", ["-n", "-c", text], { encoding: "utf8" });
      expect({ text, status: checked.status, stderr: checked.stderr }).toEqual({ text, status: 0, stderr: "" });
    }
  });

  test.skipIf(PWSH === null)("the PowerShell commands parse without errors", () => {
    for (const text of [windowsInstallCommands(ORIGIN), windowsSetupCommands(ORIGIN)]) {
      const checked = spawnSync(
        PWSH ?? "pwsh",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:SAMPLE, [ref]$null, [ref]$errors); exit $errors.Count",
        ],
        { env: { ...process.env, SAMPLE: text }, encoding: "utf8" },
      );
      expect({ text, status: checked.status, stderr: checked.stderr }).toEqual({ text, status: 0, stderr: "" });
    }
  });
});
