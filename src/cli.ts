import { createInterface } from "node:readline";

import { boxLs, boxCreateCommand } from "./cli/box";
import { boxStartupCommand } from "./cli/box-startup";
import { execCommand } from "./cli/exec";
import { filesCommand } from "./cli/files";
import { HELP, asksForHelp } from "./cli/help";
import { imageCommand } from "./cli/image";
import { mcpProxy } from "./cli/mcp";
import { sessionCommand } from "./cli/session";
import type { CliIo } from "./cli/shared";
import { sshConfig, proxyEnv } from "./cli/ssh";
import { sshProxy } from "./cli/ssh-proxy";
import { templateCommand } from "./cli/template";
import { toolCommand } from "./cli/tool";
import { backupCommand, restoreCommand } from "./cli/backup";
import { transferCommand } from "./cli/transfer";

/** The server version the binary was compiled from. `bun build --env` inlines it; a run from source reports `dev`. */
const BUILT_VERSION = process.env.MINIBOX_CLI_BUILD_VERSION?.trim() || "dev";

/** Runs one CLI invocation. `bun src/cli.ts` and the compiled binary both call this. */
export async function runCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  io: CliIo,
  lines: AsyncIterable<string> = stdinLines(),
  version: string = BUILT_VERSION,
): Promise<number> {
  const [command, sub, ...rest] = argv;
  try {
    if (command === undefined) {
      io.stderr(HELP);
      return 2;
    }
    if (command === "--help" || command === "-h" || command === "help") {
      io.stdout(HELP);
      return 0;
    }
    if (command === "--version" || command === "-v" || command === "version") {
      io.stdout(`minibox ${version}\n`);
      return 0;
    }
    if (asksForHelp(argv.slice(1))) {
      io.stdout(HELP);
      return 0;
    }
    if (command === "box" && (sub === "ls" || sub === "list")) return await boxLs(rest, env, io);
    if (command === "box" && sub === "create") return await boxCreateCommand(rest, env, io);
    if (command === "box" && sub === "startup-command") return await boxStartupCommand(rest, env, io);
    if (command === "template") return await templateCommand(sub === undefined ? [] : [sub, ...rest], env, io);
    if (command === "image") return await imageCommand(sub === undefined ? [] : [sub, ...rest], env, io);
    if (command === "exec") return await execCommand(sub === undefined ? [] : [sub, ...rest], env, io);
    if (command === "session") return await sessionCommand(sub === undefined ? [] : [sub, ...rest], env, io);
    if (command === "files") return await filesCommand(sub === undefined ? [] : [sub, ...rest], env, io);
    if (command === "cp" || command === "upload" || command === "download") {
      return await transferCommand(command, sub === undefined ? [] : [sub, ...rest], env, io);
    }
    if (command === "tool") return await toolCommand(sub === undefined ? [] : [sub, ...rest], env, io);
    if (command === "mcp") return await mcpProxy(sub === undefined ? [] : [sub, ...rest], env, io, lines);
    if (command === "ssh-config") return await sshConfig(sub === undefined ? [] : [sub, ...rest], env, io);
    if (command === "ssh-proxy")
      return await sshProxy(sub === undefined ? [] : [sub, ...rest], await proxyEnv(env), io, version);
    if (command === "backup") return await backupCommand(sub === undefined ? [] : [sub, ...rest], env, io);
    if (command === "restore") return await restoreCommand(sub === undefined ? [] : [sub, ...rest], env, io);
    io.stderr(`Unknown command ${command}\n${HELP}`);
    return 2;
  } catch (e) {
    io.stderr(`${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
}

async function* stdinLines(): AsyncGenerator<string> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2), process.env, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    stdoutBytes: (bytes) => process.stdout.write(bytes),
    stdinBytes: () => process.stdin,
  });
  // Pipe writes can finish after exit, and the last SSH bytes must reach ssh before the process ends.
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(code);
}

export { sshLayout, sshConfigBlock } from "./cli/ssh";
export type { Env, SshHost, SshLayout } from "./cli/ssh";
export { isNewerVersion } from "./cli/ssh-proxy";
