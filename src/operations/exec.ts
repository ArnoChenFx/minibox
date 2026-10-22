import { z } from "zod";

import { AppError } from "../lib/errors";
import { msg } from "../lib/messages";
import { accept, type Checked, reject } from "../lib/validation";
import { getBox } from "../services/boxes";
import {
  EXEC_BACKGROUND_PER_BOX,
  EXEC_BACKGROUND_TOTAL,
  type ExecService,
  type ExecTarget,
  isPrivilegedUser,
} from "../services/exec";
import { boxTarget } from "./boxes";
import { defineOperation } from "./define";
import { hostOfBox, hostOfExec } from "./routing";
import { addFailure, boxId, field } from "./validation";

const CMD_MAX = 16 * 1024;
const ARG_MAX = 16 * 1024;
const ARGV_MAX = 256;
const CWD_MAX = 512;
const ENV_MAX = 64;
const ENV_VALUE_MAX = 32 * 1024;
const STDIN_MAX = 1024 * 1024;
const TIMEOUT_DEFAULT = 30;
const TIMEOUT_MIN = 1;
const TIMEOUT_MAX = 3600;
/** The server closes an idle connection after 60 seconds, so a foreground call must finish sooner. */
const FOREGROUND_TIMEOUT_MAX = 55;
/** Under the strict profile only the box's default user may run commands. */
const STRICT_EXEC_USERS: readonly string[] = ["dev", "1000"];
const WAIT_MAX = 25_000;
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,31})?$/;
const EXEC_ID = /^ex_[0-9A-HJKMNP-TV-Z]{26}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const EXEC_DESCRIPTION = `Run a command in a box. Starts the box if it is stopped, which sets its desired state to running and raises its revision. Default user is dev and the default directory is /workspace. Pass argv to run a program without a shell, or cmd to run it through /bin/sh -c. Send exactly one of them. The box needs /bin/sh, cat, rm and sleep, which the exec wrapper and exec_kill use. The result includes status (running, exited or killed), exitCode, stdout, stderr, truncated, durationMs, timedOut and outputRef. A non-zero exit code is the program's status. Inline output keeps about 16 KiB from the start and 16 KiB from the end of each stream; when truncated is true, outputRef names the saved window at GET /api/execs/{execId}/output. A timeout stops the process tree and sets timedOut true. If the stop fails, status stays running, the stop is retried after a growing delay, and exec_kill can also retry. Foreground calls may set timeoutSec up to ${FOREGROUND_TIMEOUT_MAX}; longer commands need background true, and then poll with exec_get. At most ${EXEC_BACKGROUND_PER_BOX} background execs run per box and ${EXEC_BACKGROUND_TOTAL} across MiniBox. Under the strict profile only dev or 1000 may be the user. Other profiles may run as root; those runs are marked privileged in the audit. Commands, argv and the env names are written to the audit log, so pass secrets through env, not argv. exec can read and write every volume mounted on the box.`;

function checkCmd(value: unknown): Checked<string | undefined> {
  if (value === undefined || value === null) return accept(undefined);
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || Buffer.byteLength(value) > CMD_MAX) {
    return reject(msg("exec_cmd_invalid", { max: CMD_MAX }), "cmd");
  }
  return accept(value);
}

function checkArgv(value: unknown): Checked<string[] | undefined> {
  if (value === undefined || value === null) return accept(undefined);
  if (!Array.isArray(value) || value.length < 1 || value.length > ARGV_MAX) {
    return reject(msg("exec_argv_invalid", { max: ARGV_MAX }), "argv");
  }
  const argv: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.includes("\0") || Buffer.byteLength(item) > ARG_MAX) {
      return reject(msg("exec_argv_invalid", { max: ARGV_MAX }), "argv");
    }
    argv.push(item);
  }
  return accept(argv);
}

