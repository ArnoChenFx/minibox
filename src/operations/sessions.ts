import { z } from "zod";

import { AppError } from "../lib/errors";
import { msg } from "../lib/messages";
import { accept, type Checked, reject } from "../lib/validation";
import { getBox, readBox } from "../services/boxes";
import { READ_LINES_MAX, SESSIONS_PER_BOX_MAX, type TerminalService } from "../services/terminals";
import { isKeyName, isSessionName, SESSION_NAME_RE } from "../tmux/format";
import { boxTarget } from "./boxes";
import { defineOperation } from "./define";
import { addFailure, boxId, field } from "./validation";

const NAME_MAX = 32;
const KEYS_MAX = 32;
const TEXT_MAX = 16 * 1024;
const LINES_DEFAULT = 100;
const CURSOR_RE = /^[0-9a-f]{12}\.[1-9]\d{0,14}$/;

const START_DESCRIPTION = `Start a named tmux session in a box, or return the one that already exists. A stopped box is started first, which sets its desired state to running and raises its revision. The session keeps running after the caller disconnects, and it ends when the box stops. A session started through the API has origin agent. The console opens an agent session read-only, and a person can take it over. The result has created false when the session already existed, and woke true when this call started the box. A box holds at most ${SESSIONS_PER_BOX_MAX} sessions: past that, the call fails with too_many_requests until one is closed. Use session_read and session_send with it. Use exec for one-off commands.`;

const SEND_DESCRIPTION = `Send keys or text to a session. Pass keys, a list of tmux key names such as Enter, Tab, Escape, BSpace, Up, C-c or M-x, or pass text, which is typed literally up to 16 KiB, and a newline in it is read by the shell as Enter. Pass exactly one of them. If a person has taken the session over, the call fails with code taken_over and retryable true: wait a little, read the session with session_read, and send again. Reads still work during a takeover. The result counts the keys and bytes sent. The input itself is not written to the audit log, only the counts.`;

const READ_DESCRIPTION = `Read a session. Without since, returns the last lines lines of the screen and its history, 100 by default and at most 2000. Pass since with the cursor the previous read of this session returned to get only the lines that are new. When the session changed in a way that cannot be continued, reset is true and lines is the current window. truncated is true when more lines exist than were returned. controller says whether the agent or a person is driving the session right now. Always pass the newest cursor to the next read.`;

function checkSessionName(value: unknown): Checked<string> {
  if (typeof value !== "string" || !isSessionName(value)) return reject(msg("session_name_invalid"), "name");
  return accept(value);
}

function sessionName() {
  return field(checkSessionName, {
    type: "string",
    minLength: 1,
    maxLength: NAME_MAX,
    pattern: SESSION_NAME_RE.source,
    description:
      "Session name: a letter or digit first, then letters, digits, dashes and underscores, at most 32 characters.",
  });
}

function checkKeys(value: unknown): Checked<string[] | undefined> {
  if (value === undefined || value === null) return accept(undefined);
  if (!Array.isArray(value) || value.length === 0 || value.length > KEYS_MAX) {
    return reject(msg("session_keys_invalid", { max: KEYS_MAX }), "keys");
  }
  const keys: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isKeyName(item)) {
      return reject(msg("session_keys_invalid", { max: KEYS_MAX }), "keys");
    }
    keys.push(item);
  }
  return accept(keys);
}

function checkText(value: unknown): Checked<string | undefined> {
  if (value === undefined || value === null || value === "") return accept(undefined);
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > TEXT_MAX) {
    return reject(msg("session_text_invalid", { max: TEXT_MAX }), "text");
  }
  return accept(value);
}

function checkLines(value: unknown): Checked<number> {
  if (value === undefined || value === null || value === "") return accept(LINES_DEFAULT);
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > READ_LINES_MAX) {
    return reject(msg("session_lines_range", { max: READ_LINES_MAX }), "lines");
  }
  return accept(n);
}

function checkSince(value: unknown): Checked<string | undefined> {
  if (value === undefined || value === null || value === "") return accept(undefined);
  if (typeof value !== "string" || !CURSOR_RE.test(value)) return reject(msg("session_since_invalid"), "since");
  return accept(value);
}

const Actor = z.enum(["agent", "human"]);

const SessionSchema = z.object({
  name: z.string(),
  origin: Actor.describe("Who created the session: agent through the API, or human from the console."),
  controller: Actor.describe("Who may type into it now. A takeover makes it human until it is released."),
  takenOver: z.boolean().describe("True while a person has taken the session over from the agent."),
});

const ListedSchema = SessionSchema.extend({
  createdAt: z.string().describe("When the session was created, as an ISO 8601 time."),
  attached: z.number().int().describe("Terminals attached to the session right now."),
});

const StartOutput = z.object({
  session: SessionSchema,
  created: z.boolean(),
  woke: z.boolean(),
});

const ReadOutput = z.object({
  session: z.string(),
  cursor: z.string().describe("Pass this as since to the next read of the session."),
  reset: z.boolean(),
  truncated: z.boolean(),
  lines: z.array(z.string()),
  controller: Actor,
});

const SendOutput = z.object({
  session: z.string(),
  keys: z.number().int(),
  bytes: z.number().int(),
});

function requireTerminals(terminals: TerminalService | undefined): asserts terminals is TerminalService {
  if (!terminals) throw new AppError(500, "internal", "terminal service is not configured");
}

