import { z } from "zod";

import { scopedFilter } from "../events/scope";
import type { EventFilter } from "../events/store";
import type { EventStatus } from "../events/types";
import { msg } from "../lib/messages";
import { accept, type Checked, reject } from "../lib/validation";
import { specViews } from "../tokens/model";
import { defineOperation } from "./define";
import { EventPageSchema } from "./schemas";
import { field } from "./validation";

const STATUSES: readonly EventStatus[] = ["started", "ok", "error", "denied"];
const TEXT_MAX = 200;
const CONTROL = /\p{Cc}/u;
const SEQUENCE = /^[1-9]\d{0,14}$/;
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

export const EVENT_LIMIT = { default: 50, max: 200 } as const;

const absent = (value: unknown): value is undefined | null | "" =>
  value === undefined || value === null || value === "";

/** A sequence number from a query string or a header: a positive integer written in digits, or `undefined`. */
export function parseSequence(text: string): number | undefined {
  return SEQUENCE.test(text) ? Number(text) : undefined;
}

function sequenceOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
  return typeof value === "string" ? parseSequence(value) : undefined;
}

function checkText(value: unknown, name: string): Checked<string | undefined> {
  if (absent(value)) return accept(undefined);
  const text = typeof value === "string" ? value.trim() : undefined;
  if (text === undefined || text.length > TEXT_MAX || CONTROL.test(text)) {
    return reject(msg("event_filter_invalid", { field: name }), name);
  }
  return accept(text || undefined);
}

function checkStatus(value: unknown): Checked<EventStatus | undefined> {
  if (absent(value)) return accept(undefined);
  const status = STATUSES.find((candidate) => candidate === value);
  return status ? accept(status) : reject(msg("event_status_invalid"), "status");
}

function checkSince(value: unknown): Checked<number | undefined> {
  if (absent(value)) return accept(undefined);
  const text = typeof value === "string" ? value.trim() : "";
  const ms = DATE_PREFIX.test(text) ? Date.parse(text) : Number.NaN;
  return Number.isNaN(ms) ? reject(msg("event_since_invalid"), "since") : accept(ms);
}

function checkCursor(value: unknown): Checked<number | undefined> {
  if (absent(value)) return accept(undefined);
  const seq = sequenceOf(value);
  return seq === undefined ? reject(msg("event_cursor_invalid"), "cursor") : accept(seq);
}

function checkLimit(value: unknown): Checked<number> {
  if (absent(value)) return accept(EVENT_LIMIT.default);
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > EVENT_LIMIT.max) {
    return reject(msg("event_limit_range", { max: EVENT_LIMIT.max }), "limit");
  }
  return accept(n);
}

const text = (name: string, description: string) =>
  field((value) => checkText(value, name), { type: "string", maxLength: TEXT_MAX, description }).optional();

const filterShape = {
  box: text("box", "Box id or name. Matches the events about that box under either."),
  principal: text("principal", "Who made the call, such as owner."),
  op: text("op", "Operation name, such as box.create."),
  status: field(checkStatus, {
    type: "string",
    enum: [...STATUSES],
    description: "Outcome: started, ok, error or denied.",
  }).optional(),
  run: text("run", "Client session that made the call, as sent in X-Minibox-Run."),
  since: field(checkSince, {
    type: "string",
    format: "date-time",
    description: "Only events at or after this ISO 8601 time, such as 2026-10-20T00:00:00Z.",
  }).optional(),
};

/** The filters a client may ask for. The event stream takes these, and the list takes them with paging on top. */
export const eventFilterInput = z.object(filterShape);

export const eventsListInput = z.object({
  ...filterShape,
  cursor: field(checkCursor, {
    type: "integer",
    minimum: 1,
    description: "The nextCursor of the previous page. Omit it for the newest page.",
  }).optional(),
  limit: field(checkLimit, {
    type: "integer",
    minimum: 1,
    maximum: EVENT_LIMIT.max,
    description: `Events per page, between 1 and ${EVENT_LIMIT.max}. Defaults to ${EVENT_LIMIT.default}.`,
  }).default(EVENT_LIMIT.default),
});

/** The store filter for validated input. Paging and the stream's replay position are not part of it. */
export function filterOf(input: {
  box?: string;
  principal?: string;
  op?: string;
  status?: EventStatus;
  run?: string;
  since?: number;
}): EventFilter {
  return {
    box: input.box,
    principal: input.principal,
    op: input.op,
    status: input.status,
    run: input.run,
    since: input.since,
  };
}

export const eventList = defineOperation({
  name: "events.list",
  tag: "events",
  summary: "List recorded events, newest first",
  kind: "read",
  scope: "events:read",
  async: false,
  input: eventsListInput,
  output: EventPageSchema,
  rest: [
    {
      method: "GET",
      path: "/api/events",
      query: ["box", "principal", "op", "status", "run", "since", "cursor", "limit"],
    },
  ],
  run: async ({ events, principal, host }, input) =>
    events.list(scopedFilter(filterOf(input), principal, specViews(host.specs.list())), {
      before: input.cursor,
      limit: input.limit,
    }),
});

export const eventOperations = [eventList];