function checkCwd(value: unknown): Checked<string> {
  if (value === undefined || value === null || value === "") return accept("/workspace");
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.includes("\0") ||
    /[\r\n]/.test(value) ||
    Buffer.byteLength(value) > CWD_MAX
  ) {
    return reject(msg("exec_cwd_invalid", { max: CWD_MAX }), "cwd");
  }
  return accept(value);
}

function checkEnv(value: unknown): Checked<Record<string, string>> {
  if (value === undefined || value === null) return accept({});
  if (typeof value !== "object" || Array.isArray(value)) return reject(msg("exec_env_invalid"), "env");
  const entries = Object.entries(value);
  if (entries.length > ENV_MAX) return reject(msg("exec_env_invalid"), "env");
  const env: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (
      !ENV_NAME.test(key) ||
      typeof item !== "string" ||
      item.includes("\0") ||
      Buffer.byteLength(item) > ENV_VALUE_MAX
    ) {
      return reject(msg("exec_env_invalid"), "env");
    }
    env[key] = item;
  }
  return accept(env);
}

function checkTimeout(value: unknown): Checked<number> {
  if (value === undefined || value === null) return accept(TIMEOUT_DEFAULT);
  if (typeof value !== "number" || !Number.isInteger(value) || value < TIMEOUT_MIN || value > TIMEOUT_MAX) {
    return reject(msg("exec_timeout_range", { min: TIMEOUT_MIN, max: TIMEOUT_MAX }), "timeoutSec");
  }
  return accept(value);
}

function checkStdin(value: unknown): Checked<string | undefined> {
  if (value === undefined || value === null) return accept(undefined);
  if (typeof value !== "string" || Buffer.byteLength(value) > STDIN_MAX) {
    return reject(msg("exec_stdin_invalid", { max: STDIN_MAX }), "stdin");
  }
  return accept(value);
}

function checkUser(value: unknown): Checked<string> {
  if (value === undefined || value === null) return accept("dev");
  if (typeof value !== "string" || !USER_RE.test(value)) return reject(msg("exec_user_invalid"), "user");
  return accept(value);
}

function checkBackground(value: unknown): Checked<boolean> {
  if (value === undefined || value === null) return accept(false);
  if (typeof value !== "boolean") return reject(msg("not_boolean", { field: "background" }), "background");
  return accept(value);
}

function checkExecId(value: unknown): Checked<string> {
  if (typeof value !== "string" || !EXEC_ID.test(value)) return reject(msg("exec_id_invalid"), "execId");
  return accept(value);
}

function checkWait(value: unknown): Checked<number> {
  if (value === undefined || value === null || value === "") return accept(0);
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 0 || n > WAIT_MAX) return reject(msg("exec_wait_range", { max: WAIT_MAX }), "waitMs");
  return accept(n);
}

const execId = () =>
  field(checkExecId, {
    type: "string",
    pattern: EXEC_ID.source,
    description: "Exec id returned by exec (ex_ and 26 Crockford base32 characters).",
  });

const RunOutput = z.object({
  execId: z.string(),
  background: z.boolean(),
  woke: z.boolean(),
  status: z.enum(["running", "exited", "killed"]),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  durationMs: z.number().int(),
  outputRef: z.string().nullable(),
  timedOut: z.boolean(),
});

function requireExecs(execs: ExecService | undefined): asserts execs is ExecService {
  if (!execs) throw new AppError(500, "internal", "exec service is not configured");
}

function targetOf(execs: ExecService | undefined, execId: string): ExecTarget | undefined {
  return execs?.lookup(execId);
}

function commandAudit(input: {
  cmd?: string;
  argv?: string[];
  cwd: string;
  user: string;
  timeoutSec: number;
  background: boolean;
  env: Record<string, string>;
  stdin?: string;
}): Record<string, unknown> {
  return {
    cmd: input.cmd,
    argv: input.argv,
    cwd: input.cwd,
    user: input.user,
    privileged: isPrivilegedUser(input.user),
    timeoutSec: input.timeoutSec,
    background: input.background,
    env: Object.keys(input.env),
    stdinBytes: input.stdin === undefined ? 0 : Buffer.byteLength(input.stdin),
  };
}

