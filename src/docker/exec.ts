import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { type Duplex, PassThrough } from "node:stream";

import Docker from "dockerode";

import { type ExecSession, type ExecStatus, isRuntimeError, type Runtime, RuntimeError } from "../runtime";
import { call, within, type Engine } from "./engine";

/**
 * Runs the command as a child of this shell, with the exec's token in the shell's argv as `minibox-exec <token>`.
 * KILL_TREE_SCRIPT finds the exec through that argv, so the hint file is only a shortcut: a command that removes it,
 * or a box where it cannot be written, is still stopped. The shell is not replaced, so the hint also goes when the
 * command ends normally. Needs /bin/sh in the box.
 */
export const RUN_WRAPPER = `
token=$1
shift
(: > "/tmp/.minibox-exec-$token.$$") 2>/dev/null
"$@"
status=$?
rm -f "/tmp/.minibox-exec-$token.$$" 2>/dev/null
exit "$status"
`.trim();

/**
 * Stops one exec from inside the box. `$1` is the exec's token. The wrapper is matched on its cmdline: `$(cat)` drops
 * the NULs between argv entries, so `minibox-exec` followed by the token matches as one string. Hint files named
 * `/tmp/.minibox-exec-<token>.<pid>` only suggest pids, and each suggestion is checked the same way, because /tmp is
 * writable by every user. Children are found through the ppid in /proc/<pid>/stat, since some kernels have no
 * /proc/<pid>/task/<tid>/children. Processes in the wrapper's session or process group are taken too when the wrapper
 * leads one. Each process is stopped as it is found, and scans repeat until one finds nothing new, so a child forked
 * before its parent was stopped is caught by the next scan. Exit 0: nothing of the exec is left. Exit 1: a process
 * could not be signalled, and the rest resume; or a process survived, and the rest stay stopped for a retry. Exit 2:
 * no wrapper.
 */
export const KILL_TREE_SCRIPT = `
token=$1
pattern="minibox-exec$token"
self=$$
members=""
anchors=""
groups=" "
roots=0
grew=0

load() {
  read -r line 2>/dev/null < "/proc/$1/stat" || return 1
  rest=\${line##*) }
  set -- $rest
  st_state=$1 st_ppid=$2 st_pgid=$3 st_sid=$4 st_start=\${20}
}

enlist() {
  members="$members $1:$2"
  kill -STOP "$1" 2>/dev/null
  grew=1
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    load "$1" || return 0
    case $st_state in T | t | Z | X) return 0 ;; esac
    sleep 0.01 2>/dev/null
  done
}

try_root() {
  [ "$1" -gt 1 ] 2>/dev/null && [ "$1" != "$self" ] || return 0
  case " $members " in *" $1:"*) return 0 ;; esac
  load "$1" || return 0
  case $st_state in Z | X) return 0 ;; esac
  case $(cat "/proc/$1/cmdline" 2>/dev/null) in *"$pattern"*) ;; *) return 0 ;; esac
  roots=1
  anchors="$anchors $1:$st_start"
  if [ "$st_sid" = "$1" ] || [ "$st_pgid" = "$1" ]; then groups="$groups$1 "; fi
  enlist "$1" "$st_start"
}

expand() {
  grew=0
  for d in /proc/[0-9]*; do
    q=\${d#/proc/}
    [ "$q" -gt 1 ] && [ "$q" != "$self" ] || continue
    case " $members " in *" $q:"*) continue ;; esac
    load "$q" || continue
    case $st_state in Z | X) continue ;; esac
    joins=0
    case " $members " in *" $st_ppid:"*) joins=1 ;; esac
    case $groups in *" $st_sid "* | *" $st_pgid "*) joins=1 ;; esac
    [ "$joins" = 1 ] || continue
    enlist "$q" "$st_start"
  done
}

thaw() {
  for tok in $members; do
    q=\${tok%%:*}
    load "$q" || continue
    [ "$st_start" = "\${tok#*:}" ] || continue
    kill -CONT "$q" 2>/dev/null
  done
}

signalable() {
  for tok in $members; do
    q=\${tok%%:*}
    load "$q" || continue
    [ "$st_start" = "\${tok#*:}" ] || continue
    case $st_state in Z | X) continue ;; esac
    kill -0 "$q" 2>/dev/null || return 1
  done
}

drain() {
  rounds=0
  while :; do
    alive=0
    for tok in $members; do
      case " $anchors " in *" $tok "*) anchor=1 ;; *) anchor=0 ;; esac
      [ "$anchor" = "$1" ] || continue
      q=\${tok%%:*}
      load "$q" || continue
      [ "$st_start" = "\${tok#*:}" ] || continue
      case $st_state in Z | X) continue ;; esac
      alive=1
      kill -KILL "$q" 2>/dev/null
    done
    [ "$alive" = 1 ] || return 0
    rounds=$((rounds + 1))
    [ "$rounds" -lt 40 ] || return 1
    sleep 0.05 2>/dev/null
  done
}

for h in /tmp/.minibox-exec-"$token".*; do try_root "\${h##*.}"; done
for d in /proc/[0-9]*; do try_root "\${d#/proc/}"; done
if [ "$roots" = 0 ]; then rm -f /tmp/.minibox-exec-"$token".* 2>/dev/null; exit 2; fi

passes=0
while :; do
  while [ "$grew" = 1 ]; do expand; done
  signalable || { thaw; exit 1; }
  drain 0 || exit 1
  drain 1 || exit 1
  expand
  [ "$grew" = 1 ] || break
  passes=$((passes + 1))
  [ "$passes" -lt 5 ] || exit 1
done
rm -f /tmp/.minibox-exec-"$token".* 2>/dev/null
exit 0
`.trim();

