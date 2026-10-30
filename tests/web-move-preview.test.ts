import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { MovePreview } from "../web/js/components/box-move.js";

let movePreviewHtml: (preview: MovePreview) => string;
let moveTargets: (
  box: { hostId?: string },
  hosts: readonly { id: string; name?: string; status?: string; transport?: string }[],
) => { options: string; usable: boolean; agentsOnly: boolean };
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
  ({ movePreviewHtml, moveTargets } = await import("../web/js/components/box-move.js"));
});

afterAll(() => {
  for (const restore of restores.toReversed()) restore();
});

function preview(checkpoints: number): MovePreview {
  return {
    box: { id: "bx_move", name: "web" },
    from: "local",
    to: "lab",
    running: false,
    starts: false,
    image: { ref: "mbtest-template:base", transfer: false },
    volumes: [],
    network: "minibox",
    checkpoints,
    keeps: ["id", "name", "volumes", "env", "history"],
    loses: ["writableLayer", "processes", "ip"],
    revision: { current: 1, next: 2 },
  };
}

describe("the move preview's checkpoint line", () => {
  test("one checkpoint is named in the singular", () => {
    expect(movePreviewHtml(preview(1))).toContain(
      "1 checkpoint stays on the source host, local, and is not restored on lab.",
    );
  });

  test("several checkpoints are named in the plural", () => {
    expect(movePreviewHtml(preview(3))).toContain(
      "3 checkpoints stay on the source host, local, and are not restored on lab.",
    );
  });

  test("a running box is told it stays paused until the move commits, and a stopped one is not", () => {
    expect(movePreviewHtml({ ...preview(0), running: true, starts: true })).toContain(
      "While it moves, the running box on local is paused, and it stays paused until the move commits.",
    );
    expect(movePreviewHtml(preview(0))).not.toContain("paused");
  });

  test("a box with no checkpoints has no checkpoint line", () => {
    expect(movePreviewHtml(preview(0))).not.toContain("source host");
  });

  test("a checkpoint move names its path, its restored volumes, and has no leftover-checkpoint line", () => {
    const html = movePreviewHtml({
      ...preview(2),
      via: "checkpoint",
      volumes: [
        { path: "/workspace", role: "workspace", name: "web-workspace", action: "checkpoint", target: "web-workspace" },
        { path: "/home/dev/.cache", role: "cache", name: "web-cache", action: "empty", target: "web-cache" },
      ],
    });
    expect(html).toContain(
      "Path: checkpoint: a checkpoint carries the box&#39;s data, and the box is made from it on lab",
    );
    expect(html).toContain("Carried in the checkpoint and restored on lab");
    expect(html).toContain("Made again on lab, empty");
    // The box's own checkpoints stay on the source host on this path too. The move's own is taken for the transfer and
    // removed afterwards, and is not among them.
    expect(html).toContain("2 checkpoints stay on the source host, local, and are not restored on lab.");
  });
});

describe("the hosts a box may be moved to", () => {
  const local = { id: "local", name: "Local", status: "online", transport: "local" };
  const lab = { id: "lab", name: "Lab", status: "online", transport: "tcp" };
  const edge = { id: "edge", name: "Edge", status: "online", transport: "agent" };
  const box = { hostId: "local" };

  test("an agent host is listed with the reason and cannot be picked, and an ordinary host can", () => {
    const { options, usable, agentsOnly } = moveTargets(box, [local, lab, edge]);
    expect(options).toContain('<option value="lab">Lab</option>');
    expect(options).toContain('<option value="edge" disabled>Edge — an agent host cannot take a box yet</option>');
    expect(usable).toBe(true);
    expect(agentsOnly).toBe(false);
  });

  test("when the only other host is an agent host, there is nothing to pick, and the dialog says why", () => {
    const { usable, agentsOnly } = moveTargets(box, [local, edge]);
    expect(usable).toBe(false);
    expect(agentsOnly).toBe(true);
  });

  test("the box's own host and a host that is offline are not offered at all, and none left is not 'agents only'", () => {
    const offline = { ...lab, status: "offline" };
    const { options, usable, agentsOnly } = moveTargets(box, [local, offline]);
    expect(options).toBe("");
    expect(usable).toBe(false);
    expect(agentsOnly).toBe(false);
  });

  test("an agent host beside a host that is only offline is not 'agents only', since a host that is not an agent exists", () => {
    const offline = { ...lab, status: "offline" };
    const { options, usable, agentsOnly } = moveTargets(box, [local, offline, edge]);
    expect(options).toBe('<option value="edge" disabled>Edge — an agent host cannot take a box yet</option>');
    expect(usable).toBe(false);
    // "Add a host that is not an agent host" would be wrong to say to someone whose Lab is merely down.
    expect(agentsOnly).toBe(false);
  });

  test("a box that names no host sits on the local host, which is not one of its own targets", () => {
    const { options, usable, agentsOnly } = moveTargets({}, [local, edge]);
    expect(options).toBe('<option value="edge" disabled>Edge — an agent host cannot take a box yet</option>');
    expect(usable).toBe(false);
    expect(agentsOnly).toBe(true);
  });

  test("an agent host that is offline is not offered, and when it is the only other host the dialog still says 'agents only'", () => {
    const offline = { ...edge, status: "offline" };
    const { options, usable, agentsOnly } = moveTargets(box, [local, offline]);
    expect(options).toBe("");
    expect(usable).toBe(false);
    expect(agentsOnly).toBe(true);
  });
});
