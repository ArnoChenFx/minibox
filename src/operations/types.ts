import type { z } from "zod";

import type { EventReader } from "../events/store";
import type { EventTarget, Source } from "../events/types";
import type { HostCtx } from "../host/registry";
import type { TokenGrants } from "../tokens/model";
import type { TokenStore } from "../tokens/store";

/** `read` never changes state, `write` changes it, `destructive` removes data that cannot be recovered. */
export type Kind = "read" | "write" | "destructive";

export type Toolset = "core" | "session" | "network" | "storage" | "tools" | "meta";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** The access key or a browser session. `id` is `owner` for both; other owner ids exist only in tests. */
export interface OwnerPrincipal {
  readonly type: "owner";
  readonly id: string;
  readonly name: string;
}

/** An agent API token. `grants` is the policy checked by the authorizer and the event filter. */
export interface TokenPrincipal {
  readonly type: "token";
  readonly id: string;
  readonly name: string;
  readonly grants: TokenGrants;
}

/**
 * Reserved for a token a box uses on itself (#13 defers issuing these). `id` is the box id.
 * Nothing in this process creates one.
 */
export interface BoxSelfPrincipal {
  readonly type: "box-self";
  readonly id: string;
  readonly name: string;
}

/** A call MiniBox makes itself, such as a future scheduler. Not issued to clients. */
export interface SystemPrincipal {
  readonly type: "system";
  readonly id: string;
  readonly name: string;
}

export type Principal = OwnerPrincipal | TokenPrincipal | BoxSelfPrincipal | SystemPrincipal;

export const OWNER: Principal = { type: "owner", id: "owner", name: "owner" };

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
}

/** How one HTTP route maps onto an operation. Path params fill the input key with the same name. */
export interface RestBinding {
  readonly method: HttpMethod;
  readonly path: string;
  readonly status?: 200 | 201;
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
  /** Creating a named object can fail with a 409 when the name is taken. */
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
  /** Structured detail to record. Never include file contents, and name environment variables without their values. */
  detail?(input: I, resolved: R | undefined): unknown;
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
    detail?(input: unknown, resolved: unknown): unknown;
  };
  run(ctx: OperationContext, input: unknown, resolved: unknown): Promise<unknown>;
}
