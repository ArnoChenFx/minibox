import { describe, expect, test } from "bun:test";

import { connectCommands, installCommands, setupCommands, sshHost, windowsInstallCommands } from "../web/js/lib/ssh.js";

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

  test("no SSH step asks the user to build the CLI from a checkout", () => {
    const origin = "https://minibox.example";
    for (const text of [installCommands(origin), windowsInstallCommands(origin), setupCommands(origin)]) {
      expect(text).not.toContain("build:cli");
    }
  });
});