/** How often the kill looks for the wrapper again, and how many times it looks before it gives up. */
const KILL_RETRY_MS = 60;

const KILL_ATTEMPTS = 10;

/** Upper bounds on waiting for the kill's own output to end, for its exit code, and for the exec to end after a 0. */
const KILL_STREAM_MS = 5000;

const KILL_EXIT_MS = 2000;

const KILL_CONFIRM_MS = 3000;

/** Longest a kill may take to be created and started. A kill that cannot start fails, and the stop is tried again. */
const KILL_START_MS = 5000;

/**
 * Stops an exec from inside its box, as `stopAs`. An exec that has already ended has nothing left to stop. Exit 0 from
 * the kill is trusted only once Docker reports the exec ended: a wrapper that is still running is an error, and the
 * exec stays running so that a retry can finish the job.
 */
async function stopExec(
  docker: Docker,
  containerId: string,
  execId: string,
  token: string,
  stopAs: string | undefined,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    if (!(await execRunning(docker, execId))) return;
    const code = await runKillScript(docker, containerId, execId, token, stopAs);
    if (code === 0) {
      if (await waitForEnd(docker, execId, KILL_CONFIRM_MS)) return;
      throw engineFailure(execId, "its process was still running after the kill");
    }
    if (code === 2 && attempt < KILL_ATTEMPTS) {
      await sleep(KILL_RETRY_MS);
      continue;
    }
    throw engineFailure(execId, killFailure(code));
  }
}

function killFailure(code: number | null): string {
  if (code === 1) return "a process is still running or could not be signalled";
  if (code === 2) return "its process was not found";
  return "the kill did not finish";
}

function engineFailure(execId: string, reason: string): RuntimeError {
  return new RuntimeError("engine", `exec ${execId} could not be stopped: ${reason}`);
}

/**
 * A raw engine exec, not `startExec`, so a kill is never wrapped or recorded as a command of its own. It runs in `/`:
 * runc enters the working directory before the kill starts, and the exec's own directory can be a volume on a storage
 * server that is not answering. Creating and starting it is bounded, so a kill that hangs fails and the stop is retried.
 */
async function runKillScript(
  docker: Docker,
  containerId: string,
  execId: string,
  token: string,
  stopAs: string | undefined,
): Promise<number | null> {
  const started = (async () => {
    const exec = await call(() =>
      docker.getContainer(containerId).exec({
        Cmd: ["/bin/sh", "-c", KILL_TREE_SCRIPT, "minibox-kill", token],
        AttachStdout: true,
        AttachStderr: true,
        WorkingDir: "/",
        ...(stopAs ? { User: stopAs } : {}),
      }),
    );
    const stream = (await call(() => exec.start({ hijack: true }))) as Duplex;
    return { exec, stream };
  })();
  const attached = await within(started, KILL_START_MS);
  if (!attached) {
    started.then(
      ({ stream }) => stream.destroy(),
      () => undefined,
    );
    throw engineFailure(execId, `its kill did not start within ${KILL_START_MS / 1000} s`);
  }
  attached.stream.resume();
  await streamEnds(attached.stream, KILL_STREAM_MS);
  return exitStatusOf(docker, attached.exec.id);
}

/** An exec the engine no longer knows has ended. */
async function execRunning(docker: Docker, execId: string): Promise<boolean> {
  try {
    return (await call(() => docker.getExec(execId).inspect())).Running;
  } catch (e) {
    if (isRuntimeError(e, "not_found")) return false;
    throw e;
  }
}

