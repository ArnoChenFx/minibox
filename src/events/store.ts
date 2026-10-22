import { Database } from "bun:sqlite";

import { type Redactor, redactEvent } from "./redact";
import type { EventInput, EventStatus } from "./types";

/** `audit` events are kept longest. `activity` holds reads and exec events. Only reads are merged per minute. */
export type Tier = "audit" | "activity";

/** A recorded event: the redacted input, its cursor, its tier, and how many reads it stands for. */
export interface StoredEvent extends EventInput {
  readonly seq: number;
  readonly tier: Tier;
  readonly count: number;
}

export interface EventFilter {
  readonly box?: string;
  readonly principal?: string;
  readonly op?: string;
  readonly status?: EventStatus;
  readonly run?: string;
  /** Epoch milliseconds. Events at or after this time match. */
  readonly since?: number;
  /**
   * Limits added for a token or a box-self principal. Combined with the caller's filters: a caller can narrow the
   * result, not widen it. Absent for the owner and for an admin token that may read the whole log.
   */
  readonly visible?: EventVisibility;
}

/**
 * A box name a principal may read events under, from the moment that box was created. Box names are unique while a
 * box holds them, so an event with the name at or after `since` is about that box, and an earlier box that used the
 * name is left out.
 */
export interface NamedBox {
  readonly name: string;
  readonly since: number;
}

/**
 * Which events a non-owner may read. `boxes: null` means every event about a box, plus the principal's own events.
 * `hosts: null` means every host. An empty id list matches no box; the principal's own events still match. Boxes are
 * matched by id first. A name is kept for events recorded under it, which hold the container id a rebuild replaces.
 */
export interface EventVisibility {
  readonly principalId: string;
  readonly boxes: { readonly ids: readonly string[]; readonly names: readonly NamedBox[] } | null;
  readonly hosts: readonly string[] | null;
}

export interface EventPage {
  readonly events: StoredEvent[];
  /** Pass as `before` to get the next, older page. `null` when there is nothing older. */
  readonly nextCursor: number | null;
}

export interface AppendResult {
  readonly event: StoredEvent;
  /** `true` when the event was counted on an earlier read in the same minute instead of being stored as a new row. */
  readonly merged: boolean;
}

export interface PruneWindows {
  readonly auditMs: number;
  readonly activityMs: number;
}

/** Details larger than this are replaced by a note with their size. Events stay small enough to page through. */
export const DETAIL_MAX_BYTES = 8 * 1024;

