import { type ActivityLog, tracked } from "../activity";
import type { BackupScheduleStore } from "../backup/schedule-store";
import type { AuditNote, EventInput, EventRefs, EventStatus, EventTarget } from "../events/types";
import { ulid } from "../events/ulid";
import type { HostManager } from "../host/manager";
import type { HostCtx } from "../host/registry";
import { isAbortError } from "../lib/abort";
import { AppError, toAppError } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import type { Notifications } from "../notify/service";
import type { BackupService } from "../services/backup";
import type { TargetService } from "../services/targets";
import type { SshKeyStore } from "../ssh/keys";
import type { TaskManager } from "../tasks/manager";
import type { TaskError, TaskHandle } from "../tasks/types";
import { allBoxViews, specViews } from "../tokens/model";
import type { Operation, OperationContext, Principal, VolumeResource } from "./types";

export interface AuthorizeRequest {
  readonly principal: Principal;
  readonly operation: Operation;
  /** Set when an operation asks about one scope, such as `volume:attach`. Absent on the operation-level check. */
  readonly scope?: string;
  /** The volume the scope applies to, when the check is per volume. */
  readonly resource?: VolumeResource;
  /**
   * `scope` runs before validation and checks only who may call the operation. `access` runs after the target is
   * resolved, with the valid input, and checks the box, volumes, host, profile and quotas. `resource` is asked by a
   * service about one scope and volume while it runs, and answers with a boolean. A hook must handle every phase.
   */
  readonly phase?: "scope" | "access" | "resource";
  readonly host?: HostCtx;
  readonly input?: Record<string, unknown>;
  readonly resolved?: unknown;
}

/** Thrown by a handler when a later authorize() answer is false. The executor audits it as denied. */
export class AuthorizationDenied extends Error {
  constructor(readonly response: AppError) {
    super(response.message);
    this.name = "AuthorizationDenied";
  }
}

/** One execution of an operation, as the audit hook receives it. Every execution yields exactly one. */
export type AuditEvent = EventInput;

/** The two hooks the executor calls. Replacing them changes who may act and what is recorded, never the operations. */
export interface ExecutorHooks {
  /** A `false` answer is a 403 and is audited as denied. */
  authorize(request: AuthorizeRequest): boolean | Promise<boolean>;
  /** Called once per execution, including refusals and failures. */
  audit(event: AuditEvent): void;
}

export function logAudit(event: AuditEvent): void {
  const fields = {
    event: event.id,
    operation: event.op,
    kind: event.kind,
    principal: event.principal.id,
    run: event.run,
    status: event.status,
    durationMs: event.durationMs,
    code: event.error?.code,
    httpStatus: event.error?.status,
  };
  if (event.status === "denied") {
    log.warn("operation.denied", fields);
  } else if (event.status === "error") {
    if ((event.error?.status ?? 0) >= 500) log.error("operation.failed", fields);
    else log.info("operation.failed", fields);
  } else if (event.status === "started") {
    log.info("operation.started", fields);
  } else if (event.kind === "read") {
    log.debug("operation.ok", fields);
  } else {
    log.info("operation.ok", fields);
  }
}

export interface ExecutorDeps {
  readonly activity: ActivityLog;
  readonly hooks: ExecutorHooks;
  /** Required for operations marked async. Synchronous operations never touch it. */
  readonly tasks?: TaskManager;
  /** Every host, so `boxViews` and `allHosts` cover boxes on all of them. Without it, only the request's host counts. */
  readonly hosts?: { list(): readonly HostCtx[] };
  /** Adds, tests and removes hosts. Host operations read it from the context. */
  readonly hostAdmin?: HostManager;
  /** The base domain of subdomain previews, or null in path mode. */
  readonly previewBaseDomain?: string | null;
  /** Notification channels. Notify operations read it from the context. */
  readonly notify?: Notifications;
  /** Backups of DATA_DIR. Backup operations read it from the context. */
  readonly backups?: BackupService;
  /** The one backup schedule of this instance. Its operations read it from the context. */
  readonly backupSchedule?: BackupScheduleStore;
  /** Off-site targets. Target operations read it from the context. */
  readonly targets?: TargetService;
  /** The owner's SSH keys. SSH key operations read it from the context. */
  readonly sshKeys?: SshKeyStore;
}

