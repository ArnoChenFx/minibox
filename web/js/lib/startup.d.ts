export declare const STARTUP_COMMAND_MAX_BYTES: number;

/** Why a command cannot be sent. Mirrors `startupCommandProblem` in src/startup/command.ts. */
export type StartupProblem = "empty" | "too_long" | "control";

/** The status a box's startup command reports, as the REST API returns it. */
export interface StartupStateLike {
  status: "none" | "cloning" | "waiting" | "running" | "exited" | "failed";
  command?: string | null;
  exitCode?: number | null;
}

export interface StartupStatusView {
  tone: "" | "badge-success" | "badge-accent" | "badge-danger";
  key: string;
  params?: { code: number | string };
}

export declare function startupProblem(text: string): StartupProblem | null;
export declare function startupProblemKey(problem: StartupProblem): string;
export declare function startupStatusView(state: StartupStateLike): StartupStatusView;
export declare function isWatching(state: StartupStateLike, running: boolean): boolean;
