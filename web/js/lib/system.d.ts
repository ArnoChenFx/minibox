/** The version of the MiniBox this console talks to, or null when it could not be read. */
export declare const systemVersion: () => string | null;

/** Reads the server's version once and caches it. Never rejects; resolves null when the read fails. */
export declare function readSystemVersion(): Promise<string | null>;
