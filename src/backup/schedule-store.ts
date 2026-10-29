import { readFileSync, unlinkSync } from "node:fs";

import { backupSchedulePath, SECRET_FILE_MODE, writeFileAtomic } from "../data-dir";
import { log } from "../lib/logger";
import { isEnoent } from "./io";
import { type BackupSchedule, BackupScheduleSchema } from "./schedule";

/** `DATA_DIR/backup-schedule.json`: the one backup schedule of this instance, or no file when it is off. */
export class BackupScheduleStore {
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = backupSchedulePath(dataDir);
  }

  /** The schedule file. The API never returns it, but the operator may name it in the docs. */
  file(): string {
    return this.path;
  }

  /**
   * The saved schedule, or null when none is set. A file that cannot be read or does not match the format is logged and
   * read as no schedule: a damaged schedule must never stop the server from starting, and setting it again replaces it.
   */
  read(): BackupSchedule | null {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (e) {
      if (!isEnoent(e)) log.warn("backup.schedule_unreadable", { path: this.path, error: String(e) });
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (e) {
      log.warn("backup.schedule_unreadable", { path: this.path, error: `not JSON (${String(e)})` });
      return null;
    }
    const checked = BackupScheduleSchema.safeParse(parsed);
    if (!checked.success) {
      log.warn("backup.schedule_unreadable", { path: this.path, error: "not a backup schedule record" });
      return null;
    }
    return checked.data;
  }

  /** Writes the schedule whole. A reader sees the old file or the new one, never a partial write. */
  write(schedule: BackupSchedule): void {
    writeFileAtomic(this.path, `${JSON.stringify(schedule, null, 2)}\n`, SECRET_FILE_MODE);
  }

  /** Removes the schedule. Clearing a schedule that is already off is not an error. */
  remove(): void {
    try {
      unlinkSync(this.path);
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
  }
}
