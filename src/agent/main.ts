import { createDockerRuntime } from "../docker/runtime";
import { log } from "../lib/logger";
import type { Runtime } from "../runtime";
import { resolveVersion } from "../version";
import { AgentClient } from "./client";
import { type AgentIdentity, generateKeyPairPem, loadIdentity, saveIdentity } from "./identity";
import { AGENT_PAIR_PATH, AGENT_PROTOCOL, type PairRequest, type PairResponse, PairResponseSchema } from "./protocol";
import { AgentScope, freshScope, loadScope, saveScope } from "./scope";
import { scopedRuntime } from "./scoped-runtime";
import { findSelf } from "./self";

export const USAGE = `Usage: bun src/agent/main.ts --server <url> [--pair <code>]

  --server <url>   The MiniBox address this machine can reach, such as https://minibox.example.com
  --pair <code>    The one-time code from Settings > Hosts > Add host > Agent. Needed once, on the first start.

Environment:
  DATA_DIR                  Where the agent keeps its identity. Default /data.
  DOCKER_SOCKET             The Docker socket to manage. Default /var/run/docker.sock.
  AGENT_ALLOWED_RUNTIMES    Container runtimes besides runc that a box may ask for, comma separated, such as runsc.
                            Default: runc only.`;

export class UsageError extends Error {}

export class PairingError extends Error {}

export interface AgentArgs {
  readonly server?: string;
  readonly pair?: string;
  readonly help: boolean;
}

/** Reads `--flag value` and `--flag=value`. Anything else is a usage error, so a typo is not silently ignored. */
export function parseArgs(argv: readonly string[]): AgentArgs {
  const args: { server?: string; pair?: string; help: boolean } = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i] ?? "";
    if (raw === "--help" || raw === "-h") {
      args.help = true;
      continue;
    }
    const eq = raw.indexOf("=");
    const flag = eq < 0 ? raw : raw.slice(0, eq);
    if (flag !== "--server" && flag !== "--pair") throw new UsageError(`unknown argument ${raw}`);
    let value = eq < 0 ? undefined : raw.slice(eq + 1);
    if (value === undefined) {
      value = argv[i + 1];
      i += 1;
    }
    if (value === undefined || value === "" || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    if (flag === "--server") args.server = serverOf(value);
    else args.pair = value.trim();
  }
  return args;
}

function serverOf(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UsageError("--server must be a URL such as https://minibox.example.com");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new UsageError("--server must start with http:// or https://");
  return url.toString();
}

/** The one call of `fetch` the pairing makes, so a test can stand in for it without the rest of the fetch type. */
export type Fetcher = (input: URL | string, init?: RequestInit) => Promise<Response>;

/** Exchanges a pairing code and the agent's public key for an agent id. The code is spent whether or not this succeeds. */
export async function pairWith(server: string, request: PairRequest, fetcher: Fetcher = fetch): Promise<PairResponse> {
  let res: Response;
  try {
    res = await fetcher(new URL(AGENT_PAIR_PATH, server), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch (e) {
    throw new PairingError(
      `the control plane at ${server} could not be reached: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    throw new PairingError(
      typeof message === "string" ? message : `the pairing request failed with HTTP ${res.status}`,
    );
  }
  const parsed = PairResponseSchema.safeParse(body);
  if (!parsed.success)
    throw new PairingError("the control plane answered with a pairing response this agent cannot read");
  return parsed.data;
}

/** The container runtimes a box may ask for besides runc, from a comma-separated setting. Names the engine could not use are dropped. */
export function allowedRuntimesOf(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name));
}

export interface AgentDeps {
  readonly fetch?: Fetcher;
  readonly runtime?: Runtime;
  readonly now?: () => Date;
}

/**
 * Starts the agent: pairs it on the first run, then keeps it connected until a signal arrives. A revoked agent stays up
 * and idle rather than exiting, so a restart policy does not start it again and again. Resolves with the exit code.
 */
export async function runAgent(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps: AgentDeps = {},
): Promise<number> {
  let args: AgentArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e instanceof Error ? `${e.message}\n\n${USAGE}` : USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const dataDir = env.DATA_DIR?.trim() || "/data";
  const version = resolveVersion(env);
  let stored = loadIdentity(dataDir);
  if (args.pair !== undefined) {
    if (stored) {
      log.warn("agent.already_paired", { agentId: stored.identity.agentId, hint: "the pairing code is ignored" });
    } else {
      if (args.server === undefined) {
        console.error(`--pair needs --server\n\n${USAGE}`);
        return 2;
      }
      const keys = generateKeyPairPem();
      let reply: PairResponse;
      try {
        reply = await pairWith(
          args.server,
          { code: args.pair, publicKey: keys.publicKeyPem, version, protocol: AGENT_PROTOCOL },
          deps.fetch,
        );
      } catch (e) {
        log.error("agent.pairing_failed", { error: e instanceof Error ? e.message : String(e) });
        return 1;
      }
      const identity: AgentIdentity = {
        agentId: reply.agentId,
        hostId: reply.hostId,
        server: args.server,
        pairedAt: (deps.now ?? (() => new Date()))().toISOString(),
      };
      // Written before the identity, so an agent that exists is never without it: this one labels everything it makes,
      // and there is nothing from before it to adopt.
      saveScope(dataDir, freshScope(reply.hostId, (deps.now ?? (() => new Date()))()));
      saveIdentity(dataDir, identity, keys.privateKeyPem);
      stored = loadIdentity(dataDir);
      log.info("agent.paired", { agentId: reply.agentId, hostId: reply.hostId });
    }
  }
  if (stored === null) {
    console.error(`This agent is not paired yet. Run it with --server and --pair.\n\n${USAGE}`);
    return 2;
  }
  const server = args.server ?? stored.identity.server;
  const engine = deps.runtime ?? createDockerRuntime(env.DOCKER_SOCKET?.trim() || "/var/run/docker.sock");
  let scope: AgentScope;
  try {
    scope = new AgentScope({
      hostId: stored.identity.hostId,
      dataDir,
      runtime: engine,
      record: loadScope(dataDir, stored.identity.hostId),
      findSelf: () => findSelf(engine),
    });
  } catch (e) {
    log.error("agent.scope_unreadable", { error: e instanceof Error ? e.message : String(e) });
    return 1;
  }
  const runtime = scopedRuntime(engine, scope, { allowedRuntimes: allowedRuntimesOf(env.AGENT_ALLOWED_RUNTIMES) });
  const client = new AgentClient({
    server,
    agentId: stored.identity.agentId,
    privateKey: stored.privateKey,
    runtime,
    scope,
    version,
  });
  log.info("agent.starting", { hostId: stored.identity.hostId, version, server });
  return new Promise<number>((resolve) => {
    const keepAlive = setInterval(() => {}, 60_000);
    const shutdown = () => {
      client.stop();
      clearInterval(keepAlive);
      resolve(0);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    void client.run();
  });
}

if (import.meta.main) {
  process.exit(await runAgent(Bun.argv.slice(2), process.env));
}
