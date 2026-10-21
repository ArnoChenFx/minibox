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

  async rollback(): Promise<void> {
    for (const step of this.steps.splice(0).toReversed()) {
      try {
        await step.undo();
      } catch (e) {
        log.warn("volume.rollback_failed", { step: step.what, error: String(e) });
      }
    }
  }
}
