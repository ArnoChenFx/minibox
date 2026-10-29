import { z } from "zod";

import { AppError, notFound } from "../lib/errors";
import { msg } from "../lib/messages";
import { accept, type Checked, reject } from "../lib/validation";
import { MB } from "../services/box-model";
import { getBox, readBox } from "../services/boxes";
import { assertTakeable, type TakeCheckpointInput, takeCheckpoint } from "../services/checkpoints";
import { revokeSelfToken } from "../services/self-token";
import { boxTakenOverError } from "../services/terminal-attachment";
import type { TerminalService } from "../services/terminals";
import { ttlEndsAt } from "../specs/lifetime";
import { publicTask } from "../tasks/types";
import { assertCheckpointQuota, underCheckpointQuota } from "../tokens/quota";
import { SELF_SCOPE } from "../tokens/self-policy";
import { assertHostDiskRoom } from "../volumes/disk";
import { boxTarget } from "./boxes";
import { defineOperation } from "./define";
import { questionId, questionMessage, questionOptions } from "./questions";
import { hostOfBox } from "./routing";
import { BoxSchema, CheckpointSchema, OkSchema, QuestionSchema, SelfInfoSchema, TaskSchema } from "./schemas";
import { taskId, tasksOf } from "./tasks";
import type { OperationContext } from "./types";
import { boxId, checkpointLabel, checkpointReason, field } from "./validation";

/** The states an agent reports. The console shows them in the activity feed. */
const AGENT_STATES = ["working", "waiting", "done", "failed"] as const;
type AgentState = (typeof AGENT_STATES)[number];

const NOTE_MAX = 500;

function checkState(value: unknown): Checked<AgentState> {
  if (typeof value === "string" && (AGENT_STATES as readonly string[]).includes(value)) {
    return accept(value as AgentState);
  }
  return reject(msg("self_state_invalid", { states: AGENT_STATES.join(", ") }), "state");
}

function checkNote(value: unknown): Checked<string> {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "" || [...text].length > NOTE_MAX || /\p{Cc}/u.test(text)) {
    return reject(msg("self_note_invalid", { max: NOTE_MAX }), "note");
  }
  return accept(text);
}

const stateField = () =>
  field(checkState, {
    type: "string",
    enum: [...AGENT_STATES],
    description: "What the agent is doing: working, waiting for a person, done, or failed.",
  });

const noteField = () =>
  field(checkNote, {
    type: "string",
    minLength: 1,
    maxLength: NOTE_MAX,
    description: `One line of plain text, at most ${NOTE_MAX} characters, saying what the state means now.`,
  });

/**
 * The box a self token belongs to is the principal's id. Every self operation resolves that box, its task or its
 * question, and nothing else, so the host it runs on is the box's host.
 */
const ownHost = (ctx: OperationContext) => hostOfBox(ctx, ctx.principal.id);

/** The box's agent is at work in it, so the box stays up while the agent keeps asking, as an exec or a terminal keeps it. */
function touchSelf(ctx: OperationContext): void {
  ctx.host.pulse.touch(ctx.principal.id, "self");
}

function terminalsOf(ctx: OperationContext): TerminalService {
  if (!ctx.terminals) throw new AppError(500, "internal", "terminal service is not configured");
  return ctx.terminals;
}

const selfCheckpointInput = z.object({
  label: checkpointLabel(),
  reason: checkpointReason(),
  consistency: z.enum(["live", "pause"]).default("live").meta({
    description:
      "How the box is held for the backup. live (default) reads the volumes while the box runs. pause freezes the box, and so the agent, until the backup is done. Stopping the box is not offered to its own agent.",
  }),
});

type SelfCheckpointInput = z.output<typeof selfCheckpointInput>;

function selfTakeInput(input: SelfCheckpointInput): TakeCheckpointInput {
  return {
    label: input.label,
    reason: input.reason,
    pinned: false,
    include: { system: false, volumes: [] },
    consistency: input.consistency,
  };
}

const selfInfo = defineOperation({
  name: "self.info",
  tag: "self",
  summary: "Get this box's name, size and remaining TTL",
  kind: "read",
  scope: SELF_SCOPE,
  async: false,
  input: z.object({}),
  output: SelfInfoSchema,
  rest: [{ method: "GET", path: "/api/self" }],
  mcp: {
    toolset: "self",
    name: "get_info",
    description: "Get this box's name, template, size, state and remaining TTL.",
  },
  hostFor: ownHost,
  resolve: ({ host, principal }) => readBox(host, principal.id),
  run: async (ctx, _input, box) => {
    touchSelf(ctx);
    const spec = ctx.host.specs.read(box.boxId);
    if (!spec) throw notFound(msg("box_not_found"));
    const ends = ttlEndsAt(spec);
    return {
      boxId: box.boxId,
      name: box.name,
      state: box.state,
      running: box.running,
      template: box.template,
      profile: box.profile,
      cpus: spec.resources.cpus,
      memoryMb: spec.resources.memoryBytes === null ? null : Math.round(spec.resources.memoryBytes / MB),
      createdAt: spec.createdAt,
      ttlEndsAt: ends === null ? null : new Date(ends).toISOString(),
      remainingTtlSec: ends === null ? null : Math.max(0, Math.ceil((ends - Date.now()) / 1000)),
    };
  },
});

