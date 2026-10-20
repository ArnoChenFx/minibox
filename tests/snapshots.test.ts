import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Server } from "bun";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import type { LabelKeys } from "../src/labels";
import type { CommitSpec } from "../src/runtime";
import { startServer } from "../src/server";
import { createSnapshot } from "../src/services/snapshots";
import { promoteSnapshot } from "../src/services/templates";
import type { TerminalData } from "../src/ws/terminal";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

const SNAPSHOT_REF = "mbtest-snap:demo-20261020-000000";

/** Line breaks and tabs that would start a new Dockerfile instruction if they reached the commit unescaped. */
const INJECTIONS = [
  "ok\nENV X=1",
  'ok\nCMD ["sh","-c","id"]',
  "ok\r\nLABEL mbtest.template=true",
  "ok\\\nENV X=1",
  "ok\tENV X=1",
];

/** Single-line text that uses every character the label quoting has to escape. */
const SINGLE_LINE = [
  'say "hi"',
  "C:\\tmp\\new",
  "trailing backslash\\",
  "$HOME and ${PATH}",
  "`id` & $(id)",
  "it's #1; drop table",
  '\\"$HOME\\"',
  "é 漢字 🚀",
];

/**
 * Reads the `LABEL` instructions of a commit the way the Dockerfile parser reads a double-quoted value: only `\\`,
 * `\"` and `\$` are escapes. A bare `"` or `$` is not a valid value here, and a control character would end the line.
 */
function labelsOf(changes: string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const change of changes.filter((c) => c.startsWith("LABEL "))) {
    const match = /^LABEL ([^\s="]+)="((?:[^"\\$\p{Cc}]|\\[\\"$])*)"$/u.exec(change);
    if (!match) throw new Error(`not a single-line LABEL instruction: ${JSON.stringify(change)}`);
    labels[match[1] ?? ""] = (match[2] ?? "").replace(/\\([\\"$])/g, "$1");
  }
  return labels;
}

let app: App;
let runtime: FakeRuntime;
let host: HostCtx;
let keys: LabelKeys;
let server: Server<TerminalData>;
let base: string;
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  ({ app, runtime } = createTestApp({ labelPrefix: "mbtest" }));
  host = app.hosts.get();
  keys = host.keys;
  runtime.seedImage(SNAPSHOT_REF, { [keys.snapshot]: "true", [keys.snapshotOf]: "alpha" });
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  server.stop(true);
  restoreLogs();
});

function promote(body: unknown): Promise<Response> {
  return fetch(`${base}/api/snapshots/${encodeURIComponent(SNAPSHOT_REF)}/promote`, {
    method: "POST",
    headers: { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const lastCommit = (): CommitSpec => runtime.callsTo("commitContainer").at(-1)?.args[1] as CommitSpec;

function seedBox(name: string): string {
  return runtime.seedContainer({
    name: "mbtest-dev",
    image: host.baseTemplateTag,
    labels: { [keys.box]: "true", [keys.name]: name },
    running: true,
  });
}

describe("promote route", () => {
  test("refuses a line break that would start an instruction, before any container is created", async () => {
    for (const description of INJECTIONS) {
      const res = await promote({ name: "tpl", description });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: { code: "validation_failed", key: "description_invalid", details: { field: "description" } },
      });
    }
    expect(runtime.callsTo("createContainer")).toHaveLength(0);
    expect(runtime.callsTo("commitContainer")).toHaveLength(0);
  });

  test("stores quotes, backslashes and dollar signs as literal text", async () => {
    const res = await promote({ name: "tpl", description: 'a "b" \\c $HOME' });
    expect(res.status).toBe(201);
    expect(labelsOf(lastCommit().changes)[keys.templateDesc]).toBe('a "b" \\c $HOME');
  });

  test("every single-line description is stored as the same text, one instruction per change", async () => {
    for (const [i, description] of SINGLE_LINE.entries()) {
      expect((await promote({ name: `tpl${i}`, description })).status).toBe(201);
      const { changes } = lastCommit();
      expect(changes.filter((c) => /[\r\n]/.test(c))).toEqual([]);
      expect(labelsOf(changes)[keys.templateDesc]).toBe(description);
    }
  });

  test("a blank description falls back to the default text", async () => {
    expect((await promote({ name: "tpl", description: "   " })).status).toBe(201);
    expect(labelsOf(lastCommit().changes)[keys.templateDesc]).toBe("Promoted from a snapshot of box alpha");
  });
});

describe("promoteSnapshot", () => {
  test("refuses a line break even when called without the route, and removes its scratch container", async () => {
    await expect(promoteSnapshot(host, SNAPSHOT_REF, "tpl", "ok\nENV X=1")).rejects.toThrow("control characters");
    expect(runtime.callsTo("commitContainer")).toHaveLength(0);
    expect(runtime.containers.size).toBe(0);
  });
});

describe("createSnapshot", () => {
  test("stores a box name with quotes and dollar signs literally in every label it writes", async () => {
    const id = seedBox('dev"$HOME');
    await createSnapshot(host, id, "snap");
    const labels = labelsOf(lastCommit().changes);
    expect(labels[keys.snapshotOf]).toBe('dev"$HOME');
    expect(labels[keys.templateDesc]).toBe('Snapshot of box dev"$HOME');
    expect(labels[keys.templateName]).toBe("snap");
  });

  test("refuses a box name that would start an instruction and never commits", async () => {
    const id = seedBox("dev\nENV X=1");
    await expect(createSnapshot(host, id, "snap")).rejects.toThrow("control characters");
    expect(runtime.callsTo("commitContainer")).toHaveLength(0);
  });
});