/** Whether the exec ends within `ms`. */
async function waitForEnd(docker: Docker, execId: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (await execRunning(docker, execId)) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}

/** The exit code of an ended exec, or null if it is still running after KILL_EXIT_MS. */
async function exitStatusOf(docker: Docker, execId: string): Promise<number | null> {
  const deadline = Date.now() + KILL_EXIT_MS;
  for (;;) {
    const info = await call(() => docker.getExec(execId).inspect());
    if (!info.Running) return info.ExitCode;
    if (Date.now() >= deadline) return null;
    await sleep(50);
  }
}

/**
 * Resolves when the stream ends or fails, or after `ms`. The kill's output is discarded, so this only bounds the wait.
 */
function streamEnds(stream: Duplex, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      resolve();
    }
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", finish);
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const WRITE_FILE_MS = 30_000;

async function untilExited(session: ExecSession): Promise<ExecStatus> {
  for (;;) {
    const status = await session.inspect();
    if (!status.running) return status;
    await sleep(50);
  }
}

type ExecMethods = Pick<Runtime, "startExec" | "writeContainerFile">;

export function execMethods(engine: Engine): ExecMethods {
  const { docker } = engine;

  const methods: ExecMethods = {
    async startExec(containerId, spec) {
      // Every exec runs through the wrapper, terminal included, so kill() can stop its process tree from inside the box.
      // Absent tty is the web terminal: one stream. Command exec sets tty false so stdout and stderr stay separate.
      const tty = spec.tty !== false;
      const token = randomBytes(8).toString("hex");
      const exec = await call(() =>
        docker.getContainer(containerId).exec({
          Cmd: ["/bin/sh", "-c", RUN_WRAPPER, "minibox-exec", token, ...spec.cmd],
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: tty,
          Env: spec.env,
          WorkingDir: spec.workingDir,
          ...(spec.user ? { User: spec.user } : {}),
        }),
      );
      const stream = (await call(() => exec.start({ hijack: true, stdin: true, Tty: tty }))) as Duplex;
      const stdout = tty ? stream : new PassThrough();
      const stderr = new PassThrough();
      if (!tty) docker.modem.demuxStream(stream, stdout, stderr);
      const finishOutputs = () => {
        if (!tty && !stdout.writableEnded) stdout.end();
        if (!stderr.writableEnded) stderr.end();
      };
      stream.on("end", finishOutputs);
      stream.on("close", finishOutputs);
      return {
        id: exec.id,
        stream,
        stdout,
        stderr,
        async resize({ cols, rows }) {
          await call(() => docker.getExec(exec.id).resize({ h: rows, w: cols }));
        },
        async inspect() {
          const info = await call(() => docker.getExec(exec.id).inspect());
          return { running: info.Running, exitCode: info.ExitCode, pid: info.Pid || null };
        },
        async kill() {
          try {
            await stopExec(docker, containerId, exec.id, token, spec.stopAs ?? spec.user);
          } catch (e) {
            if (isRuntimeError(e, "engine")) throw e;
            throw engineFailure(exec.id, e instanceof Error ? e.message : String(e));
          }
        },
      };
    },
    async writeContainerFile(containerId, path, data, { user, mode }) {
      // The umask keeps the file from being wider than `mode` while it is written, and the chmod that
      // follows sets the exact bits. A umask alone cannot: `cat >` creates at 0666, and a umask only
      // clears bits, so an executable `mode` (0755) would come out 0644 and the file could not run.
      const umask = (~mode & 0o777).toString(8).padStart(3, "0");
      const exact = (mode & 0o777).toString(8).padStart(3, "0");
      const session = await methods.startExec(containerId, {
        cmd: [
          "/bin/sh",
          "-c",
          'rm -f -- "$1" && umask "$2" && cat > "$1" && chmod "$3" "$1"',
          "sh",
          path,
          umask,
          exact,
        ],
        env: [],
        workingDir: "/",
        tty: false,
        user,
      });
      let stderr = "";
      session.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      session.stdout.resume();
      const ended = once(session.stdout, "end");
      session.stream.end(data);
      const status = await within(
        ended.then(() => untilExited(session)),
        WRITE_FILE_MS,
      );
      if (!status) throw new RuntimeError("engine", `writing ${path} in ${containerId} did not finish`);
      if (status.exitCode !== 0) {
        throw new RuntimeError("engine", `writing ${path} in ${containerId} failed: ${stderr.trim() || "no output"}`);
      }
    },
  };
  return methods;
}
