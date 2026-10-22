import type { z } from "zod";

import type { EventReader } from "../events/store";
import type { AuditNote, EventRefs, EventTarget, Source } from "../events/types";
import type { HostManager } from "../host/manager";
import type { HostCtx } from "../host/registry";
import type { RawBody } from "../lib/body";
import type { ExecService } from "../services/exec";
import type { TerminalService } from "../services/terminals";
import type { TaskHandle, TaskReader } from "../tasks/types";
import type { BoxView, TokenGrants } from "../tokens/model";
import type { TokenStore } from "../tokens/store";

/** `read` never changes state, `write` changes it, `destructive` removes data that cannot be recovered. */
export type Kind = "read" | "write" | "destructive";

export type Toolset = "core" | "session" | "network" | "storage" | "tools" | "meta" | "rebuild" | "move";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** The access key, or a browser session. Every owner credential has the id `owner`. */
export interface OwnerPrincipal {
  readonly type: "owner";
  readonly id: string;
  readonly name: string;
}

/** An agent API token. `grants` is the policy the authorizer and the event filter check. */
export interface TokenPrincipal {
  readonly type: "token";
  readonly id: string;
  readonly name: string;
  readonly grants: TokenGrants;
}

/** Who is calling. A principal's id is what boxes, volumes, snapshots and tasks record as their creator. */
export type Principal = OwnerPrincipal | TokenPrincipal;

export const OWNER: OwnerPrincipal = { type: "owner", id: "owner", name: "owner" };

/**
 * A volume named in a volume scope check. `id` is the record's stable id and is absent for a name that has no record
 * yet, which a create or a mount of a new name passes.
 */
export interface VolumeResource {
  readonly kind: "volume";
  readonly id?: string;
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
  /** Agent API tokens. Token operations read and change this store. */
  readonly tokens: TokenStore;
  /** Every box view across the hosts, for visibility checks that must not miss a box on another host. */
  readonly boxViews?: () => readonly BoxView[];
  /** Every host, for an operation that acts on objects wherever they are. Without it, only `host` is known. */
  readonly allHosts?: () => readonly HostCtx[];
  /** Adds, tests and removes hosts. Only the host operations use it. */
  readonly hostAdmin?: HostManager;
  /** The base domain of subdomain previews, or null in path mode. Port operations build their preview links from it. */
  readonly previewBaseDomain?: string | null;
  /** Set on the background run of an async operation, so the handler can log and watch for cancellation. */
  readonly task?: TaskHandle;
  /** The task manager. The executor fills it in; task operations read it. */
  readonly tasks?: TaskReader;
  /** Command exec. Present on REST, MCP and the CLI. */
  readonly execs?: ExecService;
  /** Terminal sessions (tmux in the box). Present on REST, MCP and the CLI. */
  readonly terminals?: TerminalService;
  /** The raw body of a `raw` binding. Only the REST route sets it, and only for that binding. */
  readonly body?: RawBody;
  /** Records an audit event parented to this operation. Exec uses it for start, finish and kill. */
  record?(note: AuditNote): void;
  /**
   * Starts an async operation as a child task of this one, with input and resolved values the caller has already
   * checked. A sync operation uses it for a long step it must not make its caller wait for, and gets the task id back.
   */
  startTask?(operation: Operation, input: Record<string, unknown>, resolved: unknown): Promise<{ taskId: string }>;
  /**
   * Asks the authorize hook again for one scope and resource. The executor fills this in.
   * Absent in tests that call a service directly; those callers are already inside the process.
   */
  authorize?(request: { scope: string; resource?: VolumeResource }): boolean | Promise<boolean>;
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
  /**
   * The body is one raw file: `application/octet-stream` with a Content-Length. The bytes reach the operation as
   * `ctx.body`, unread until it runs, so a refused call never reads them. Mutually exclusive with `body`.
   */
  readonly raw?: boolean;
  /** The response is the byte stream the operation returns, sent unbuffered, instead of JSON. */
  readonly stream?: boolean;
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
  /** Can fail with a 409: a name that is taken, a busy object, or a change the caller must confirm first. */
  readonly conflicts?: boolean;
  /**
   * A sync operation that can outlast the server's idle timeout, such as a create that pulls its image. Its route
   * lifts the timer for that request, so the caller is not cut off while the engine works.
   */
  readonly longSync?: boolean;
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
  /**
   * Picks the host the operation runs on, from its validated input. Runs before `precondition`, so the capacity check,
   * the access check and the audit event all see that host. Without it, the operation runs on the request's host. It may
   * be async, as a placement that reads the hosts' engines is.
   */
  readonly hostFor?: (ctx: OperationContext, input: z.output<I>) => HostCtx | Promise<HostCtx>;
  /** Finds the target, so that a missing one is a 404 before the handler runs. */
  readonly resolve?: (ctx: OperationContext, input: z.output<I>) => Promise<R>;
  /**
   * Runs for an async operation after the access check and before its task starts. A refusal is the response to the
   * caller, not a failed task, so a confirmation that needs the target's preview can be answered at once.
   */
  readonly beforeTask?: (ctx: OperationContext, input: z.output<I>, resolved: R) => Promise<void>;
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
  /** The name an async operation acts on, such as a tool id or a snapshot name, shown in the task list. */
  readonly subject?: (input: z.output<I>, resolved: R) => string | undefined;
  run(ctx: OperationContext, input: z.output<I>, resolved: R): Promise<z.input<O>>;
}

/** An operation with its schemas erased, so the registry can keep every operation in one list. */
export interface Operation extends OperationMeta {
  readonly input: z.ZodObject;
  readonly output: z.ZodType;
  parse(raw: unknown): Record<string, unknown>;
  precondition?(ctx: OperationContext, input: unknown): Promise<void>;
  hostFor?(ctx: OperationContext, input: unknown): HostCtx | Promise<HostCtx>;
  resolve?(ctx: OperationContext, input: unknown): Promise<unknown>;
  beforeTask?(ctx: OperationContext, input: unknown, resolved: unknown): Promise<void>;
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
  subject?(input: unknown, resolved: unknown): string | undefined;
  run(ctx: OperationContext, input: unknown, resolved: unknown): Promise<unknown>;
}
