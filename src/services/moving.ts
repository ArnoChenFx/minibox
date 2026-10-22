import { conflict } from "../lib/errors";
import { msg } from "../lib/messages";

/**
 * Boxes whose move runs in this process, and boxes whose rebuild or update runs. A move holds the box's power lock, but
 * a rebuild and an in-place update do not, so each side registers here and refuses to overlap the other.
 */
const moving = new Set<string>();
const changing = new Map<string, number>();

/** Marks the box as moving until the returned function is called. A box that is being changed, or moved, is refused. */
export function beginMove(boxId: string): () => void {
  if (moving.has(boxId)) throw conflict(msg("box_moving"));
  if (changing.has(boxId)) throw conflict(msg("box_changing"));
  moving.add(boxId);
  return () => {
    moving.delete(boxId);
  };
}

/** Marks the box as being changed until the returned function is called. A box that is moving is refused. */
export function beginChange(boxId: string): () => void {
  if (moving.has(boxId)) throw conflict(msg("box_moving"));
  changing.set(boxId, (changing.get(boxId) ?? 0) + 1);
  return () => {
    const left = (changing.get(boxId) ?? 1) - 1;
    if (left > 0) changing.set(boxId, left);
    else changing.delete(boxId);
  };
}
