import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  AGENT_IMAGE,
  AGENT_LATEST_TAG,
  agentBashCommand,
  agentImage,
  agentImageTag,
  agentPowerShellCommand,
  insecureConsole,
} from "../web/js/lib/agent-command.js";
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
    expect(agentBashCommand(server, code, "0.6.8")).toBe(
      [
        "docker run -d --restart unless-stopped \\",
        "  -v /var/run/docker.sock:/var/run/docker.sock \\",
        "  -v minibox-agent:/data \\",
        `  ${AGENT_IMAGE}:0.6.8 --server ${server} --pair ${code}`,
      ].join("\n"),
    );
  });

  test("bash single-quotes a value with a space or a shell character, and escapes a quote inside it", () => {
    const line = agentBashCommand("https://x.example/a b$(id)", "it's");
    expect(line.endsWith(`--server 'https://x.example/a b$(id)' --pair 'it'\\''s'`)).toBe(true);
  });

  test("PowerShell continues each line with a backtick and runs the same image", () => {
    expect(agentPowerShellCommand(server, code, "0.6.8")).toBe(
      [
        "docker run -d --restart unless-stopped `",
        "  -v /var/run/docker.sock:/var/run/docker.sock `",
        "  -v minibox-agent:/data `",
        `  ${AGENT_IMAGE}:0.6.8 --server ${server} --pair ${code}`,
      ].join("\n"),
    );
  });

  test("PowerShell keeps a value in single quotes literally and doubles a quote inside them", () => {
    const line = agentPowerShellCommand("https://x.example/a b$(id)", "it's");
    expect(line.endsWith(`--server 'https://x.example/a b$(id)' --pair 'it''s'`)).toBe(true);
  });
});

/**
 * `settings-host-form.js` pulls in the i18n layer, which reads `localStorage` at import time, so the panel is loaded
 * with the two globals a browser would provide.
 */
type HostForm = {
  imageNote: (version?: string | null) => string;
  pairingView: (
    pairing: { code: string; expiresAt: string },
    view?: { origin?: string; protocol?: string; version?: string | null },
  ) => string;
};
let form: HostForm;
const restores: (() => void)[] = [];

function stubGlobal(name: string, value: unknown): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  restores.push(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete (globalThis as Record<string, unknown>)[name];
  });
}

beforeAll(async () => {
  const store = new Map<string, string>();
  stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
  });
  stubGlobal("document", { documentElement: {} });
  // @ts-expect-error The web modules are plain JavaScript without declarations.
  form = await import("../web/js/components/settings-host-form.js");
});

afterAll(() => {
  for (const restore of restores.toReversed()) restore();
});

const imageNote = (version?: string | null) => form.imageNote(version);
const pairingView = (
  pairing: { code: string; expiresAt: string },
  view?: { origin?: string; protocol?: string; version?: string | null },
) => form.pairingView(pairing, view);

describe("the agent image is pinned to this MiniBox's own version", () => {
  test("a release version becomes the image tag, with or without a leading v", () => {
    expect(agentImageTag("0.6.8")).toBe("0.6.8");
    expect(agentImageTag("v0.6.8")).toBe("0.6.8");
    expect(agentImageTag(" 0.6.8 ")).toBe("0.6.8");
    expect(agentImage("0.6.8")).toBe(`${AGENT_IMAGE}:0.6.8`);
  });

  test("a dev build, a prerelease and an unread version fall back to latest", () => {
    for (const version of ["0.6.8-3-gabc1234", "0.7.0-rc.1", "", "   ", null, undefined, "broken"]) {
      expect([version, agentImageTag(version)]).toEqual([version, AGENT_LATEST_TAG]);
    }
    expect(agentImage(null)).toBe(`${AGENT_IMAGE}:latest`);
  });

  test("the note says which tag the command uses, and why it is not the console's own version", () => {
    expect(imageNote("0.6.8")).toContain("0.6.8");
    expect(imageNote("0.6.8-3-gabc1234")).toContain("0.6.8-3-gabc1234");
    expect(imageNote(null)).not.toBe("");
    expect(imageNote("0.6.8")).not.toBe(imageNote("0.6.8-3-gabc1234"));
  });

  test("the pairing view runs the pinned image, and a dev build runs latest", () => {
    const release = pairingView(
      { code: "ABCDE", expiresAt: "2026-10-28T10:00:00.000Z" },
      {
        origin: "https://minibox.example.com",
        protocol: "https:",
        version: "0.6.8",
      },
    );
    expect(release).toContain(`${AGENT_IMAGE}:0.6.8 --server https://minibox.example.com --pair ABCDE`);
    expect(release).not.toContain("agent-insecure");

    const dev = pairingView(
      { code: "ABCDE", expiresAt: "2026-10-28T10:00:00.000Z" },
      {
        origin: "http://10.0.0.5:3920",
        protocol: "http:",
        version: "0.6.8-3-gabc1234",
      },
    );
    expect(dev).toContain(`${AGENT_IMAGE}:latest`);
  });
});

describe("a console reached over plain http warns before pairing an agent", () => {
  test("only https counts as secure", () => {
    expect(insecureConsole("https:")).toBe(false);
    expect(insecureConsole("http:")).toBe(true);
    expect(insecureConsole("")).toBe(true);
  });

  test("the warning is in the pairing view over http, and gone over https", () => {
    const expiresAt = "2026-10-28T10:00:00.000Z";
    const insecure = pairingView(
      { code: "ABCDE", expiresAt },
      { origin: "http://h:3920", protocol: "http:", version: "0.6.8" },
    );
    const secure = pairingView(
      { code: "ABCDE", expiresAt },
      { origin: "https://h", protocol: "https:", version: "0.6.8" },
    );
    expect(insecure).toContain("agent-insecure");
    expect(insecure).toContain("plain http");
    expect(insecure).toContain("https");
    expect(secure).not.toContain("agent-insecure");
  });
});
