/** The setup an edit sends: the postCreateCommand as argv and the ports to open, or null for none. */
export type TemplateInitBody = { postCreate?: string[]; forwardPorts?: number[] } | null;

/** The forwarded ports an edit asks for: `{ ports }`, or `{ problem }` naming the entry that is not a port. */
export type PortsResult = { ports: number[]; problem?: undefined } | { problem: string; ports?: undefined };

/** The setup an edit sends, from the command and the ports the dialog holds. */
export declare function initOf(command: unknown, ports: readonly number[]): TemplateInitBody;

/** The ports a caller typed, as a comma or space separated list of integers between 1 and 65535. */
export declare function readPorts(text: unknown): PortsResult;

/** The postCreateCommand as one line to type, from the argv a recipe keeps. */
export declare function commandText(command: readonly string[] | undefined): string;