/** What the executor knows when one execution ends. Fields the run never reached stay undefined. */
interface Outcome {
  readonly status: EventStatus;
  readonly input?: Record<string, unknown>;
  readonly resolved?: unknown;
  readonly result?: unknown;
  readonly error?: AppError;
  readonly ref?: EventRefs;
}

const cancelledTask = () => new AppError(409, "conflict", msg("task_cancelled"));

function taskErrorOf(error: AppError): TaskError {
  return {
    code: "cancelled",
    message: error.message,
    status: error.status,
    key: error.key,
    params: error.params,
  };
}

function summaryOf(operation: Operation, target: EventTarget | undefined): string {
  return target ? `${operation.summary}: ${target.name}` : operation.summary;
}

function eventOf(
  id: string,
  operation: Operation,
  ctx: OperationContext,
  started: { ts: number; at: number },
  outcome: Outcome,
): AuditEvent {
  const { input, resolved, result, error } = outcome;
  const audit = operation.audit;
  const target = input === undefined ? undefined : audit?.target?.(input, resolved, result);
  const detail = input === undefined ? undefined : audit?.detail ? audit.detail(input, resolved, result) : input;
  const fromAudit = input === undefined ? undefined : audit?.ref?.(input, resolved, result);
  const ref = fromAudit || outcome.ref ? { ...fromAudit, ...outcome.ref } : undefined;
  return {
    id,
    ts: started.ts,
    durationMs: Math.max(0, Math.round(performance.now() - started.at)),
    status: outcome.status,
    op: operation.name,
    kind: operation.kind,
    principal: ctx.principal,
    source: ctx.source,
    hostId: ctx.host.host.id,
    summary: summaryOf(operation, target),
    target,
    detail,
    run: ctx.run,
    parentId: ctx.parentId,
    ref,
    error: error && { code: error.code, status: error.status },
  };
}

/**
 * The single entry point for every operation: authorize the scope, validate, precondition, resolve, authorize the
 * access, run, then audit. A refusal from either authorize call is recorded as denied.
 */
export class Executor {
  private readonly byName: ReadonlyMap<string, Operation>;

  constructor(
    operations: readonly Operation[],
    private readonly deps: ExecutorDeps,
  ) {
    this.byName = new Map(operations.map((operation) => [operation.name, operation]));
    if (this.byName.size !== operations.length) throw new Error("operation names must be unique");
  }

