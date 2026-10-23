import { describe, expect, test } from "bun:test";

import { AGENT_IMAGE, agentBashCommand, agentPowerShellCommand } from "../web/js/lib/agent-command.js";
import {
  accessWarningShown,
  agentState,
  boxesOnHost,
  hostFilterShown,
  hostOfBox,
  isUnreachable,
} from "../web/js/lib/host-list.js";

const boxes = [
  { name: "alpha", hostId: "local", state: "running" },
  { name: "beta", hostId: "lab", state: "running" },
  { name: "gamma", hostId: "lab", state: "unreachable" },
  { name: "delta", state: "exited" },
];

describe("host filter and host state in the console", () => {
  test("a box that names no host is on the local host", () => {
    expect(hostOfBox({ name: "delta" })).toBe("local");
    expect(hostOfBox({ name: "beta", hostId: "lab" })).toBe("lab");
  });

  test("an empty filter lists every box, and a host filter lists only its own", () => {
    expect(boxesOnHost(boxes, "").map((b) => b.name)).toEqual(["alpha", "beta", "gamma", "delta"]);
    expect(boxesOnHost(boxes, "lab").map((b) => b.name)).toEqual(["beta", "gamma"]);
    expect(boxesOnHost(boxes, "local").map((b) => b.name)).toEqual(["alpha", "delta"]);
    expect(boxesOnHost(boxes, "missing")).toEqual([]);
  });

  test("a box the control plane lists as unreachable is the only one greyed out", () => {
    expect(boxes.filter(isUnreachable).map((b) => b.name)).toEqual(["gamma"]);
  });
});

describe("the host filter in the top bar", () => {
  test("it shows only once more than one host is configured", () => {
    expect(hostFilterShown([])).toBe(false);
    expect(hostFilterShown([{ id: "local" }])).toBe(false);
    expect(hostFilterShown([{ id: "local" }, { id: "lab" }])).toBe(true);
  });
});

describe("the access warning on the hosts page", () => {
  test("a console that holds only this machine shows no warning", () => {
    expect(accessWarningShown([])).toBe(false);
    expect(accessWarningShown([{ id: "local", transport: "local" }])).toBe(false);
  });

  test("once a host other than this machine is held, the console is the entry to several and the warning shows", () => {
    expect(
      accessWarningShown([
        { id: "local", transport: "local" },
        { id: "lab", transport: "ssh" },
      ]),
    ).toBe(true);
    expect(
      accessWarningShown([
        { id: "local", transport: "local" },
        { id: "edge", transport: "tcp" },
      ]),
    ).toBe(true);
  });
});

const agent = {
  connected: false,
  revoked: false,
  upgradeRequired: false,
  version: "0.4.0",
  protocol: 1,
  lastSeenAt: null,
};

describe("an agent host's state in the console", () => {
  test("a connected agent is online, a disconnected one offline", () => {
    expect(agentState({ ...agent, connected: true })).toBe("online");
    expect(agentState(agent)).toBe("offline");
  });

  test("a revoked agent says so even while its connection still shows", () => {
    expect(agentState({ ...agent, connected: true, revoked: true })).toBe("revoked");
  });

  test("an agent on another protocol needs an upgrade", () => {
    expect(agentState({ ...agent, protocol: 2, upgradeRequired: true })).toBe("upgrade");
  });

  test("a host that is not an agent has no agent state", () => {
    expect(agentState(undefined)).toBeNull();
    expect(agentState(null)).toBeNull();
  });
});

describe("the docker run command the Agent method shows", () => {
  const server = "https://minibox.example.com";
  const code = "ABCDE-FGHJK";

  test("the published image is the one the release workflow pushes", () => {
    expect(AGENT_IMAGE).toBe("ghcr.io/arnochenfx/minibox-agent");
  });

  test("bash runs the agent with the socket and the data volume, and needs no quotes for a plain server and code", () => {
    expect(agentBashCommand(server, code)).toBe(
      [
        "docker run -d --restart unless-stopped \\",
        "  -v /var/run/docker.sock:/var/run/docker.sock \\",
        "  -v minibox-agent:/data \\",
        `  ${AGENT_IMAGE} --server ${server} --pair ${code}`,
      ].join("\n"),
    );
  });

  test("bash single-quotes a value with a space or a shell character, and escapes a quote inside it", () => {
    const line = agentBashCommand("https://x.example/a b$(id)", "it's");
    expect(line.endsWith(`--server 'https://x.example/a b$(id)' --pair 'it'\\''s'`)).toBe(true);
  });

  test("PowerShell continues each line with a backtick and runs the same image", () => {
    expect(agentPowerShellCommand(server, code)).toBe(
      [
        "docker run -d --restart unless-stopped `",
        "  -v /var/run/docker.sock:/var/run/docker.sock `",
        "  -v minibox-agent:/data `",
        `  ${AGENT_IMAGE} --server ${server} --pair ${code}`,
      ].join("\n"),
    );
  });

  test("PowerShell keeps a value in single quotes literally and doubles a quote inside them", () => {
    const line = agentPowerShellCommand("https://x.example/a b$(id)", "it's");
    expect(line.endsWith(`--server 'https://x.example/a b$(id)' --pair 'it''s'`)).toBe(true);
  });
});
