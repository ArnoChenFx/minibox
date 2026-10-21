import type { z } from "zod";

import type { Operation, OperationSpec } from "./types";
import { parseInput } from "./validation";

/** Erases the schema types of an operation definition, so that the registry can hold every operation in one list. */
export function defineOperation<I extends z.ZodObject, O extends z.ZodType, R = undefined>(
  spec: OperationSpec<I, O, R>,
): Operation {
  const { input, output, precondition, resolve, activity, audit, exclusive, run, ...meta } = spec;
  return {
    ...meta,
    input,
    output,
    parse: (raw) => parseInput(input, raw),
    precondition: precondition && ((ctx, value) => precondition(ctx, value as z.output<I>)),
    resolve: resolve && ((ctx, value) => resolve(ctx, value as z.output<I>)),
    activity: activity && {
      action: (value) => activity.action(value as z.output<I>),
      target: (value, resolved) => activity.target(value as z.output<I>, resolved as R),
    },
    audit: audit && {
      target:
        audit.target &&
        ((value, resolved, result) =>
          audit.target?.(value as z.output<I>, resolved as R | undefined, result as z.input<O> | undefined)),
      detail: audit.detail && ((value, resolved) => audit.detail?.(value as z.output<I>, resolved as R | undefined)),
      ref:
        audit.ref &&
        ((value, resolved, result) =>
          audit.ref?.(value as z.output<I>, resolved as R | undefined, result as z.input<O> | undefined)),
    },
    exclusive: exclusive && ((ctx, value, resolved) => exclusive(ctx, value as z.output<I>, resolved as R)),
    run: (ctx, value, resolved) => run(ctx, value as z.output<I>, resolved as R),
  };
}
