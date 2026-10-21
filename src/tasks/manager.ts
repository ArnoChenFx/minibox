import type { Redactor } from "../events/redact";
import { ulid } from "../events/ulid";
import { abortError } from "../lib/abort";
import { AppError, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { type TaskOutcome, TaskStore } from "./store";
import type { NewTask, TaskError, TaskHandle, TaskReader, TaskStatus, TaskStreamEvent, TaskView } from "./types";

const SHUTDOWN_DRAIN_MS = 200;

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

  constructor(
    private readonly store: TaskStore,
    private readonly redactor: Redactor,
    private readonly publish: (event: TaskStreamEvent) => void,
  ) {}

  /**
   * Inserts a running task. A second task with the same exclusive key is refused with `409` and `details.taskId`
   * of the one already running.
   */
  begin(task: NewTask): { id: string; handle: TaskHandle } {
    const id = ulid();
    const inserted = this.store.insert(id, task);
    if (!inserted.ok) throw new AppError(409, "conflict", msg("task_busy"), { taskId: inserted.existingId });
    const controller = new AbortController();
    this.running.set(id, controller);
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

  /** Runs `work` in the background. A rejection is logged; it does not escape to the request that started the task. */
  track(id: string, work: Promise<void>): void {
    const job = work
      .catch((error: unknown) => {
        log.error("task.worker_failed", { task: id, error: String(error) });
      })
      .finally(() => {
        this.running.delete(id);
        this.jobs.delete(id);
      });
    this.jobs.set(id, job);
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

  /**
   * Marks a running task cancelled and aborts its work. The engine may already have finished a commit; that image
   * is left in place. A task that is not running is a 409.
   */
  cancel(id: string): TaskView {
    const current = this.store.get(id, { output: false });
    if (!current) throw notFound(msg("task_not_found"));
    if (current.status !== "running") throw new AppError(409, "conflict", msg("task_not_running"));
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
