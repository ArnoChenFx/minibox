export interface MovePreview {
  box: { id: string; name: string };
  /** The path the move takes: `direct` sends the template image, `checkpoint` carries the data in a checkpoint. */
  via?: string;
  from: string;
  to: string;
  running: boolean;
  starts: boolean;
  image: { ref: string; transfer: boolean };
  volumes: { path: string; role: string | null; name: string; action: string; target: string | null }[];
  network: string;
  checkpoints: number;
  keeps: readonly string[];
  loses: readonly string[];
  revision: { current: number; next: number };
}

/** The HTML of a move preview: what is copied or attached, the image, whether the box starts, and what is kept and lost. */
export function movePreviewHtml(preview: MovePreview): string;