  async run(name: string, ctx: OperationContext, raw: unknown): Promise<unknown> {
    const operation = this.byName.get(name);
    if (!operation) throw new Error(`unknown operation: ${name}`);
    const started = { ts: Date.now(), at: performance.now() };
    const id = ulid(started.ts);
    const hosts = this.deps.hosts;
    let bound: OperationContext = {
      ...ctx,
      tasks: ctx.tasks ?? this.deps.tasks,
      hostAdmin: ctx.hostAdmin ?? this.deps.hostAdmin,
      previewBaseDomain: ctx.previewBaseDomain ?? this.deps.previewBaseDomain ?? null,
      notify: ctx.notify ?? this.deps.notify,
      backups: ctx.backups ?? this.deps.backups,
      backupSchedule: ctx.backupSchedule ?? this.deps.backupSchedule,
      targets: ctx.targets ?? this.deps.targets,
      sshKeys: ctx.sshKeys ?? this.deps.sshKeys,
      recordActivity: (entry) => this.deps.activity.add(entry),
      boxViews: ctx.boxViews ?? (() => (hosts ? allBoxViews(hosts.list()) : specViews(ctx.host.specs.list()))),
      allHosts: ctx.allHosts ?? (() => (hosts ? hosts.list() : [ctx.host])),
      startTask: (child, childInput, childResolved) => {
        const childStarted = { ts: Date.now(), at: performance.now() };
        return this.startAsync(
          child,
          { ...bound, parentId: id },
          childInput,
          childResolved,
          childStarted,
          ulid(childStarted.ts),
        );
      },
      authorize: (request) =>
        this.deps.hooks.authorize({
          principal: ctx.principal,
          operation,
          phase: "resource",
          host: bound.host,
          scope: request.scope,
          resource: request.resource,
        }),
    };
    let denied = false;
    let input: Record<string, unknown> | undefined;
    let resolved: unknown;
    let result: unknown;
    try {
      if (!(await this.deps.hooks.authorize({ principal: bound.principal, operation, phase: "scope" }))) {
        denied = true;
        throw new AppError(403, "forbidden", msg("operation_forbidden", { op: name }));
      }
      const parsed = operation.parse(raw);
      input = parsed;
      if (operation.hostFor) bound = { ...bound, host: await operation.hostFor(bound, parsed) };
      if (operation.precondition) await operation.precondition(bound, parsed);
      resolved = operation.resolve ? await operation.resolve(bound, parsed) : undefined;
      const access = { principal: bound.principal, operation, phase: "access" as const, host: bound.host };
      if (!(await this.deps.hooks.authorize({ ...access, input: parsed, resolved }))) {
        denied = true;
        throw new AppError(403, "forbidden", msg("operation_forbidden", { op: name }));
      }
      if (operation.async) {
        await operation.beforeTask?.(bound, parsed, resolved);
        return await this.startAsync(operation, bound, parsed, resolved, started, id);
      }
      const recording: OperationContext = { ...bound, record: (note) => this.recordNote(bound, id, note) };
      result = await this.record(operation, parsed, resolved, () => operation.run(recording, parsed, resolved));
    } catch (e) {
      const refusal = e instanceof AuthorizationDenied;
      const error = refusal ? e.response : toAppError(e);
      // A 403 is a refusal whoever raised it: the authorize hook, or an operation's own rule such as the
      // strict profile.
      const status: EventStatus = denied || refusal || error.status === 403 ? "denied" : "error";
      this.emit(eventOf(id, operation, bound, started, { status, input, resolved, error }));
      if (refusal) throw e.response;
      throw e;
    }
    this.emit(eventOf(id, operation, bound, started, { status: "ok", input, resolved, result }));
    return result;
  }

  /**
   * Records a short `started` event and returns `{ taskId }` before the work runs. The background run emits exactly
   * one terminal event. Validation and a busy mutex still fail in the request, with no task left behind.
   */
  private async startAsync(
    operation: Operation,
    ctx: OperationContext,
    input: Record<string, unknown>,
    resolved: unknown,
    started: { ts: number; at: number },
    id: string,
  ): Promise<{ taskId: string }> {
    const tasks = this.deps.tasks;
    if (!tasks) throw new Error(`async operation ${operation.name} requires a task manager`);
    const target = operation.audit?.target?.(input, resolved, undefined);
    const begun = tasks.begin({
      op: operation.name,
      summary: summaryOf(operation, target),
      subject: operation.subject?.(input, resolved),
      hostId: ctx.host.host.id,
      target,
      principal: ctx.principal,
      source: ctx.source,
      run: ctx.run,
      parentId: ctx.parentId,
      exclusiveKey: operation.exclusive?.(ctx, input, resolved),
      queue: operation.queue,
    });
    // The same request repeated while the first is queued or running joins that task instead of doing the work twice.
    if (begun.duplicate) return { taskId: begun.id };
    this.emit(eventOf(id, operation, ctx, started, { status: "started", input, resolved, ref: { taskId: begun.id } }));
    tasks.track(begun.id, this.finishAsync(operation, ctx, input, resolved, started, id, begun.handle));
    return { taskId: begun.id };
  }

