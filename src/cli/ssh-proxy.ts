import { type CliIo, request, fail, DEFAULT_URL } from "./shared";
import { SSH_SUFFIX, accessKey } from "./ssh";

const VERSION_SHAPE = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+)-g[0-9a-f]+)?(?:-dirty)?$/;

/** Feeds the SSH client's bytes into the WebSocket, and closes it when the client has nothing more to send. */
async function forwardStdin(input: AsyncIterable<Uint8Array>, ws: WebSocket): Promise<void> {
  for await (const chunk of input) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(chunk);
  }
  if (ws.readyState === WebSocket.OPEN) ws.close(1000, "ssh finished");
}

/** Whether `candidate` is a later build than `current`, both as `git describe` writes them, such as 0.3.0 or 0.3.0-62-gef442f5. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  if (left === null || right === null) return false;
  for (let i = 0; i < 4; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

function parseVersion(text: string): number[] | null {
  const match = VERSION_SHAPE.exec(text.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 0)];
}

/**
 * Carries one SSH connection over stdio, so `ssh` can reach a box through this server. The server's checks run first,
 * so a refusal prints its reason. A WebSocket reports only that the upgrade failed, not the status it got.
 */
export async function sshProxy(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
  version: string,
): Promise<number> {
  const [host, ...extra] = argv;
  if (!host || host.startsWith("--") || extra.length > 0) throw new Error("minibox ssh-proxy needs one box name");
  const name = host.endsWith(SSH_SUFFIX) ? host.slice(0, -SSH_SUFFIX.length) : host;
  if (!name) throw new Error("minibox ssh-proxy needs one box name");
  const path = `/api/ssh/${encodeURIComponent(name)}`;
  const probe = await request(env, "GET", path);
  if (probe.status >= 400) return fail(io, probe.status, probe.json, probe.text);
  const base = (env.MINIBOX_URL ?? DEFAULT_URL).replace(/\/$/, "");
  const served = probe.headers.get("x-minibox-version");
  if (served && isNewerVersion(served, version)) {
    io.stderr(
      `minibox: ${base} runs MiniBox ${served}, newer than this CLI (${version}). Update it with: curl -fsSL ${base}/cli/install.sh | sh\n`,
    );
  }
  const ws = new WebSocket(`${base}${path}`.replace(/^http/, "ws"), {
    headers: { authorization: `Bearer ${accessKey(env)}` },
  });
  ws.binaryType = "arraybuffer";
  const opened = await new Promise<boolean>((resolve) => {
    ws.addEventListener("open", () => resolve(true), { once: true });
    ws.addEventListener("close", () => resolve(false), { once: true });
  });
  if (!opened) {
    io.stderr(
      `minibox: the SSH connection to ${name} could not be opened. Run minibox ssh-config to check the setup.\n`,
    );
    return 1;
  }
  const ended = new Promise<number>((resolve) => {
    ws.addEventListener("message", (event) => io.stdoutBytes(new Uint8Array(event.data as ArrayBuffer)));
    ws.addEventListener("close", (event) => {
      if (event.code !== 1000 && event.reason) io.stderr(`minibox: ${event.reason}\n`);
      resolve(event.code === 1000 ? 0 : 1);
    });
  });
  void forwardStdin(io.stdinBytes(), ws).catch(() => ws.close(1011, "stdin failed"));
  return ended;
}
