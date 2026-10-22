import type { EngineTarget } from "../runtime";
import type { Endpoint } from "./endpoint";
import { SshTunnel } from "./ssh";

/** The secrets a host needs, read from its credential files. Never stored in `hosts.json` and never returned by the API. */
export interface HostCredentials {
  readonly tls?: { readonly ca: string; readonly cert: string; readonly key: string };
  readonly ssh?: { readonly privateKey: string; readonly hostKeyFingerprint: string | null };
}

/** An agent link has no socket. The control plane reaches the engine through the agent's own connection. */
export interface AgentTarget {
  readonly agentId: string;
}

/** What a link leads to: an engine socket or a TCP endpoint, or an agent that dialed in. */
export type LinkTarget = EngineTarget | AgentTarget;

export function isAgentTarget(target: LinkTarget): target is AgentTarget {
  return "agentId" in target;
}

/**
 * One way to reach a host's engine. `target` is what the runtime connects to. `connect` checks the link before any
 * request: for SSH it verifies the host key and logs in, and for the other kinds there is nothing to check yet.
 */
export interface Link {
  readonly target: LinkTarget;
  connect(): Promise<void>;
  close(): void;
}

/** Thrown when the credentials an endpoint needs are not there. Callers validate first, so this is a bug if it shows. */
export class MissingCredentialsError extends Error {
  constructor(kind: "tls" | "ssh") {
    super(`${kind} credentials are missing for this host`);
    this.name = "MissingCredentialsError";
  }
}

/**
 * Opens the link for an endpoint. Opening never touches the network: an SSH link binds its local socket and connects on
 * first use or through `connect`, so a host that is down at startup does not hold the server back.
 */
export function openLink(endpoint: Endpoint, credentials: HostCredentials): Link {
  switch (endpoint.kind) {
    case "unix":
      return noNetworkLink({ socketPath: endpoint.socketPath });
    case "tcp": {
      const tls = credentials.tls;
      if (!tls) throw new MissingCredentialsError("tls");
      return noNetworkLink({
        host: endpoint.hostname,
        port: endpoint.port,
        ca: tls.ca,
        cert: tls.cert,
        key: tls.key,
      });
    }
    case "ssh": {
      const ssh = credentials.ssh;
      if (!ssh) throw new MissingCredentialsError("ssh");
      const tunnel = new SshTunnel({
        user: endpoint.user,
        hostname: endpoint.hostname,
        port: endpoint.port,
        remoteSocket: endpoint.socketPath,
        privateKey: ssh.privateKey,
        hostKeyFingerprint: ssh.hostKeyFingerprint,
      });
      return {
        target: { socketPath: tunnel.socketPath },
        connect: () => tunnel.connect(),
        close: () => tunnel.close(),
      };
    }
    case "agent":
      return noNetworkLink({ agentId: endpoint.agentId });
  }
}

function noNetworkLink(target: LinkTarget): Link {
  return { target, connect: async () => {}, close: () => {} };
}
