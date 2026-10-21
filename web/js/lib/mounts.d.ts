export interface Mount {
  volume: string;
  path: string;
  mode: "rw" | "ro";
}

export declare function validMountPath(path: string): boolean;
export declare function canonicalMounts(mounts: readonly Partial<Mount>[] | null | undefined): string;
