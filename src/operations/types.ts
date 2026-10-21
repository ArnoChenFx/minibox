import type { z } from "zod";

import type { EventReader } from "../events/store";
import type { AuditNote, EventRefs, EventTarget, Source } from "../events/types";
import type { HostCtx } from "../host/registry";
import type { ExecService } from "../services/exec";
import type { TerminalService } from "../services/terminals";
import type { TaskHandle, TaskReader } from "../tasks/types";

/** `read` never changes state, `write` changes it, `destructive` removes data that cannot be recovered. */
export type Kind = "read" | "write" | "destructive";

export type Toolset = "core" | "session" | "network" | "storage" | "tools" | "meta" | "rebuild";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** Who is calling. Only the owner exists until scoped tokens (#13) add other principals. */
export interface Principal {
  readonly type: "owner";
  readonly id: string;
  readonly name: string;
}

export interface OperationContext {
  readonly host: HostCtx;
  readonly principal: Principal;
  readonly source: Source;
  /** Groups the audit events of one client session: `X-Minibox-Run` over REST, the MCP session id over MCP. */
  readonly run?: string;
  /** The event of the operation that started this one, when an operation triggers another. */
  readonly parentId?: string;
  /** The event log, for operations that read it. Adapters pass the app's store. */
  readonly events: EventReader;
  /** Set on the background run of an async operation, so the handler can log and watch for cancellation. */
  readonly task?: TaskHandle;
  /** The task manager. The executor fills it in; task operations read it. */
  readonly tasks?: TaskReader;
  /** Command exec. Present on REST, MCP and the CLI. */
  readonly execs?: ExecService;
  /** Terminal sessions (tmux in the box). Present on REST, MCP and the CLI. */
  readonly terminals?: TerminalService;
  /** Records an audit event parented to this operation. Exec uses it for start, finish and kill. */
  record?(note: AuditNote): void;
}

/** How one HTTP route maps onto an operation. Path params fill the input key with the same name. */
export interface RestBinding {
  readonly method: HttpMethod;
  readonly path: string;
  readonly status?: 200 | 201 | 202;
  /** Input keys read from the query string, one per parameter of the same name. */
  readonly query?: readonly string[];
  /** Whether a JSON object body is read into the input. */
  readonly body?: boolean;
  /** Input values the route supplies itself, so clients cannot send them. */
  readonly fixed?: Readonly<Record<string, string>>;
  /**
   * Read `If-Match` into `expectedRevision`, overwriting any value in the body.
   * The operation's input must have an `expectedRevision` field.
   */
  readonly ifMatch?: boolean;
}

export interface McpMetadata {
  readonly toolset: Toolset;
  readonly name: string;
  readonly description: string;
}

/** The descriptive part of an operation. The typed definition and the erased registry entry both carry it. */
export interface OperationMeta {
  readonly name: string;
  readonly tag: string;
  readonly summary: string;
  readonly kind: Kind;
  readonly scope: string;
  readonly async: boolean;
  /** Creating a box by name can fail with a 409 when the name is taken. */
  readonly conflicts?: boolean;
  readonly rest: readonly RestBinding[];
  readonly cli?: string;
  readonly mcp?: McpMetadata;
}

/**
 * How an operation appears in the event log. Both members are optional: without `target` an event has no object,
 * and without `detail` it records the validated input.
 */
export interface AuditSpec<I, O, R> {
  /** The object acted on. `resolved` is `undefined` when resolution failed or never ran; `result` only on success. */
  target?(input: I, resolved: R | undefined, result: O | undefined): EventTarget | undefined;
  /**
   * Structured detail to record. `result` is only set on success, so a refused call can say that nothing happened.
   * Never include file contents, and name environment variables without their values.
   */
  detail?(input: I, resolved: R | undefined, result: O | undefined): unknown;
  /** Links the event to an exec or its saved output. Set only when the call produced one. */
  ref?(input: I, resolved: R | undefined, result: O | undefined): EventRefs | undefined;
}

/** Everything the registry needs to know about one operation. Handlers only ever see validated input. */
export interface OperationSpec<I extends z.ZodObject, O extends z.ZodType, R> extends OperationMeta {
  readonly input: I;
  readonly output: O;
  /** Runs after validation and before the target is resolved, for example the host capacity check. */
  readonly precondition?: (ctx: OperationContext, input: z.output<I>) => Promise<void>;
  /** Finds the target, so that a missing one is a 404 before the handler runs. */
  readonly resolve?: (ctx: OperationContext, input: z.output<I>) => Promise<R>;
  /** Recorded in the activity feed while the handler runs. Reads leave it out. */
  readonly activity?: {
    action(input: z.output<I>): string;
    target(input: z.output<I>, resolved: R): string;
  };
  readonly audit?: AuditSpec<z.output<I>, z.input<O>, R>;
  /**
   * While a task with this key is running, another call is refused. Async operations use it as their single-instance
   * mutex. The key should use the resolved id, so a name and an id share one lock.
   */
  readonly exclusive?: (ctx: OperationContext, input: z.output<I>, resolved: R) => string | undefined;
  run(ctx: OperationContext, input: z.output<I>, resolved: R): Promise<z.input<O>>;
}

/** An operation with its schemas erased, so the registry can keep every operation in one list. */
export interface Operation extends OperationMeta {
  readonly input: z.ZodObject;
  readonly output: z.ZodType;
  parse(raw: unknown): Record<string, unknown>;
  precondition?(ctx: OperationContext, input: unknown): Promise<void>;
  resolve?(ctx: OperationContext, input: unknown): Promise<unknown>;
  activity?: {
    action(input: unknown): string;
    target(input: unknown, resolved: unknown): string;
  };
  audit?: {
    target?(input: unknown, resolved: unknown, result: unknown): EventTarget | undefined;
    detail?(input: unknown, resolved: unknown, result: unknown): unknown;
    ref?(input: unknown, resolved: unknown, result: unknown): EventRefs | undefined;
  };
  exclusive?(ctx: OperationContext, input: unknown, resolved: unknown): string | undefined;
  run(ctx: OperationContext, input: unknown, resolved: unknown): Promise<unknown>;
}
