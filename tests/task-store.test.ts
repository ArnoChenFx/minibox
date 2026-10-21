import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ulid } from "../src/events/ulid";
import { TaskStore } from "../src/tasks/store";
import type { NewTask, TaskError } from "../src/tasks/types";

/** The schema at `user_version = 1`, before the lock column. Copied here so the upgrade is tested as it shipped. */
const SCHEMA_V1 = `
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
`;

const KEY = "template.build:local";

const template: NewTask = {
  op: "template.build",
  summary: "Build the base template",
  hostId: "local",
  principal: { type: "owner", id: "owner", name: "owner" },
  source: "rest",
  exclusiveKey: KEY,
};

const cancelled: TaskError = { code: "cancelled", message: "The task was cancelled.", status: 409 };
const interrupted: TaskError = {
  code: "interrupted",
  message: "The server stopped before the task finished.",
  status: 500,
};

function insertV1(db: Database, id: string, status: string): void {
  db.run(
    `INSERT INTO tasks (id, op, status, host_id, summary, principal_type, principal_id, principal_name, source,
       exclusive_key, created_at, updated_at)
     VALUES (?, 'template.build', ?, 'local', 'Build the base template', 'owner', 'owner', 'owner', 'rest', ?, 1, 1)`,
    [id, status, KEY],
  );
}

function versionOf(path: string): number | undefined {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
  } finally {
    raw.close();
  }
}

describe("TaskStore exclusive keys", () => {
  let dir: string;
  let store: TaskStore | undefined;

  const open = (path = join(dir, "tasks.db")): TaskStore => {
    store = new TaskStore(path);
    return store;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "minibox-task-store-"));
  });

  afterEach(() => {
    store?.close();
    store = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  test("a database from before the lock column keeps its running key until startup frees it", () => {
    const path = join(dir, "tasks.db");
    const old = new Database(path, { create: true });
    old.exec(SCHEMA_V1);
    old.run("PRAGMA user_version = 1");
    const running = ulid();
    insertV1(old, running, "running");
    insertV1(old, ulid(), "succeeded");
    old.close();

    const s = open(path);
    expect(versionOf(path)).toBe(2);
    expect(s.insert(ulid(), template)).toEqual({ ok: false, existingId: running });
    expect(s.interruptRunning(interrupted)).toBe(1);
    expect(s.insert(ulid(), template)).toEqual({ ok: true });
  });

  test("a cancelled task keeps its key until its work releases it", () => {
    const s = open();
    const first = ulid();
    expect(s.insert(first, template)).toEqual({ ok: true });
    s.finish(first, { status: "cancelled", error: cancelled });

    expect(s.insert(ulid(), template)).toEqual({ ok: false, existingId: first });
    s.releaseLock(first);
    expect(s.insert(ulid(), template)).toEqual({ ok: true });
    expect(s.get(first, { output: false })?.status).toBe("cancelled");
  });

  test("startup frees the key of a cancelled task whose work never returned, without changing its status", () => {
    const path = join(dir, "tasks.db");
    const before = open(path);
    const first = ulid();
    before.insert(first, template);
    before.finish(first, { status: "cancelled", error: cancelled });
    before.close();
    store = undefined;

    const after = open(path);
    expect(after.interruptRunning(interrupted)).toBe(0);
    expect(after.insert(ulid(), template)).toEqual({ ok: true });
    expect(after.get(first, { output: false })?.status).toBe("cancelled");
  });
});
