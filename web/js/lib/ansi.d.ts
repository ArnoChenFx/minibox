export interface AnsiRun {
  readonly text: string;
  /** Index of one of the 16 basic colors, or null for the default foreground. */
  readonly fg: number | null;
  readonly bold: boolean;
}

export declare function parseAnsi(input: string): AnsiRun[];
/** Escaped text, with a span only where a color or bold applies. Every class in the output is one this module names. */
export declare function ansiToHtml(input: string): string;
export declare function stripAnsi(input: string): string;
