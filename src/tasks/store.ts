import { Database } from "bun:sqlite";

import type { Source } from "../events/types";
import type { NewTask, TaskError, TaskStatus, TaskStreamEvent, TaskTarget, TaskView } from "./types";

/** How much of a task's log is kept. Older text is dropped; the view says so. */
export const TASK_LOG_MAX_BYTES = 64 * 1024;

/** Prefix shown when the retained log is only the newest tail. */
export const TASK_LOG_OMITTED = "… earlier output omitted …\n";

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    op TEXT NOT NULL,
    status TEXT NOT NULL,
    host_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    target_kind TEXT,
    target_id TEXT,
    target_name TEXT,
    principal_type TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    principal_name TEXT NOT NULL,
    source TEXT NOT NULL,
    run TEXT,
    parent_id TEXT,
    exclusive_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER,
    error_code TEXT,
    error_status INTEGER,
    error_message TEXT,
    error_key TEXT,
    error_params TEXT,
    result TEXT,
    log_bytes INTEGER NOT NULL DEFAULT 0,
    log_truncated INTEGER NOT NULL DEFAULT 0,
    next_seq INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX tasks_created ON tasks (created_at DESC, id DESC);
  CREATE UNIQUE INDEX tasks_one_running ON tasks (exclusive_key)
    WHERE status = 'running' AND exclusive_key IS NOT NULL;
  CREATE TABLE task_events (
    task_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT,
    status TEXT,
    error_code TEXT,
    error_status INTEGER,
    error_message TEXT,
    error_key TEXT,
    error_params TEXT,
    PRIMARY KEY (task_id, seq)
  );
  `,
  `
  ALTER TABLE tasks ADD COLUMN holds_lock INTEGER NOT NULL DEFAULT 0;
  UPDATE tasks SET holds_lock = 1 WHERE status = 'running';
  DROP INDEX tasks_one_running;
  CREATE UNIQUE INDEX tasks_one_running ON tasks (exclusive_key)
    WHERE holds_lock = 1 AND exclusive_key IS NOT NULL;
  `,
];

interface TaskRow {
  id: string;
  op: string;
  status: TaskStatus;
  host_id: string;
  summary: string;
  target_kind: string | null;
  target_id: string | null;
  target_name: string | null;
  principal_type: string;
  principal_id: string;
  principal_name: string;
  source: Source;
  run: string | null;
  parent_id: string | null;
  exclusive_key: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
  error_code: string | null;
  error_status: number | null;
  error_message: string | null;
  error_key: string | null;
  error_params: string | null;
  result: string | null;
  log_bytes: number;
  log_truncated: number;
  next_seq: number;
}

interface EventRow {
  task_id: string;
  seq: number;
  ts: number;
  kind: "log" | "status";
  text: string | null;
  status: TaskStatus | null;
  error_code: string | null;
  error_status: number | null;
  error_message: string | null;
  error_key: string | null;
  error_params: string | null;
}

export interface TaskOutcome {
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly result?: unknown;
  readonly error?: TaskError;
}

const iso = (ms: number) => new Date(ms).toISOString();

function paramsOf(text: string | null): TaskError["params"] {
  if (text === null) return undefined;
  const parsed = JSON.parse(text) as unknown;
  return typeof parsed === "object" && parsed !== null ? (parsed as TaskError["params"]) : undefined;
}

function errorOf(row: {
  error_code: string | null;
  error_status: number | null;
  error_message: string | null;
  error_key: string | null;
  error_params: string | null;
}): TaskError | undefined {
  if (row.error_code === null || row.error_message === null) return undefined;
  return {
    code: row.error_code,
    message: row.error_message,
    status: row.error_status ?? 0,
    key: row.error_key ?? undefined,
    params: paramsOf(row.error_params),
  };
}

function targetOf(row: TaskRow): TaskTarget | undefined {
  if (row.target_kind === null) return undefined;
  return { kind: row.target_kind, id: row.target_id ?? undefined, name: row.target_name ?? "" };
}

/** SQLite raises this when the running-task index already holds the key. */
function isUnique(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "";
  return code.includes("SQLITE_CONSTRAINT") || message.includes("UNIQUE constraint failed");
}

/**
 * Task rows and their log, in one SQLite file under DATA_DIR. The log keeps at most {@link TASK_LOG_MAX_BYTES}
 * of the newest text. Opening the file does not change running rows; {@link TaskStore.interruptRunning} does
 * that on startup.
 */
export class TaskStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  /**
   * Inserts a running task. Returns the id of the task that already holds `exclusiveKey`, when there is one,
   * instead of inserting a second.
   */
  insert(id: string, task: NewTask, now = Date.now()): { ok: true } | { ok: false; existingId: string } {
    try {
      this.db
        .query(
          `INSERT INTO tasks (id, op, status, host_id, summary, target_kind, target_id, target_name,
            principal_type, principal_id, principal_name, source, run, parent_id, exclusive_key, holds_lock,
            created_at, updated_at)
           VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          task.op,
          task.hostId,
          task.summary,
          task.target?.kind ?? null,
          task.target?.id ?? null,
          task.target?.name ?? null,
          task.principal.type,
          task.principal.id,
          task.principal.name,
          task.source,
          task.run ?? null,
          task.parentId ?? null,
          task.exclusiveKey ?? null,
          now,
          now,
        );
      return { ok: true };
    } catch (error) {
      if (!isUnique(error) || task.exclusiveKey === undefined) throw error;
      const existing = this.db
        .query<{ id: string }, [string]>("SELECT id FROM tasks WHERE exclusive_key = ? AND holds_lock = 1 LIMIT 1")
        .get(task.exclusiveKey);
      if (!existing) throw error;
      return { ok: false, existingId: existing.id };
    }
  }

  /** Appends a log chunk, dropping the oldest chunks while the retained text is over the cap. */
  appendLog(taskId: string, text: string, now = Date.now()): TaskStreamEvent | undefined {
    if (text === "") return undefined;
    return this.db.transaction(() => {
      const task = this.row(taskId);
      if (!task) return undefined;
      let chunk = text;
      let bytes = Buffer.byteLength(chunk);
      let truncated = task.log_truncated === 1;
      if (bytes > TASK_LOG_MAX_BYTES) {
        chunk = Buffer.from(chunk)
          .subarray(bytes - TASK_LOG_MAX_BYTES)
          .toString("utf8");
        bytes = Buffer.byteLength(chunk);
        truncated = true;
      }
      const seq = task.next_seq;
      this.insertEvent(taskId, seq, now, { kind: "log", text: chunk });
      let retained = task.log_bytes + bytes;
      while (retained > TASK_LOG_MAX_BYTES) {
        const oldest = this.db
          .query<{ seq: number; text: string }, [string]>(
            "SELECT seq, text FROM task_events WHERE task_id = ? AND kind = 'log' ORDER BY seq ASC LIMIT 1",
          )
          .get(taskId);
        if (!oldest) break;
        this.db.run("DELETE FROM task_events WHERE task_id = ? AND seq = ?", [taskId, oldest.seq]);
        retained -= Buffer.byteLength(oldest.text);
        truncated = true;
      }
      this.db.run("UPDATE tasks SET log_bytes = ?, log_truncated = ?, next_seq = ?, updated_at = ? WHERE id = ?", [
        Math.max(0, retained),
        truncated ? 1 : 0,
        seq + 1,
        now,
        taskId,
      ]);
      const event: TaskStreamEvent = { taskId, seq, ts: now, kind: "log", text: chunk };
      return event;
    })();
  }

  /**
   * Moves a running task to a terminal status. Returns false when it was no longer running, so a cancel and a
   * completion cannot overwrite each other. The exclusive key stays taken until {@link TaskStore.releaseLock}.
   */
  finish(taskId: string, outcome: TaskOutcome, now = Date.now()): TaskStreamEvent | undefined {
    return this.db.transaction(() => {
      const changed = this.db.run(
        `UPDATE tasks SET status = ?, updated_at = ?, finished_at = ?, result = ?,
           error_code = ?, error_status = ?, error_message = ?, error_key = ?, error_params = ?
         WHERE id = ? AND status = 'running'`,
        [
          outcome.status,
          now,
          now,
          outcome.result === undefined ? null : JSON.stringify(outcome.result),
          outcome.error?.code ?? null,
          outcome.error?.status ?? null,
          outcome.error?.message ?? null,
          outcome.error?.key ?? null,
          outcome.error?.params === undefined ? null : JSON.stringify(outcome.error.params),
          taskId,
        ],
      ).changes;
      if (changed !== 1) return undefined;
      const seq = this.row(taskId)?.next_seq ?? 1;
      this.insertEvent(taskId, seq, now, { kind: "status", status: outcome.status, error: outcome.error });
      this.db.run("UPDATE tasks SET next_seq = ? WHERE id = ?", [seq + 1, taskId]);
      const event: TaskStreamEvent = {
        taskId,
        seq,
        ts: now,
        kind: "status",
        status: outcome.status,
        error: outcome.error,
      };
      return event;
    })();
  }

  /**
   * Frees the exclusive key of a task whose background work has returned. A cancel leaves the key taken until then.
   */
  releaseLock(taskId: string): void {
    this.db.run("UPDATE tasks SET holds_lock = 0 WHERE id = ?", [taskId]);
  }

  /**
   * Marks every running task interrupted and frees every exclusive key. Used at startup, where the keys belong to
   * the previous process, and on shutdown. Returns how many tasks changed.
   */
  interruptRunning(error: TaskError, now = Date.now()): number {
    return this.db.transaction(() => {
      const changed = this.db.run(
        `UPDATE tasks SET status = 'interrupted', updated_at = ?, finished_at = ?,
           error_code = ?, error_status = ?, error_message = ?, error_key = ?, error_params = ?
         WHERE status = 'running'`,
        [
          now,
          now,
          error.code,
          error.status,
          error.message,
          error.key ?? null,
          error.params === undefined ? null : JSON.stringify(error.params),
        ],
      ).changes;
      this.db.run("UPDATE tasks SET holds_lock = 0 WHERE holds_lock = 1");
      return changed;
    })();
  }

  get(id: string, options: { output: boolean }): TaskView | undefined {
    const row = this.row(id);
    return row ? this.toView(row, options.output) : undefined;
  }

  /** Newest first. `output` is left off so a list of long builds stays small. */
  list(filter: { status?: TaskStatus; limit: number }): TaskView[] {
    const rows =
      filter.status === undefined
        ? this.db
            .query<TaskRow, [number]>("SELECT * FROM tasks ORDER BY created_at DESC, id DESC LIMIT ?")
            .all(filter.limit)
        : this.db
            .query<TaskRow, [string, number]>(
              "SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?",
            )
            .all(filter.status, filter.limit);
    return rows.map((row) => this.toView(row, false));
  }

  /** Events with `seq` greater than `after`, oldest first. */
  after(taskId: string, after: number, limit: number): TaskStreamEvent[] {
    return this.db
      .query<EventRow, [string, number, number]>(
        "SELECT * FROM task_events WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
      )
      .all(taskId, after, limit)
      .map((row) => this.toEvent(row));
  }

  /** The smallest stored cursor, or 0 when the task has no events. */
  oldest(taskId: string): number {
    return (
      this.db
        .query<{ seq: number }, [string]>("SELECT COALESCE(MIN(seq), 0) AS seq FROM task_events WHERE task_id = ?")
        .get(taskId)?.seq ?? 0
    );
  }

  /** The newest cursor, or 0 when the task has no events. */
  head(taskId: string): number {
    const row = this.row(taskId);
    return row ? Math.max(0, row.next_seq - 1) : 0;
  }

  close(): void {
    this.db.close();
  }

  private toView(row: TaskRow, withOutput: boolean): TaskView {
    const error = errorOf(row);
    const target = targetOf(row);
    return {
      id: row.id,
      op: row.op,
      status: row.status,
      summary: row.summary,
      hostId: row.host_id,
      target,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      finishedAt: row.finished_at === null ? undefined : iso(row.finished_at),
      error,
      result: row.result === null ? undefined : (JSON.parse(row.result) as unknown),
      output: withOutput ? this.output(row) : undefined,
      truncated: row.log_truncated === 1,
      logSeq: Math.max(0, row.next_seq - 1),
    };
  }

  private output(row: TaskRow): string {
    const chunks = this.db
      .query<{ text: string }, [string]>(
        "SELECT text FROM task_events WHERE task_id = ? AND kind = 'log' ORDER BY seq ASC",
      )
      .all(row.id)
      .map((event) => event.text);
    const text = chunks.join("");
    return row.log_truncated === 1 ? TASK_LOG_OMITTED + text : text;
  }

  private toEvent(row: EventRow): TaskStreamEvent {
    return {
      taskId: row.task_id,
      seq: row.seq,
      ts: row.ts,
      kind: row.kind,
      text: row.text ?? undefined,
      status: row.status ?? undefined,
      error: errorOf(row),
    };
  }

  private insertEvent(
    taskId: string,
    seq: number,
    ts: number,
    event: { kind: "log"; text: string } | { kind: "status"; status: TaskStatus; error?: TaskError },
  ): void {
    const text = event.kind === "log" ? event.text : null;
    const status = event.kind === "status" ? event.status : null;
    const error = event.kind === "status" ? event.error : undefined;
    this.db.run(
      `INSERT INTO task_events (task_id, seq, ts, kind, text, status, error_code, error_status, error_message, error_key, error_params)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        seq,
        ts,
        event.kind,
        text,
        status,
        error?.code ?? null,
        error?.status ?? null,
        error?.message ?? null,
        error?.key ?? null,
        error?.params === undefined ? null : JSON.stringify(error.params),
      ],
    );
  }

  private row(id: string): TaskRow | undefined {
    return this.db.query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?").get(id) ?? undefined;
  }

  private migrate(): void {
    const current = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    MIGRATIONS.slice(current).forEach((sql, index) => {
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.exec(`PRAGMA user_version = ${current + index + 1}`);
      })();
    });
  }
}
