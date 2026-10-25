import { z } from "zod";

import type { Msg } from "../lib/messages";
import { getBox } from "../services/boxes";
import {
  clearStartupCommand,
  readStartupCommand,
  runStartupCommand,
  type StartupCommandState,
  setStartupCommand,
} from "../services/startup-command";
import { requireRevision } from "../specs/revision";
import { boxTarget } from "./boxes";
import { defineOperation } from "./define";
import { hostOfBox } from "./routing";
import { applyNowFlag, boxId, expectedRevision, startupCommandRequired } from "./validation";

/**
 * Every startup operation needs `secret:use`, the scope that already gates host secrets in a box. The command and its
 * output may hold a secret the user typed. Setting, removing and running a command also needs `exec`, since the command
 * runs as code in the box; the access rules check that.
 */
const STARTUP_SCOPE = "secret:use";

const StartupErrorSchema = z.object({
  key: z.string(),
  message: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

const StartupSchema = z.object({
  revision: z.number().int().describe("The box revision the command belongs to. Send it back as If-Match on a change."),
  command: z.string().nullable().describe("The command as typed, or null when the box has none."),
  status: z
    .enum(["none", "cloning", "waiting", "running", "exited", "failed"])
    .describe(
      "none: no command. cloning: the box's setup (its repository clone and the template's postCreateCommand) has not ended, and the command starts when it has. waiting: set, and not run since the box last started. running: its run is going. exited: the run ended, with exitCode. failed: MiniBox could not start it, with error.",
    ),
  exitCode: z.number().int().nullable().describe("The exit code of the latest run, once it has ended."),
  startedAt: z.string().nullable().describe("When the latest run started, as an ISO 8601 time."),
  exitedAt: z.string().nullable().describe("When the latest run ended, as an ISO 8601 time."),
  stale: z.boolean().describe("True when the latest run used an earlier text of the command."),
  log: z.array(z.string()).describe("The newest lines of the latest run's output."),
  error: StartupErrorSchema.nullable().describe("Why MiniBox could not start the command, when no run is visible."),
});

type StartupOutput = z.input<typeof StartupSchema>;

function startupOutput(state: StartupCommandState): StartupOutput {
  return { ...state, error: state.error && messageOutput(state.error) };
}

function messageOutput(error: Msg) {
  return { key: error.key, message: error.text, params: error.params };
}

export const boxStartupGet = defineOperation({
  name: "box.startup.get",
  tag: "boxes",
  summary: "Read a box's startup command and its status",
  kind: "read",
  scope: STARTUP_SCOPE,
  async: false,
  input: z.object({ id: boxId() }),
  output: StartupSchema,
  rest: [{ method: "GET", path: "/api/boxes/:id/startup-command" }],
  cli: "box startup-command get",
  mcp: {
    toolset: "core",
    name: "get_startup_command",
    description:
      "Read a box's startup command as typed, with its status: cloning, waiting, running, exited with its exit code, or failed with the reason, and the newest lines of its output. Needs the secret:use scope, because the command and its output may hold secrets.",
  },
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host }, input) => startupOutput(await readStartupCommand(host, input.id)),
});

export const boxStartupSet = defineOperation({
  name: "box.startup.set",
  tag: "boxes",
  summary: "Set a box's startup command",
  kind: "write",
  scope: STARTUP_SCOPE,
  async: false,
  input: z.object({
    id: boxId(),
    command: startupCommandRequired(),
    applyNow: applyNowFlag(),
    expectedRevision: expectedRevision(),
  }),
  output: StartupSchema,
  rest: [{ method: "PUT", path: "/api/boxes/:id/startup-command", body: true, ifMatch: true }],
  cli: "box startup-command set",
  mcp: {
    toolset: "core",
    name: "set_startup_command",
    description:
      "Set a box's startup command. It runs with bash -lc in /workspace, as the box's user and with its env, once each time the container starts, including after a restart, a rebuild or a restore. It takes effect at the next start. applyNow runs it now when the box is running. Pass expectedRevision, the box's current revision. A stopped box can be changed and needs no rebuild. Needs the exec and secret:use scopes.",
  },
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: () => "box.startup.set", target: (_input, box) => box.name },
  audit: {
    target: (_input, box) => box && boxTarget(box),
    detail: (input, _resolved, result) => ({ applyNow: input.applyNow, revision: result?.revision ?? null }),
  },
  run: async ({ host }, input) =>
    startupOutput(
      await setStartupCommand(host, input.id, {
        command: input.command,
        applyNow: input.applyNow,
        expectedRevision: requireRevision(input.expectedRevision),
      }),
    ),
});

export const boxStartupDelete = defineOperation({
  name: "box.startup.delete",
  tag: "boxes",
  summary: "Remove a box's startup command",
  kind: "write",
  scope: STARTUP_SCOPE,
  async: false,
  input: z.object({ id: boxId(), expectedRevision: expectedRevision() }),
  output: StartupSchema,
  rest: [{ method: "DELETE", path: "/api/boxes/:id/startup-command", ifMatch: true }],
  cli: "box startup-command rm",
  mcp: {
    toolset: "core",
    name: "delete_startup_command",
    description:
      "Remove a box's startup command, so the box runs nothing at its next start. A run already going keeps going until the box stops or restarts. Pass expectedRevision, the box's current revision. Needs the exec and secret:use scopes.",
  },
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: () => "box.startup.delete", target: (_input, box) => box.name },
  audit: {
    target: (_input, box) => box && boxTarget(box),
    detail: (_input, _resolved, result) => ({ revision: result?.revision ?? null }),
  },
  run: async ({ host }, input) =>
    startupOutput(await clearStartupCommand(host, input.id, requireRevision(input.expectedRevision))),
});

export const boxStartupRun = defineOperation({
  name: "box.startup.run",
  tag: "boxes",
  summary: "Run a box's startup command again now",
  kind: "write",
  scope: STARTUP_SCOPE,
  async: false,
  conflicts: true,
  input: z.object({ id: boxId() }),
  output: StartupSchema,
  rest: [{ method: "POST", path: "/api/boxes/:id/startup-command/run" }],
  cli: "box startup-command run",
  mcp: {
    toolset: "core",
    name: "run_startup_command",
    description:
      "Run the box's startup command again now, without a restart. The box must be running and the command must be set. The run counts as activity for idle sleep, as an exec does. Needs the exec and secret:use scopes.",
  },
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: () => "box.startup.run", target: (_input, box) => box.name },
  audit: {
    target: (_input, box) => box && boxTarget(box),
    detail: (_input, _resolved, result) => ({ status: result?.status ?? null }),
  },
  run: async ({ host }, input) => startupOutput(await runStartupCommand(host, input.id)),
});

export const startupOperations = [boxStartupGet, boxStartupSet, boxStartupDelete, boxStartupRun];