const MINUTE_MS = 60_000;

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    ts INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    status TEXT NOT NULL,
    op TEXT NOT NULL,
    kind TEXT NOT NULL,
    tier TEXT NOT NULL,
    principal_type TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    principal_name TEXT NOT NULL,
    source TEXT NOT NULL,
    host_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    target_kind TEXT,
    target_id TEXT,
    target_name TEXT,
    detail TEXT,
    run TEXT,
    parent_id TEXT,
    ref TEXT,
    error_code TEXT,
    error_status INTEGER,
    coalesce_key TEXT,
    count INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX events_tier_ts ON events (tier, ts);
  CREATE INDEX events_target_name ON events (target_kind, target_name, seq);
  CREATE INDEX events_target_id ON events (target_kind, target_id, seq);
  CREATE INDEX events_principal ON events (principal_id, seq);
  CREATE INDEX events_op ON events (op, seq);
  CREATE INDEX events_run ON events (run, seq);
  CREATE INDEX events_coalesce ON events (coalesce_key, seq);
  `,
];

const COLUMNS = `seq, id, ts, duration_ms, status, op, kind, tier, principal_type, principal_id, principal_name,
  source, host_id, summary, target_kind, target_id, target_name, detail, run, parent_id, ref, error_code,
  error_status, count`;

interface Row {
  seq: number;
  id: string;
  ts: number;
  duration_ms: number;
  status: EventStatus;
  op: string;
  kind: StoredEvent["kind"];
  tier: Tier;
  principal_type: string;
  principal_id: string;
  principal_name: string;
  source: StoredEvent["source"];
  host_id: string;
  summary: string;
  target_kind: string | null;
  target_id: string | null;
  target_name: string | null;
  detail: string | null;
  run: string | null;
  parent_id: string | null;
  ref: string | null;
  error_code: string | null;
  error_status: number | null;
  count: number;
}

/** Operations whose events are activity: terminal session start, sends and close. */
const ACTIVITY_OPS: ReadonlySet<string> = new Set(["session.start", "session.send", "session.close"]);
/** Event families that are activity: exec, terminal attachments and container events from Docker. */
const ACTIVITY_PREFIXES = ["exec.", "terminal.", "container."] as const;

/**
 * Which tier an execution is recorded in. A refusal is always audit. Exec, terminal, session send and container events
 * are activity and are not merged. Other reads are activity; other writes, such as a takeover, are audit.
 */
export function tierOf(event: Pick<EventInput, "op" | "kind" | "status">): Tier {
  if (event.status === "denied") return "audit";
  if (ACTIVITY_OPS.has(event.op) || ACTIVITY_PREFIXES.some((prefix) => event.op.startsWith(prefix))) return "activity";
  return event.kind === "read" ? "activity" : "audit";
}

function detailJson(detail: unknown): string | null {
  if (detail === undefined) return null;
  const text = JSON.stringify(detail);
  if (text === undefined) return null;
  const bytes = Buffer.byteLength(text);
  return bytes <= DETAIL_MAX_BYTES ? text : JSON.stringify({ truncated: true, bytes });
}

/** Reads of one principal, operation and target with the same outcome share a row per minute. */
function coalesceKeyOf(event: EventInput): string {
  const target = event.target;
  const minute = Math.floor(event.ts / MINUTE_MS);
  return [
    event.principal.id,
    event.op,
    event.status,
    target?.kind ?? "",
    target?.id ?? target?.name ?? "",
    minute,
  ].join("\u0000");
}

function filterSql(filter: EventFilter): { sql: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.box !== undefined) {
    clauses.push("target_kind = 'box' AND (target_id = ? OR target_name = ?)");
    params.push(filter.box, filter.box);
  }
  if (filter.principal !== undefined) {
    clauses.push("principal_id = ?");
    params.push(filter.principal);
  }
  if (filter.op !== undefined) {
    clauses.push("op = ?");
    params.push(filter.op);
  }
  if (filter.status !== undefined) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  if (filter.run !== undefined) {
    clauses.push("run = ?");
    params.push(filter.run);
  }
  if (filter.since !== undefined) {
    clauses.push("ts >= ?");
    params.push(filter.since);
  }
  if (filter.visible) {
    const visible = visibleSql(filter.visible);
    clauses.push(visible.sql);
    params.push(...visible.params);
  }
  return { sql: clauses.map((clause) => ` AND ${clause}`).join(""), params };
}

/** `0` is a false condition, so an empty id list does not emit `IN ()`. */
function inList(column: string, values: readonly string[], params: (string | number)[]): string {
  if (values.length === 0) return "0";
  params.push(...values);
  return `${column} IN (${values.map(() => "?").join(", ")})`;
}

function visibleSql(visible: EventVisibility): { sql: string; params: (string | number)[] } {
  const params: (string | number)[] = [visible.principalId];
  let boxes: string;
  if (visible.boxes === null) {
    boxes = "target_kind = 'box'";
  } else {
    const ids = inList("target_id", visible.boxes.ids, params);
    const names = visible.boxes.names.map(({ name, since }) => {
      params.push(name, since);
      return "(target_name = ? AND ts >= ?)";
    });
    const byName = names.length === 0 ? "0" : names.join(" OR ");
    boxes = `target_kind = 'box' AND (${ids} OR ${byName})`;
  }
  const clauses = [`(principal_id = ? OR (${boxes}))`];
  if (visible.hosts !== null) clauses.push(inList("host_id", visible.hosts, params));
  return { sql: clauses.join(" AND "), params };
}

/** The same rule as `filterSql`, for events that have not been read back from the database. */
export function matchesFilter(event: StoredEvent, filter: EventFilter): boolean {
  if (filter.box !== undefined) {
    const target = event.target;
    if (target?.kind !== "box" || (target.id !== filter.box && target.name !== filter.box)) return false;
  }
  if (filter.principal !== undefined && event.principal.id !== filter.principal) return false;
  if (filter.op !== undefined && event.op !== filter.op) return false;
  if (filter.status !== undefined && event.status !== filter.status) return false;
  if (filter.run !== undefined && event.run !== filter.run) return false;
  if (filter.since !== undefined && event.ts < filter.since) return false;
  if (filter.visible && !matchesVisible(event, filter.visible)) return false;
  return true;
}

function matchesVisible(event: StoredEvent, visible: EventVisibility): boolean {
  const own = event.principal.id === visible.principalId;
  const target = event.target;
  let aboutBox = false;
  if (visible.boxes === null) {
    aboutBox = target?.kind === "box";
  } else if (target?.kind === "box") {
    aboutBox =
      (target.id !== undefined && visible.boxes.ids.includes(target.id)) ||
      visible.boxes.names.some((named) => named.name === target.name && event.ts >= named.since);
  }
  if (!own && !aboutBox) return false;
  return visible.hosts === null || visible.hosts.includes(event.hostId);
}

function toEvent(row: Row): StoredEvent {
  return {
    seq: row.seq,
    id: row.id,
    ts: row.ts,
    durationMs: row.duration_ms,
    status: row.status,
    op: row.op,
    kind: row.kind,
    tier: row.tier,
    count: row.count,
    principal: { type: row.principal_type, id: row.principal_id, name: row.principal_name },
    source: row.source,
    hostId: row.host_id,
    summary: row.summary,
    target:
      row.target_kind === null
        ? undefined
        : { kind: row.target_kind, id: row.target_id ?? undefined, name: row.target_name ?? "" },
    detail: row.detail === null ? undefined : (JSON.parse(row.detail) as unknown),
    run: row.run ?? undefined,
    parentId: row.parent_id ?? undefined,
    ref: row.ref === null ? undefined : (JSON.parse(row.ref) as StoredEvent["ref"]),
    error: row.error_code === null ? undefined : { code: row.error_code, status: row.error_status ?? 0 },
  };
}

/** The part of the store that operations may use to read the log. Writes happen only through the audit hook. */
export type EventReader = Pick<EventStore, "list">;

/**
 * The events database: one SQLite file in WAL mode. Every event is redacted before it is written, so secrets never
 * reach the file. Paging runs newest first by `seq`, which is also the cursor the event stream resumes from.
 */
export class EventStore {
  private readonly db: Database;

  constructor(
    path: string,
    private readonly redactor: Redactor,
  ) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  append(input: EventInput): AppendResult {
    const event = redactEvent(input, this.redactor);
    const tier = tierOf(event);
    const key = tier === "activity" && event.kind === "read" ? coalesceKeyOf(event) : null;
    return this.db.transaction((): AppendResult => {
      if (key !== null) {
        const earlier = this.db
          .query<{ seq: number }, [string]>("SELECT seq FROM events WHERE coalesce_key = ? ORDER BY seq DESC LIMIT 1")
          .get(key);
        if (earlier) {
          this.db.run("UPDATE events SET count = count + 1 WHERE seq = ?", [earlier.seq]);
          return { event: this.one(earlier.seq), merged: true };
        }
      }
      const inserted = this.db
        .query<{ seq: number }, (string | number | null)[]>(
          `INSERT INTO events (id, ts, duration_ms, status, op, kind, tier, principal_type, principal_id, principal_name,
            source, host_id, summary, target_kind, target_id, target_name, detail, run, parent_id, ref, error_code,
            error_status, coalesce_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING seq`,
        )
        .get(
          event.id,
          event.ts,
          event.durationMs,
          event.status,
          event.op,
          event.kind,
          tier,
          event.principal.type,
          event.principal.id,
          event.principal.name,
          event.source,
          event.hostId,
          event.summary,
          event.target?.kind ?? null,
          event.target?.id ?? null,
          event.target?.name ?? null,
          detailJson(event.detail),
          event.run ?? null,
          event.parentId ?? null,
          event.ref === undefined ? null : JSON.stringify(event.ref),
          event.error?.code ?? null,
          event.error?.status ?? null,
          key,
        );
      return { event: this.one(inserted?.seq ?? 0), merged: false };
    })();
  }

  /** The newest page of events matching the filter, older than `before` when it is given. */
  list(filter: EventFilter, options: { before?: number; limit: number }): EventPage {
    const scoped = filterSql(filter);
    const rows = this.db
      .query<Row, (string | number)[]>(
        `SELECT ${COLUMNS} FROM events WHERE seq < ?${scoped.sql} ORDER BY seq DESC LIMIT ?`,
      )
      .all(options.before ?? Number.MAX_SAFE_INTEGER, ...scoped.params, options.limit + 1);
    const page = rows.slice(0, options.limit).map(toEvent);
    const more = rows.length > options.limit;
    return { events: page, nextCursor: more ? (page.at(-1)?.seq ?? null) : null };
  }

  /** Up to `limit` events matching the filter after `seq`, oldest first. The stream replays from here. */
  after(seq: number, filter: EventFilter, limit: number): StoredEvent[] {
    const scoped = filterSql(filter);
    return this.db
      .query<Row, (string | number)[]>(
        `SELECT ${COLUMNS} FROM events WHERE seq > ?${scoped.sql} ORDER BY seq ASC LIMIT ?`,
      )
      .all(seq, ...scoped.params, limit)
      .map(toEvent);
  }

  /** The newest cursor in the store, or 0 when it is empty. */
  head(): number {
    return this.db.query<{ seq: number }, []>("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get()?.seq ?? 0;
  }

  /** Deletes events older than their tier's window and returns how many went. */
  prune(now: number, windows: PruneWindows): number {
    const audit = this.db.run("DELETE FROM events WHERE tier = 'audit' AND ts < ?", [now - windows.auditMs]);
    const activity = this.db.run("DELETE FROM events WHERE tier = 'activity' AND ts < ?", [now - windows.activityMs]);
    return audit.changes + activity.changes;
  }

  close(): void {
    this.db.close();
  }

  private one(seq: number): StoredEvent {
    const row = this.db.query<Row, [number]>(`SELECT ${COLUMNS} FROM events WHERE seq = ?`).get(seq);
    if (!row) throw new Error(`event ${seq} is missing`);
    return toEvent(row);
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