export const sessionList = defineOperation({
  name: "session.list",
  tag: "sessions",
  summary: "List the terminal sessions of a box",
  kind: "read",
  scope: "box:session",
  async: false,
  input: z.object({ id: boxId() }),
  output: z.object({ sessions: z.array(ListedSchema) }),
  rest: [{ method: "GET", path: "/api/boxes/:id/sessions" }],
  cli: "session ls",
  resolve: ({ host }, input) => readBox(host, input.id),
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host, terminals }, _input, box) => {
    requireTerminals(terminals);
    const sessions = await terminals.list(host, box);
    return {
      sessions: sessions.map((session) => ({
        name: session.name,
        origin: session.origin,
        controller: session.controller,
        takenOver: session.takenOver,
        createdAt: new Date(session.createdAt).toISOString(),
        attached: session.attached,
      })),
    };
  },
});

export const sessionStart = defineOperation({
  name: "session.start",
  tag: "sessions",
  summary: "Start a terminal session in a box",
  kind: "write",
  scope: "box:session",
  async: false,
  input: z.object({ id: boxId(), name: sessionName() }),
  output: StartOutput,
  rest: [{ method: "POST", path: "/api/boxes/:id/sessions", body: true }],
  cli: "session start",
  mcp: { toolset: "session", name: "session_start", description: START_DESCRIPTION },
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: () => "session.start", target: (_input, box) => box.name },
  audit: {
    target: (_input, box) => box && boxTarget(box),
    detail: (input) => ({ session: input.name }),
  },
  run: async ({ host, source, terminals, record }, input, box) => {
    requireTerminals(terminals);
    return terminals.start(host, box, input.name, source, record);
  },
});

export const sessionRead = defineOperation({
  name: "session.read",
  tag: "sessions",
  summary: "Read a terminal session",
  kind: "read",
  scope: "box:session",
  async: false,
  input: z.object({
    id: boxId(),
    name: sessionName(),
    lines: field(checkLines, {
      type: "integer",
      minimum: 1,
      maximum: READ_LINES_MAX,
      description: `Lines to return from the end of the window, between 1 and ${READ_LINES_MAX}. Defaults to ${LINES_DEFAULT}.`,
    }).default(LINES_DEFAULT),
    since: field(checkSince, {
      type: "string",
      pattern: CURSOR_RE.source,
      description: "The cursor the previous read of this session returned. Omit it to read the current window.",
    }).optional(),
  }),
  output: ReadOutput,
  rest: [{ method: "GET", path: "/api/boxes/:id/sessions/:name", query: ["lines", "since"] }],
  cli: "session read",
  mcp: { toolset: "session", name: "session_read", description: READ_DESCRIPTION },
  resolve: ({ host }, input) => getBox(host, input.id),
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host, terminals }, input, box) => {
    requireTerminals(terminals);
    return terminals.read(host, box, input.name, { lines: input.lines, since: input.since });
  },
});

export const sessionSend = defineOperation({
  name: "session.send",
  tag: "sessions",
  summary: "Send keys or text to a terminal session",
  kind: "write",
  scope: "box:session",
  async: false,
  conflicts: true,
  input: z
    .object({
      id: boxId(),
      name: sessionName(),
      keys: field(checkKeys, {
        type: "array",
        maxItems: KEYS_MAX,
        items: { type: "string" },
        description:
          "tmux key names, in order: Enter, Tab, BTab, Escape, Space, BSpace, DC, Up, Down, Left, Right, Home, End, PPage, NPage, F1 to F12, a single character, or a modifier prefix such as C-, M- or S-. Use text for literal input. Send exactly one of keys or text.",
      }).optional(),
      text: field(checkText, {
        type: "string",
        maxLength: TEXT_MAX,
        description:
          "Literal text, typed as UTF-8 bytes, up to 16 KiB. A newline ends the line in the shell. Send exactly one of keys or text.",
      }).optional(),
    })
    .superRefine((input, ctx) => {
      if ((input.keys === undefined) === (input.text === undefined)) {
        addFailure(ctx, { message: msg("session_input_required"), field: "keys" });
      }
    }),
  output: SendOutput,
  rest: [{ method: "POST", path: "/api/boxes/:id/sessions/:name/input", body: true }],
  cli: "session send",
  mcp: { toolset: "session", name: "session_send", description: SEND_DESCRIPTION },
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: () => "session.send", target: (_input, box) => box.name },
  audit: {
    target: (_input, box) => box && boxTarget(box),
    detail: (input, _resolved, sent) => ({
      session: input.name,
      keys: sent?.keys ?? 0,
      bytes: sent?.bytes ?? 0,
    }),
  },
  run: async ({ host, terminals }, input, box) => {
    requireTerminals(terminals);
    const sent = await terminals.send(host, box, input.name, { keys: input.keys, text: input.text });
    return { session: input.name, keys: sent.keys, bytes: sent.bytes };
  },
});

export const sessionClose = defineOperation({
  name: "session.close",
  tag: "sessions",
  summary: "Close a terminal session",
  kind: "write",
  scope: "box:session",
  async: false,
  conflicts: true,
  input: z.object({ id: boxId(), name: sessionName() }),
  output: z.object({ session: z.string(), status: z.literal("closed") }),
  rest: [{ method: "DELETE", path: "/api/boxes/:id/sessions/:name" }],
  cli: "session close",
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: () => "session.close", target: (_input, box) => box.name },
  audit: {
    target: (_input, box) => box && boxTarget(box),
    detail: (input) => ({ session: input.name }),
  },
  run: async ({ host, source, terminals }, input, box) => {
    requireTerminals(terminals);
    await terminals.close(host, box, input.name, source);
    return { session: input.name, status: "closed" as const };
  },
});

export const sessionOperations = [sessionList, sessionStart, sessionRead, sessionSend, sessionClose];