export const execRun = defineOperation({
  name: "exec.run",
  tag: "exec",
  summary: "Run a command in a box",
  kind: "write",
  scope: "box:exec",
  async: false,
  input: z
    .object({
      id: boxId(),
      cmd: field(checkCmd, {
        type: "string",
        maxLength: CMD_MAX,
        description: "Shell command, run as /bin/sh -c. Mutually exclusive with argv.",
      }).optional(),
      argv: field(checkArgv, {
        type: "array",
        maxItems: ARGV_MAX,
        description: "Program and arguments, executed directly with no shell. Mutually exclusive with cmd.",
      }).optional(),
      cwd: field(checkCwd, {
        type: "string",
        maxLength: CWD_MAX,
        description: "Absolute working directory. Defaults to /workspace.",
      }).default("/workspace"),
      env: field(checkEnv, {
        type: "object",
        description:
          "Environment variables for the command, by name. Values are not written to the audit log. Defaults to none.",
      }).default({}),
      timeoutSec: field(checkTimeout, {
        type: "integer",
        minimum: TIMEOUT_MIN,
        maximum: TIMEOUT_MAX,
        description: `Stop the process tree after this many seconds. Defaults to ${TIMEOUT_DEFAULT}. Foreground calls accept at most ${FOREGROUND_TIMEOUT_MAX}; use background for longer commands.`,
      }).default(TIMEOUT_DEFAULT),
      stdin: field(checkStdin, {
        type: "string",
        maxLength: STDIN_MAX,
        description: "Bytes written to the command's stdin, then closed. Not written to the audit log.",
      }).optional(),
      user: field(checkUser, {
        type: "string",
        description:
          "Container user, as a name or id, optionally with a group. Defaults to dev. The strict profile allows only dev or 1000. Other profiles may use root, and those runs are marked privileged in the audit.",
      }).default("dev"),
      background: field(checkBackground, {
        type: "boolean",
        description:
          "Return immediately with execId. Poll with exec_get. Defaults to false. A foreground call may use a timeoutSec of at most 55.",
      }).default(false),
    })
    .superRefine((input, ctx) => {
      if ((input.cmd !== undefined) === (input.argv !== undefined)) {
        addFailure(ctx, {
          message: msg("exec_command_required"),
          field: "cmd",
          hint: msg("exec_command_hint"),
        });
      }
      if (!input.background && input.timeoutSec > FOREGROUND_TIMEOUT_MAX) {
        addFailure(ctx, {
          message: msg("exec_timeout_foreground", { max: FOREGROUND_TIMEOUT_MAX }),
          field: "timeoutSec",
          hint: msg("exec_timeout_foreground_hint"),
        });
      }
    }),
  output: RunOutput,
  rest: [{ method: "POST", path: "/api/boxes/:id/exec", body: true }],
  cli: "exec",
  mcp: { toolset: "core", name: "exec", description: EXEC_DESCRIPTION },
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: {
    action: (input) => (input.background ? "exec.background" : "exec.run"),
    target: (_input, box) => box.name,
  },
  audit: {
    target: (_input, box) => box && boxTarget(box),
    detail: (input) => commandAudit(input),
    ref: (_input, _box, result) =>
      result ? { execId: result.execId, ...(result.outputRef ? { outputRef: result.outputRef } : {}) } : undefined,
  },
  run: async ({ host, execs, record }, input, box) => {
    requireExecs(execs);
    if (box.profile === "strict" && !STRICT_EXEC_USERS.includes(input.user)) {
      throw new AppError(403, "forbidden", msg("exec_user_strict", { user: input.user }), undefined, {
        hint: msg("exec_user_strict_hint"),
      });
    }
    return execs.run(host, box, input, record);
  },
});

