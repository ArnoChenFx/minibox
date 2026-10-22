import { conflict } from "../lib/errors";
import { msg } from "../lib/messages";

/**
 * Boxes whose move is running in this process. A move holds the box's power lock, but a rebuild and an in-place update
 * do not, so they check this set instead of waiting for the lock.
 */
const inFlight = new Set<string>();

/** Marks the box as moving until the returned function is called. A second move of the same box is refused. */
export function beginMove(boxId: string): () => void {
  if (inFlight.has(boxId)) throw conflict(msg("box_moving"));
  inFlight.add(boxId);
  return () => {
    inFlight.delete(boxId);
  };
}

export function assertNotMoving(boxId: string): void {
  if (inFlight.has(boxId)) throw conflict(msg("box_moving"));
}
