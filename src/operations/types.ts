import type { z } from "zod";

import type { HostCtx } from "../host/registry";

/** `read` never changes state, `write` changes it, `destructive` removes data that cannot be recovered. */
export type Kind = "read" | "write" | "destructive";

export type Toolset = "core" | "session" | "network" | "storage" | "tools" | "meta";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** Who is calling. Only the owner exists until scoped tokens (#13) add other principals. */
export interface Principal {
  readonly type: "owner";
}

export interface OperationContext {
  readonly host: HostCtx;
  readonly principal: Principal;
  /** Groups the audit events of one client session: `X-Minibox-Run` over REST, the MCP session id over MCP. */
  readonly run?: string;
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
  run(ctx: OperationContext, input: unknown, resolved: unknown): Promise<unknown>;
}
