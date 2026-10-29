import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { MovePreview } from "../web/js/components/box-move.js";

let movePreviewHtml: (preview: MovePreview) => string;
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
  ({ movePreviewHtml } = await import("../web/js/components/box-move.js"));
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
    // The move's own checkpoint is removed afterwards, so the count is not something that stays behind.
    expect(html).not.toContain("source host");
  });
});
