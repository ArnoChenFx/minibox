import { type ActivityLog, tracked } from "../activity";
import type { EventInput, EventStatus, EventTarget } from "../events/types";
import { ulid } from "../events/ulid";
import type { HostCtx } from "../host/registry";
import { AppError, toAppError } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import type { Operation, OperationContext, Principal } from "./types";

export interface AuthorizeRequest {
  readonly principal: Principal;
  readonly operation: Operation;
  readonly host?: HostCtx;
  /**
   * `scope` runs before validation and only checks who may call the operation.
   * `access` runs after the target is resolved, with the valid input, and checks the box, volumes, host and quotas.
   * A hook that ignores `phase` is consulted twice.
   */
  readonly phase?: "scope" | "access";
  readonly input?: Record<string, unknown>;
  readonly resolved?: unknown;
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

/** The phase-0 hook: any owner principal, and nobody else. Production uses `authorizeOperation` instead. */
export const ownerOnly = ({ principal }: AuthorizeRequest): boolean => principal.type === "owner";

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
  } else if (event.kind === "read") {
    log.debug("operation.ok", fields);
  } else {
    log.info("operation.ok", fields);
  }
}

export interface ExecutorDeps {
  readonly activity: ActivityLog;
  readonly hooks: ExecutorHooks;
}

/** What the executor knows when one execution ends. Fields the run never reached stay undefined. */
interface Outcome {
  readonly status: EventStatus;
  readonly input?: Record<string, unknown>;
  readonly resolved?: unknown;
  readonly result?: unknown;
  readonly error?: AppError;
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
  const detail = input === undefined ? undefined : audit?.detail ? audit.detail(input, resolved) : input;
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
    error: error && { code: error.code, status: error.status },
  };
}

/**
 * The single entry point for every operation: authorize the scope, validate, precondition, resolve, authorize the
 * resource and quotas, run, then audit. A 403 from the authorizer is recorded as denied.
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
    let denied = false;
    let input: Record<string, unknown> | undefined;
    let resolved: unknown;
    let result: unknown;
    try {
      if (!(await this.authorize(ctx, operation, "scope"))) {
        denied = true;
        throw new AppError(403, "forbidden", msg("operation_forbidden", { op: name }));
      }
      const parsed = operation.parse(raw);
      input = parsed;
      if (operation.precondition) await operation.precondition(ctx, parsed);
      resolved = operation.resolve ? await operation.resolve(ctx, parsed) : undefined;
      if (!(await this.authorize(ctx, operation, "access", parsed, resolved))) {
        denied = true;
        throw new AppError(403, "forbidden", msg("operation_forbidden", { op: name }));
      }
      result = await this.record(operation, parsed, resolved, () => operation.run(ctx, parsed, resolved));
    } catch (e) {
      const error = toAppError(e);
      if (error.status === 403) denied = true;
      const status: EventStatus = denied ? "denied" : "error";
      this.emit(eventOf(id, operation, ctx, started, { status, input, resolved, error }));
      throw e;
    }
    this.emit(eventOf(id, operation, ctx, started, { status: "ok", input, resolved, result }));
    return result;
  }

  private authorize(
    ctx: OperationContext,
    operation: Operation,
    phase: "scope" | "access",
    input?: Record<string, unknown>,
    resolved?: unknown,
  ): Promise<boolean> {
    return Promise.resolve(
      this.deps.hooks.authorize({ principal: ctx.principal, operation, host: ctx.host, phase, input, resolved }),
    );
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
    if (!operation.activity) return fn();
    return tracked(
      this.deps.activity,
      operation.activity.action(input),
      operation.activity.target(input, resolved),
      fn,
    );
  }
}
