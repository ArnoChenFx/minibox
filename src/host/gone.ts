import { AppError } from "../lib/errors";
import { msg } from "../lib/messages";

/**
 * The refusal a store gives a write for a host that was removed while the caller was working. The record is not written:
 * a late write would bring back a record of a host that MiniBox no longer holds, which nothing could then remove.
 */
export const hostGone = (hostId: string): AppError => new AppError(409, "conflict", msg("host_gone", { host: hostId }));
