export interface GroupedCheckpoint {
  boxId: string | null;
  boxName: string | null;
  createdAt: string;
  bytes?: number;
}

export interface GroupBox {
  boxId: string;
  name: string;
}

export interface CheckpointGroup<C extends GroupedCheckpoint, B extends GroupBox, P> {
  id: string;
  name: string;
  box: B | null;
  deleted: boolean;
  rows: C[];
  bytes: number;
  newest: number;
  pending: P | null;
}

export declare function groupCheckpoints<C extends GroupedCheckpoint, B extends GroupBox, P = unknown>(
  checkpoints: readonly C[],
  boxes: readonly B[],
  pending?: Map<string, P | null>,
): CheckpointGroup<C, B, P>[];
