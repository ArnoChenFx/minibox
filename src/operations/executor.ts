import { type ActivityLog, tracked } from "../activity";
import { AppError, toAppError } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import type { Kind, Operation, OperationContext, Principal } from "./types";

export interface AuthorizeRequest {
  readonly principal: Principal;
  readonly operation: Operation;
}

export interface AuditEvent {
  readonly operation: string;
  readonly kind: Kind;
  readonly principal: Principal["type"];
  readonly run?: string;
  readonly outcome: "ok" | "denied" | "failed";
  readonly code?: string;
  readonly status?: number;
}

/** The two hooks the executor calls. Replacing them changes who may act and what is recorded, never the operations. */
export interface ExecutorHooks {
  /** A `false` answer is a 403 and is audited as denied. */
  authorize(request: AuthorizeRequest): boolean | Promise<boolean>;
  /** Called once per execution, including refusals and failures. Must not throw. */
  audit(event: AuditEvent): void;
}

export const ownerOnly = ({ principal }: AuthorizeRequest): boolean => principal.type === "owner";

export function logAudit(event: AuditEvent): void {
  const fields = { ...event };
  if (event.outcome === "denied") {
    log.warn("operation.denied", fields);
  } else if (event.outcome === "failed") {
    if ((event.status ?? 0) >= 500) log.error("operation.failed", fields);
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

/** The single entry point for every operation: authorize, validate, precondition, resolve, run, then audit. */
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
    const event = { operation: name, kind: operation.kind, principal: ctx.principal.type, run: ctx.run };
    let denied = false;
    try {
      if (!(await this.deps.hooks.authorize({ principal: ctx.principal, operation }))) {
        denied = true;
        throw new AppError(403, "forbidden", msg("operation_forbidden", { op: name }));
      }
      const input = operation.parse(raw);
      if (operation.precondition) await operation.precondition(ctx, input);
      const resolved = operation.resolve ? await operation.resolve(ctx, input) : undefined;
      const result = await this.record(operation, input, resolved, () => operation.run(ctx, input, resolved));
      this.deps.hooks.audit({ ...event, outcome: "ok" });
      return result;
    } catch (e) {
      const error = toAppError(e);
      this.deps.hooks.audit({
        ...event,
        outcome: denied ? "denied" : "failed",
        code: error.code,
        status: error.status,
      });
      throw e;
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
