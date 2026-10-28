export declare const AGENT_IMAGE: string;

export declare const AGENT_LATEST_TAG: string;

/** The image tag for a MiniBox version: its own version for a release, `latest` for a dev build or an unknown version. */
export declare function agentImageTag(version?: string | null): string;

/** The agent image at the tag for `version`. */
export declare function agentImage(version?: string | null): string;

/** Whether the console's address is plain http, where the pairing code and the agent's traffic travel in the clear. */
export declare function insecureConsole(protocol: string): boolean;

export declare function agentBashCommand(server: string, code: string, version?: string | null): string;

export declare function agentPowerShellCommand(server: string, code: string, version?: string | null): string;
