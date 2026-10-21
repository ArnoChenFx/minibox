import { describe, expect, test } from "bun:test";

import { connectCommands, setupCommands, sshHost } from "../web/js/lib/ssh.js";

describe("SSH dialog commands", () => {
  test("a box answers to <name>.minibox, the host pattern ssh-config matches", () => {
    expect(sshHost("dev-box.1")).toBe("dev-box.1.minibox");
  });

  test("the connect commands name the box's host for ssh and scp", () => {
    expect(connectCommands("sshbox")).toBe("ssh sshbox.minibox\nscp ./file sshbox.minibox:/workspace/");
  });

  test("the setup command exports the server and token the ProxyCommand reads, then writes the config", () => {
    expect(setupCommands("https://minibox.example")).toBe(
      [
        "bun run build:cli && mkdir -p ~/.local/bin && cp dist/minibox ~/.local/bin/minibox",
        "export MINIBOX_URL=https://minibox.example",
        "export MINIBOX_ACCESS_KEY=<token>",
        "minibox ssh-config --append",
      ].join("\n"),
    );
  });
});
