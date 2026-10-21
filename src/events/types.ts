/** Which interface an operation call came through. `ui` is reserved for the console's own session (#2). */
export type Source = "ui" | "rest" | "mcp" | "cli" | "scheduler" | "system";

/** `started` is the first event of a long-running task, and of an exec that records again when it finishes. */
export type EventStatus = "started" | "ok" | "error" | "denied";

/** The object an event is about. `id` is absent while the object does not exist yet, as before a box is created. */
export interface EventTarget {
  readonly kind: string;
  readonly id?: string;
  readonly name: string;
}

export interface PrincipalRef {
  readonly type: string;
  readonly id: string;
  readonly name: string;
}

/** Links an event to what it produced. `taskId` is set for async operations. `execId` and `outputRef` are set for exec. */
export interface EventRefs {
  readonly execId?: string;
  readonly outputRef?: string;
  readonly taskId?: string;
}

/**
 * An extra audit event an operation records beside the one the executor writes for the call itself.
 * Exec uses this for start, finish and kill, which outlive the HTTP request when the command is in the background.
 */
export interface AuditNote {
  readonly op: string;
  readonly kind: EventInput["kind"];
  readonly status: EventStatus;
  readonly summary: string;
  readonly target?: EventTarget;
  readonly detail?: unknown;
  readonly ref?: EventRefs;
  readonly durationMs?: number;
  readonly error?: EventInput["error"];
}

/** One execution of an operation, as the executor hands it to the audit hook. */
export interface EventInput {
  readonly id: string;
  /** Epoch milliseconds at which the execution started. */
  readonly ts: number;
  readonly durationMs: number;
  readonly status: EventStatus;
  readonly op: string;
  readonly kind: "read" | "write" | "destructive";
  readonly principal: PrincipalRef;
  readonly source: Source;
  readonly hostId: string;
  readonly summary: string;
  readonly target?: EventTarget;
  readonly detail?: unknown;
  readonly run?: string;
  readonly parentId?: string;
  readonly ref?: EventRefs;
  readonly error?: { readonly code: string; readonly status: number };
}
