export interface TaskCommand {
  /** The line above the command that names the action, or null when the log has none. */
  readonly banner: string | null;
  /** The command after its "$ " prompt, without the line break. */
  readonly command: string;
}

export interface SplitTaskLog {
  readonly commands: TaskCommand[];
  /** The log without the banners and command lines, which the Command row shows apart. */
  readonly output: string;
}

export declare function splitTaskLog(text: string): SplitTaskLog;