const selfCheckpoint = defineOperation({
  name: "self.checkpoint",
  tag: "self",
  summary: "Take a checkpoint of this box",
  kind: "write",
  scope: SELF_SCOPE,
  async: true,
  conflicts: true,
  input: selfCheckpointInput,
  output: z.object({ checkpoint: CheckpointSchema }),
  rest: [{ method: "POST", path: "/api/self/checkpoints", body: true, status: 202 }],
  mcp: {
    toolset: "self",
    name: "checkpoint",
    description:
      "Take a checkpoint of this box before a risky step. It runs as a task: poll get_task with the returned task id until it succeeds. Counts against the box's own checkpoint limit.",
  },
  hostFor: ownHost,
  resolve: ({ host, principal }) => getBox(host, principal.id),
  beforeTask: async (ctx, input, box) => {
    assertTakeable(ctx.host, box, selfTakeInput(input));
    assertCheckpointQuota(ctx);
    await assertHostDiskRoom(ctx.host);
    if (terminalsOf(ctx).humanHolds(box.id)) throw boxTakenOverError(box.name);
  },
  exclusive: ({ host }, _input, box) => `checkpoint.box:${host.host.id}:${box.boxId}`,
  activity: { action: () => "self.checkpoint", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box), detail: (input, box) => ({ ...input, boxId: box?.boxId }) },
  run: async (ctx, input, box) => {
    touchSelf(ctx);
    return {
      checkpoint: await underCheckpointQuota(ctx, () =>
        takeCheckpoint(ctx.host, box.boxId, selfTakeInput(input), ctx.principal.id, ctx.task),
      ),
    };
  },
});

const selfTask = defineOperation({
  name: "self.task",
  tag: "self",
  summary: "Get a task this box started",
  kind: "read",
  scope: SELF_SCOPE,
  async: false,
  input: z.object({ id: taskId() }),
  output: TaskSchema,
  rest: [{ method: "GET", path: "/api/self/tasks/:id" }],
  mcp: {
    toolset: "self",
    name: "get_task",
    description: "Get a task this box started, such as a checkpoint, with its status and, once done, its result.",
  },
  hostFor: ownHost,
  resolve: async ({ tasks, principal }, input) => {
    const task = tasksOf(tasks).get(input.id, { output: true });
    if (!task || task.principalId !== principal.id) throw notFound(msg("task_not_found"));
    return task;
  },
  run: async (ctx, _input, task) => {
    touchSelf(ctx);
    return publicTask(task);
  },
});

const selfAsk = defineOperation({
  name: "self.ask",
  tag: "self",
  summary: "Ask a person a question",
  kind: "write",
  scope: SELF_SCOPE,
  async: false,
  input: z.object({ message: questionMessage(), options: questionOptions() }),
  output: z.object({ question: QuestionSchema }),
  rest: [{ method: "POST", path: "/api/self/questions", body: true, status: 201 }],
  mcp: {
    toolset: "self",
    name: "ask_human",
    description:
      "Ask a person a question. It appears in the console and in notifications, and the answer is kept on the question: poll get_question with the returned id. Pass options to offer choices, or leave them out for a free-text answer. This does not wait for approval.",
  },
  hostFor: ownHost,
  resolve: ({ host, principal }) => readBox(host, principal.id),
  activity: { action: () => "self.ask", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box), detail: (input, box) => ({ ...input, boxId: box?.boxId }) },
  run: async (ctx, input, box) => {
    touchSelf(ctx);
    return { question: ctx.host.questions.ask(box.boxId, input) };
  },
});

const selfQuestion = defineOperation({
  name: "self.question",
  tag: "self",
  summary: "Get a question this box asked",
  kind: "read",
  scope: SELF_SCOPE,
  async: false,
  input: z.object({ id: questionId() }),
  output: z.object({ question: QuestionSchema }),
  rest: [{ method: "GET", path: "/api/self/questions/:id" }],
  mcp: {
    toolset: "self",
    name: "get_question",
    description: "Get a question this box asked. Its answer is null until a person answers it.",
  },
  hostFor: ownHost,
  resolve: async ({ host, principal }, input) => {
    const question = host.questions.get(input.id);
    if (!question || question.boxId !== principal.id) throw notFound(msg("question_not_found", { id: input.id }));
    return question;
  },
  run: async (ctx, _input, question) => {
    touchSelf(ctx);
    return { question };
  },
});

const selfStatus = defineOperation({
  name: "self.status",
  tag: "self",
  summary: "Report what this box's agent is doing",
  kind: "write",
  scope: SELF_SCOPE,
  async: false,
  input: z.object({ state: stateField(), note: noteField() }),
  output: OkSchema,
  rest: [{ method: "POST", path: "/api/self/status", body: true }],
  mcp: {
    toolset: "self",
    name: "report_status",
    description:
      "Report what the agent is doing, as one of working, waiting, done or failed, with a short note. It shows in the box's activity and event log.",
  },
  hostFor: ownHost,
  resolve: ({ host, principal }) => readBox(host, principal.id),
  activity: { action: () => "self.status", target: (input, box) => `${box.name}: ${input.state}` },
  audit: { target: (_input, box) => box && boxTarget(box), detail: (input, box) => ({ ...input, boxId: box?.boxId }) },
  run: async (ctx) => {
    touchSelf(ctx);
    return { ok: true as const };
  },
});

const boxSelfRevoke = defineOperation({
  name: "box.self.revoke",
  tag: "boxes",
  summary: "Revoke a box's self token",
  kind: "write",
  scope: "box:write",
  async: false,
  conflicts: true,
  input: z.object({ id: boxId() }),
  output: z.object({ box: BoxSchema }),
  rest: [{ method: "DELETE", path: "/api/boxes/:id/self-token" }],
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: () => "box.self.revoke", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host }, _input, box) => {
    await revokeSelfToken(host, box.boxId);
    return { box: await getBox(host, box.boxId) };
  },
});

export const selfOperations = [selfInfo, selfCheckpoint, selfTask, selfAsk, selfQuestion, selfStatus, boxSelfRevoke];
