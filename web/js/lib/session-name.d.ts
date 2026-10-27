/** The longest session name, as the server takes it. */
export declare const SESSION_NAME_MAX: number;

/** What a session name may hold, the same expression the server validates with. */
export declare const SESSION_NAME_RE: RegExp;

/** The name of the session a box opens with the first time its terminal is opened. */
export declare const DEFAULT_SESSION_NAME: string;

/**
 * The name to offer for a new session: `console` while it is free, then `console-2`, `console-3` and so on, skipping
 * every name in `used`. Names are compared without their case, and the suffix is kept inside the 32-character limit.
 */
export declare function nextSessionName(used?: readonly string[], base?: string): string;

/** Why `value` cannot be a session name, as a dictionary key, or "" when it can. */
export declare function sessionNameProblem(value: string, used?: readonly string[]): string;
