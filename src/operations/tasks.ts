import { z } from "zod";

import { notFound } from "../lib/errors";
import { msg } from "../lib/messages";
import { accept, type Checked, reject } from "../lib/validation";
import { TASK_ID_RE, TASK_STATUSES, type TaskReader, type TaskStatus, publicTask } from "../tasks/types";
import { specViews, taskVisible } from "../tokens/model";
import { defineOperation } from "./define";
import { TaskSchema } from "./schemas";
import { field } from "./validation";

const TASK_LIMIT = { default: 50, max: 200 } as const;

function checkStatus(value: unknown): Checked<TaskStatus | undefined> {
  if (value === undefined || value === null || value === "") return accept(undefined);
  if (typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value)) {
    return accept(value as TaskStatus);
  }
  return reject(msg("task_status_invalid"), "status");
}

function checkLimit(value: unknown): Checked<number> {
  if (value === undefined || value === null || value === "") return accept(TASK_LIMIT.default);
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > TASK_LIMIT.max) {
    return reject(msg("task_limit_range", { max: TASK_LIMIT.max }), "limit");
  }
  return accept(n);
}

export const taskId = () =>
  field(
    (value) => {
      if (typeof value !== "string" || !TASK_ID_RE.test(value)) return reject(msg("task_id_invalid"), "id");
      return accept(value);
    },
    {
      type: "string",
      minLength: 26,
      maxLength: 26,
      pattern: TASK_ID_RE.source,
      description: "Task id, a 26-character ULID.",
    },
  );

export function tasksOf(tasks: TaskReader | undefined): TaskReader {
  if (!tasks) throw new Error("task operations require a task manager");
  return tasks;
}

const taskList = defineOperation({
  name: "task.list",
  tag: "tasks",
  summary: "List tasks",
  kind: "read",
  scope: "task:read",
  async: false,
  input: z.object({
    status: field(checkStatus, {
      type: "string",
      enum: [...TASK_STATUSES],
      description: "Only tasks in this status. Omit it to list every status.",
    }).optional(),
    limit: field(checkLimit, {
      type: "integer",
      minimum: 1,
      maximum: TASK_LIMIT.max,
      description: `Tasks per page, between 1 and ${TASK_LIMIT.max}. Defaults to ${TASK_LIMIT.default}. Newest first.`,
    }).default(TASK_LIMIT.default),
  }),
  output: z.object({ tasks: z.array(TaskSchema) }),
  rest: [{ method: "GET", path: "/api/tasks", query: ["status", "limit"] }],
  run: async ({ tasks, host, principal, boxViews }, input) => {
    const reader = tasksOf(tasks);
    if (principal.type === "owner") {
      return { tasks: reader.list({ status: input.status, limit: input.limit }).map(publicTask) };
    }
    const boxes = boxViews?.() ?? specViews(host.specs.list());
    const visible = reader
      .list({ status: input.status, limit: TASK_LIMIT.max })
      .filter((task) => taskVisible(principal, task, boxes));
    return { tasks: visible.slice(0, input.limit).map(publicTask) };
  },
});

const taskGet = defineOperation({
  name: "task.get",
  tag: "tasks",
  summary: "Get a task",
  kind: "read",
  scope: "task:read",
  async: false,
  input: z.object({ id: taskId() }),
  output: TaskSchema,
  rest: [{ method: "GET", path: "/api/tasks/:id" }],
  run: async ({ tasks, host, principal, boxViews }, input) => {
    const task = tasksOf(tasks).get(input.id, { output: true });
    if (!task) throw notFound(msg("task_not_found"));
    if (principal.type !== "owner" && !taskVisible(principal, task, boxViews?.() ?? specViews(host.specs.list()))) {
      throw notFound(msg("task_not_found"));
    }
    return publicTask(task);
  },
});

const taskCancel = defineOperation({
  name: "task.cancel",
  tag: "tasks",
  summary: "Cancel a task",
  kind: "write",
  scope: "task:write",
  async: false,
  conflicts: true,
  input: z.object({ id: taskId() }),
  output: TaskSchema,
  rest: [{ method: "POST", path: "/api/tasks/:id/cancel" }],
  activity: { action: () => "task.cancel", target: ({ id }) => id },
  audit: { target: ({ id }) => ({ kind: "task", name: id }) },
  run: async ({ tasks }, input) => publicTask(tasksOf(tasks).cancel(input.id)),
});

export const taskOperations = [taskList, taskGet, taskCancel];