  /** Runs the handler and records the terminal audit event and the activity entry. */
  private async finishAsync(
    operation: Operation,
    ctx: OperationContext,
    input: Record<string, unknown>,
    resolved: unknown,
    started: { ts: number; at: number },
    startedId: string,
    handle: TaskHandle,
  ): Promise<void> {
    const tasks = this.deps.tasks;
    if (!tasks) return;
    const child: OperationContext = { ...ctx, parentId: startedId, task: handle };
    const running: OperationContext = { ...child, record: (note) => this.recordNote(child, startedId, note) };
    const ref = { taskId: handle.id };
    const emitFinal = (outcome: Outcome) => {
      this.emit(eventOf(ulid(), operation, child, started, { ...outcome, ref }));
    };
    try {
      if (tasks.get(handle.id, { output: false })?.status === "queued") await tasks.turn(handle.id);
      const result = operation.output.parse(await operation.run(running, input, resolved));
      if (tasks.finish(handle.id, { status: "succeeded", result })) {
        this.note(operation, input, resolved, true);
        emitFinal({ status: "ok", input, resolved, result });
        return;
      }
      if (tasks.get(handle.id, { output: false })?.status === "cancelled") {
        const error = cancelledTask();
        this.note(operation, input, resolved, false, error.message);
        emitFinal({ status: "error", input, resolved, error });
      }
    } catch (e) {
      if (isAbortError(e) || handle.signal.aborted) {
        const error = cancelledTask();
        const stored = taskErrorOf(error);
        const won = tasks.finish(handle.id, { status: "cancelled", error: stored });
        const status = tasks.get(handle.id, { output: false })?.status;
        if (won || status === "cancelled") {
          this.note(operation, input, resolved, false, error.message);
          emitFinal({ status: "error", input, resolved, error });
        }
        return;
      }
      const error = e instanceof AuthorizationDenied ? e.response : toAppError(e);
      if (
        tasks.finish(handle.id, {
          status: "failed",
          error: {
            code: error.code,
            message: error.message,
            status: error.status,
            key: error.key,
            params: error.params,
          },
        })
      ) {
        this.note(operation, input, resolved, false, error.message);
        emitFinal({ status: "error", input, resolved, error });
        return;
      }
      if (tasks.get(handle.id, { output: false })?.status === "cancelled") {
        const abort = cancelledTask();
        this.note(operation, input, resolved, false, abort.message);
        emitFinal({ status: "error", input, resolved, error: abort });
      }
    }
  }

  /** The activity feed hears an async operation when it finishes, not when the 202 is returned. */
  private note(operation: Operation, input: unknown, resolved: unknown, ok: boolean, message?: string): void {
    if (!operation.activity || operation.activity.when?.(input) === false) return;
    this.deps.activity.add({
      action: operation.activity.action(input),
      target: operation.activity.target(input, resolved),
      ok,
      ...(message === undefined ? {} : { message }),
    });
  }

  /** An extra event parented to the operation that is running. Exec start, finish and kill use this. */
  private recordNote(ctx: OperationContext, parentId: string, note: AuditNote): void {
    const ts = Date.now();
    this.emit({
      id: ulid(ts),
      ts,
      durationMs: note.durationMs ?? 0,
      status: note.status,
      op: note.op,
      kind: note.kind,
      principal: ctx.principal,
      source: ctx.source,
      hostId: ctx.host.host.id,
      summary: note.summary,
      target: note.target,
      detail: note.detail,
      run: ctx.run,
      parentId,
      ref: note.ref,
      error: note.error,
    });
  }

  private emit(event: AuditEvent): void {
    try {
      this.deps.hooks.audit(event);
    } catch (e) {
      log.error("audit.failed", { event: event.id, operation: event.op, error: String(e) });
    }
  }

  /** Writes the activity feed entry for operations that declare one. Failures in the handler are recorded there too. */
  private record(
    operation: Operation,
    input: unknown,
    resolved: unknown,
    fn: () => Promise<unknown>,
  ): Promise<unknown> {
    if (!operation.activity || operation.activity.when?.(input) === false) return fn();
    return tracked(
      this.deps.activity,
      operation.activity.action(input),
      operation.activity.target(input, resolved),
      fn,
    );
  }
}
