export interface HostedBox {
  hostId?: string;
  state?: string;
  [key: string]: unknown;
}

export declare const hostFilterShown: (hosts: readonly unknown[]) => boolean;

export declare const accessWarningShown: (hosts: readonly { id?: string; transport?: string }[]) => boolean;

export declare const hostOfBox: (box: HostedBox) => string;

export declare function boxesOnHost<T extends HostedBox>(boxes: readonly T[], host: string): T[];

export declare const isUnreachable: (box: HostedBox) => boolean;

export declare const HOST_BADGE: Record<string, string>;

export interface LabelledHost {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

/** A host's label: its name, with its id when another host in `hosts` holds the same name. */
export declare function hostLabel(host: LabelledHost | undefined, hosts: readonly LabelledHost[]): string;

export interface AgentConnection {
  connected: boolean;
  revoked: boolean;
  upgradeRequired: boolean;
  version: string;
  protocol: number;
  lastSeenAt: string | null;
}

/** One host, as `GET /api/hosts` lists it. Only the fields the console decides with are named. */
export interface ListedHost {
  id: string;
  name?: string;
  transport?: string;
}

export declare function listedHost<H extends ListedHost>(hostId: string, hosts: readonly H[]): H | null;

export declare function listedHostOfBox<H extends ListedHost>(box: HostedBox, hosts: readonly H[]): H | null;

export declare const boxOnAgentHost: (box: HostedBox, hosts: readonly ListedHost[]) => boolean;

export declare const hostOnAgentTransport: (hostId: string, hosts: readonly ListedHost[]) => boolean;

export declare function agentState(
  agent: AgentConnection | null | undefined,
): "revoked" | "upgrade" | "online" | "offline" | null;
