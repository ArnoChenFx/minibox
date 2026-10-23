import type { Redactor } from "../events/redact";
import { ulid } from "../events/ulid";
import { abortError } from "../lib/abort";
import { AppError, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { type TaskOutcome, TaskStore } from "./store";
import type {
  NewTask,
  TaskError,
  TaskHandle,
  TaskReader,
  TaskStatus,
  TaskStreamEvent,
  TaskTarget,
  TaskView,
} from "./types";

const SHUTDOWN_DRAIN_MS = 200;

/** Where a task ran and what it was about. Handed to `onSettled` once the task's work has ended. */
export interface TaskSubject {
  readonly hostId: string;
  readonly target?: TaskTarget;
}

function taskError(code: string, status: number, key: "task_cancelled" | "task_interrupted"): TaskError {
  const message = msg(key);
  return { code, message: message.text, status, key: message.key };
}

const cancelledError = () => taskError("cancelled", 409, "task_cancelled");
const interruptedError = () => taskError("interrupted", 500, "task_interrupted");

/**
 * Owns running tasks: one row in the store, one abort controller, and a publish for each log line and status change.
 * The executor starts work and finishes it; cancellation and a restarted process both stop a task without resuming it.
 */
export class TaskManager implements TaskReader {
  private readonly running = new Map<string, AbortController>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly subjects = new Map<string, TaskSubject>();
  /** The exclusive key of each task this process began with one, so its end can start the next queued task. */
  private readonly keys = new Map<string, string>();
  /** Queued tasks waiting for their turn, resolved when {@link TaskStore.promote} starts them. */
  private readonly waiting = new Map<string, () => void>();

  constructor(
    private readonly store: TaskStore,
    private readonly redactor: Redactor,
    private readonly publish: (event: TaskStreamEvent) => void,
    /** Runs once a task's work has ended, so the owner can treat the end as activity (#12). A throw is logged only. */
    private readonly onSettled?: (subject: TaskSubject) => void,
  ) {}

  /**
   * Inserts a running task. A second task with the same exclusive key is refused with `409` and `details.taskId`
   * of the one already running. With `queue` it is inserted as `queued` instead, and starts when the tasks ahead of it
   * have ended (see {@link TaskManager.turn}). A queued begin that repeats a queued or running task returns that task
   * with `duplicate` and no handle, so the caller reports its id and starts nothing.
   */
  begin(task: NewTask): { id: string; handle: TaskHandle; duplicate?: false } | { id: string; duplicate: true } {
    const id = ulid();
    const inserted = this.store.insert(id, task);
    if (!inserted.ok) {
      if (inserted.duplicate) return { id: inserted.existingId, duplicate: true };
      throw new AppError(409, "conflict", msg("task_busy"), { taskId: inserted.existingId });
    }
    const controller = new AbortController();
    this.running.set(id, controller);
    this.subjects.set(id, { hostId: task.hostId, target: task.target });
    if (task.exclusiveKey !== undefined) this.keys.set(id, task.exclusiveKey);
    const handle: TaskHandle = {
      id,
      signal: controller.signal,
      log: (text) => {
        const event = this.store.appendLog(id, this.redactor.text(text));
        if (event) this.publish(event);
      },
    };
    return { id, handle };
  }

  /**
   * Resolves when the task may do its work: at once for a running task, and for a queued one when every task ahead of
   * it on the same key has ended. Rejects with an AbortError when the task is cancelled or the server shuts down first.
   */
  turn(id: string): Promise<void> {
    if (this.store.get(id, { output: false })?.status !== "queued") return Promise.resolve();
    const signal = this.running.get(id)?.signal;
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = () => {
        this.waiting.delete(id);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.set(id, () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }

  /** Starts the next task queued on `key`, if the key is free. */
  private promote(key: string): void {
    let promoted: ReturnType<TaskStore["promote"]>;
    try {
      promoted = this.store.promote(key);
    } catch (error) {
      log.warn("task.promote_failed", { key, error: String(error) });
      return;
    }
    if (!promoted) return;
    this.publish(promoted.event);
    const wake = this.waiting.get(promoted.taskId);
    this.waiting.delete(promoted.taskId);
    wake?.();
  }

  /**
   * Runs `work` in the background and frees the task's exclusive key once `work` has settled. A rejection is logged;
   * it does not escape to the request that started the task.
   */
  track(id: string, work: Promise<void>): void {
    const job = work
      .catch((error: unknown) => {
        log.error("task.worker_failed", { task: id, error: String(error) });
      })
      .finally(() => {
        this.releaseLock(id);
        this.running.delete(id);
        this.jobs.delete(id);
        this.waiting.delete(id);
        const key = this.keys.get(id);
        this.keys.delete(id);
        this.settle(id);
        if (key !== undefined) this.promote(key);
      });
    this.jobs.set(id, job);
  }

  private settle(id: string): void {
    const subject = this.subjects.get(id);
    this.subjects.delete(id);
    if (!subject || !this.onSettled) return;
    try {
      this.onSettled(subject);
    } catch (error) {
      log.warn("task.settle_failed", { task: id, error: String(error) });
    }
  }

  /**
   * A store that `crash` or `shutdown` has closed cannot take the write. The key is then freed by the next startup,
   * which interrupts every task left holding it.
   */
  private releaseLock(id: string): void {
    try {
      this.store.releaseLock(id);
    } catch (error) {
      log.warn("task.lock_release_failed", { task: id, error: String(error) });
    }
  }

  /** Resolves when the background work for `id` has finished. A task that was never tracked resolves at once. */
  done(id: string): Promise<void> {
    return this.jobs.get(id) ?? Promise.resolve();
  }

  /** Resolves when every background task has finished. */
  drain(): Promise<void> {
    return Promise.all(this.jobs.values()).then(() => undefined);
  }

  /**
   * Moves a running task to a terminal status and publishes it. Returns false when the task was no longer running,
   * so a cancel and a completion cannot overwrite each other.
   */
  finish(id: string, outcome: TaskOutcome): boolean {
    const event = this.store.finish(id, {
      status: outcome.status,
      result: outcome.result === undefined ? undefined : this.redactor.value(outcome.result),
      error: outcome.error && { ...outcome.error, message: this.redactor.text(outcome.error.message) },
    });
    if (!event) return false;
    this.publish(event);
    return true;
  }

  get(id: string, options: { output: boolean }): TaskView | undefined {
    return this.store.get(id, options);
  }

  list(filter: { status?: TaskStatus; limit: number }): TaskView[] {
    return this.store.list(filter);
  }

  /** True when an async task (#16) is running for this box. Exempts the box from idle sleep. */
  hasRunningForBox(boxId: string, containerId?: string): boolean {
    for (const id of this.running.keys()) {
      const task = this.store.get(id, { output: false });
      if (!task || task.target?.kind !== "box") continue;
      const targetId = task.target.id;
      if (targetId === boxId || (containerId !== undefined && targetId === containerId)) return true;
      if (task.target.name && (task.target.name === boxId || task.target.name === containerId)) return true;
    }
    return false;
  }

  /**
   * Marks a running or queued task cancelled and aborts its work. The task keeps its exclusive key until the work has
   * returned, so a new task for the same box or host is refused with `409` (or queued) until then. A commit the engine
   * has already finished is left in place. A queued task leaves the queue without running. A finished task is a 409.
   */
  cancel(id: string): TaskView {
    const current = this.store.get(id, { output: false });
    if (!current) throw notFound(msg("task_not_found"));
    if (current.status !== "running" && current.status !== "queued") {
      throw new AppError(409, "conflict", msg("task_not_running"));
    }
    this.finish(id, { status: "cancelled", error: cancelledError() });
    this.running.get(id)?.abort(abortError());
    const view = this.store.get(id, { output: true });
    if (!view) throw notFound(msg("task_not_found"));
    if (view.status !== "cancelled") throw new AppError(409, "conflict", msg("task_not_running"));
    return view;
  }

  /** Marks tasks still running from a previous process as interrupted. They are not resumed. */
  recover(): number {
    return this.store.interruptRunning(interruptedError());
  }

  after(taskId: string, after: number, limit: number): TaskStreamEvent[] {
    return this.store.after(taskId, after, limit);
  }

  oldest(taskId: string): number {
    return this.store.oldest(taskId);
  }

  head(taskId: string): number {
    return this.store.head(taskId);
  }

  /**
   * Closes the database without changing rows, so a later open can show the tasks as interrupted. The in-flight
   * work is left to fail on its own. Tests use this to imitate a crash.
   */
  crash(): void {
    this.running.clear();
    this.jobs.clear();
    this.subjects.clear();
    this.keys.clear();
    this.waiting.clear();
    this.store.close();
  }

  /** Aborts running work, marks it interrupted, waits briefly, and closes the database. */
  async shutdown(): Promise<void> {
    for (const controller of this.running.values()) controller.abort(abortError());
    this.store.interruptRunning(interruptedError());
    await Promise.race([this.drain(), Bun.sleep(SHUTDOWN_DRAIN_MS)]);
    this.store.close();
  }
}