export const execGet = defineOperation({
  name: "exec.get",
  tag: "exec",
  summary: "Read an exec",
  kind: "read",
  scope: "box:exec",
  async: false,
  input: z.object({
    execId: execId(),
    waitMs: field(checkWait, {
      type: "integer",
      minimum: 0,
      maximum: WAIT_MAX,
      description: `Long-poll for up to this many milliseconds while the command is running. Defaults to 0. The maximum is ${WAIT_MAX}.`,
    }).default(0),
  }),
  output: RunOutput,
  rest: [{ method: "GET", path: "/api/execs/:execId", query: ["waitMs"] }],
  cli: "exec get",
  mcp: {
    toolset: "core",
    name: "exec_get",
    description:
      "Read an exec started with background true. waitMs long-polls while it is running, up to 25000 milliseconds. status is running, exited or killed. A non-zero exitCode is the program's status.",
  },
  hostFor: (ctx, input) => hostOfExec(ctx, input.execId),
  resolve: async ({ execs }, input) => {
    const found = targetOf(execs, input.execId);
    if (!found) throw notFoundMissing();
    return found;
  },
  audit: { target: (_input, found) => found && { kind: "box", id: found.id, name: found.name } },
  run: async ({ execs }, input) => {
    requireExecs(execs);
    return execs.get(input.execId, input.waitMs);
  },
});

export const execKill = defineOperation({
  name: "exec.kill",
  tag: "exec",
  summary: "Kill an exec",
  kind: "write",
  scope: "box:exec",
  async: false,
  conflicts: true,
  input: z.object({ execId: execId() }),
  output: z.object({ execId: z.string(), status: z.literal("killed") }),
  rest: [{ method: "POST", path: "/api/execs/:execId/kill" }],
  cli: "exec kill",
  mcp: {
    toolset: "core",
    name: "exec_kill",
    description:
      "Kill a running exec and its process tree, from inside the box. An exec that has already exited returns a conflict. If a process survives, or the exec does not end, the call fails with 502 and the exec keeps running, so it can be killed again.",
  },
  hostFor: (ctx, input) => hostOfExec(ctx, input.execId),
  resolve: async ({ execs }, input) => {
    const found = targetOf(execs, input.execId);
    if (!found) throw notFoundMissing();
    return found;
  },
  activity: { action: () => "exec.kill", target: (_input, found) => found.name },
  audit: {
    target: (_input, found) => found && { kind: "box", id: found.id, name: found.name },
    detail: (input) => ({ execId: input.execId }),
  },
  run: async ({ execs }, input) => {
    requireExecs(execs);
    return execs.kill(input.execId);
  },
});

export const execOutput = defineOperation({
  name: "exec.output",
  tag: "exec",
  summary: "Read saved exec output",
  kind: "read",
  scope: "box:exec",
  async: false,
  input: z.object({ execId: execId() }),
  output: z.object({
    execId: z.string(),
    stdout: z.string(),
    stderr: z.string(),
    truncated: z.boolean(),
    stdoutBytes: z.number().int(),
    stderrBytes: z.number().int(),
  }),
  rest: [{ method: "GET", path: "/api/execs/:execId/output" }],
  cli: "exec output",
  hostFor: (ctx, input) => hostOfExec(ctx, input.execId),
  resolve: async ({ execs }, input): Promise<ExecTarget | undefined> => targetOf(execs, input.execId),
  audit: {
    target: (input, found) =>
      found ? { kind: "box", id: found.id, name: found.name } : { kind: "exec", name: input.execId },
  },
  run: async ({ execs }, input) => {
    requireExecs(execs);
    return execs.output(input.execId);
  },
});

function notFoundMissing(): AppError {
  return new AppError(404, "not_found", msg("exec_not_found"), undefined, { hint: msg("exec_not_found_hint") });
}

export const execOperations = [execRun, execGet, execKill, execOutput];
