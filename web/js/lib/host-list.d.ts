export interface HostedBox {
  hostId?: string;
  state?: string;
  [key: string]: unknown;
}

export declare const hostOfBox: (box: HostedBox) => string;

export declare function boxesOnHost<T extends HostedBox>(boxes: readonly T[], host: string): T[];

export declare const isUnreachable: (box: HostedBox) => boolean;

export declare const HOST_BADGE: Record<string, string>;

export interface AgentConnection {
  connected: boolean;
  revoked: boolean;
  upgradeRequired: boolean;
  version: string;
  protocol: number;
  lastSeenAt: string | null;
}

export declare function agentState(
  agent: AgentConnection | null | undefined,
): "revoked" | "upgrade" | "online" | "offline" | null;
