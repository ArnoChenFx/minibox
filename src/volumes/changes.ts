import { log } from "../lib/logger";

interface UndoStep {
  what: string;
  undo: () => Promise<void>;
}

/**
 * Undo steps for the volume work one attempt does. A create or rebuild that fails runs them newest first, so nothing
 * it created is left behind. A step that fails is logged, and the steps after it still run.
 */
export class VolumeChanges {
  private readonly steps: UndoStep[] = [];

  add(what: string, undo: () => Promise<void>): void {
    this.steps.push({ what, undo });
  }

  /** Runs the undo steps and returns true only when every one of them succeeded. */
  async rollback(): Promise<boolean> {
    let clean = true;
    for (const step of this.steps.splice(0).toReversed()) {
      try {
        await step.undo();
      } catch (e) {
        clean = false;
        log.warn("volume.rollback_failed", { step: step.what, error: String(e) });
      }
    }
    return clean;
  }
}
