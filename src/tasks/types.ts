import type { Source } from "../events/types";

/** Crockford base32, 26 characters. The same shape as an event id. */
export const TASK_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * `queued` waits for another task holding the same exclusive key to end. `running` is in progress. `interrupted` means
 * the process stopped before the task finished.
 */
export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
];

/** A terminal status does not change again. */
export const isTerminal = (status: TaskStatus): boolean => status !== "running" && status !== "queued";

/** The object a task is about. Same shape as an event target. */
export interface TaskTarget {
  readonly kind: string;
  readonly id?: string;
  readonly name: string;
}

/** Why a task stopped short of success. `key` lets the UI translate `message`. */
export interface TaskError {
  readonly code: string;
  readonly message: string;
  readonly status: number;
  readonly key?: string;
  readonly params?: Record<string, string | number>;
}

/**
 * One long-running operation. `output` is the retained log, newest tail only, and is omitted from lists.
 * `logSeq` is the cursor a progress stream resumes from.
 */
export interface TaskView {
  readonly id: string;
  readonly op: string;
  readonly status: TaskStatus;
  readonly summary: string;
  /** The name the task acted on, such as a tool id or a snapshot name. Absent when the operation names none. */
  readonly subject?: string;
  readonly hostId: string;
  /** The principal that started the task. Visibility checks use it, and the public task shape leaves it out. */
  readonly principalId: string;
  readonly target?: TaskTarget;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt?: string;
  readonly error?: TaskError;
  readonly result?: unknown;
  readonly output?: string;
  readonly truncated: boolean;
  readonly logSeq: number;
}

/** A task as the API reports it: every field except the principal, which only the visibility checks read. */
export function publicTask({ principalId: _principalId, ...task }: TaskView): Omit<TaskView, "principalId"> {
  return task;
}

/** What the task stream and the `task` bus topic carry. `seq` is the cursor, shared by logs and status changes. */
export interface TaskStreamEvent {
  readonly taskId: string;
  readonly seq: number;
  readonly ts: number;
  readonly kind: "log" | "status";
  readonly text?: string;
  readonly status?: TaskStatus;
  readonly error?: TaskError;
}

/** Handed to the operation while it runs, so it can report output and watch for cancellation. */
export interface TaskHandle {
  readonly id: string;
  readonly signal: AbortSignal;
  log(text: string): void;
}

/** What operations read. The manager implements it; the executor puts it on the context. */
export interface TaskReader {
  get(id: string, options: { output: boolean }): TaskView | undefined;
  list(filter: { status?: TaskStatus; limit: number }): TaskView[];
  cancel(id: string): TaskView;
  /** Resolves once the task's background work has ended, so a caller can read its final status. */
  done(id: string): Promise<void>;
}

/** Who started a task. Stored with the task; the audit event records the same principal. */
export interface TaskPrincipal {
  readonly type: string;
  readonly id: string;
  readonly name: string;
}

/** Fields the executor knows before the work starts. */
export interface NewTask {
  readonly op: string;
  readonly summary: string;
  readonly subject?: string;
  readonly hostId: string;
  readonly target?: TaskTarget;
  readonly principal: TaskPrincipal;
  readonly source: Source;
  readonly run?: string;
  readonly parentId?: string;
  /** While a task with this key is running, another begin with the same key is refused, or queued with `queue`. */
  readonly exclusiveKey?: string;
  /**
   * Wait in line behind the task that holds `exclusiveKey` instead of being refused. A begin that matches a queued or
   * running task with the same op, key, subject and target joins that task instead of adding a second.
   */
  readonly queue?: boolean;
}
