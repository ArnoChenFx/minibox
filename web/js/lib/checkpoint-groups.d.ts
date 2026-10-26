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
  /** True when the group holds snapshots of one volume, which name no box: the group is not a deleted box. */
  volume?: boolean;
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
