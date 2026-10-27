export interface DiskEntry {
  readonly count: number | null;
  readonly activeCount: number | null;
  readonly totalBytes: number | null;
  readonly reclaimableBytes: number | null;
}

export interface DiskBreakdown {
  readonly images: DiskEntry | null;
  readonly containers: DiskEntry | null;
  readonly volumes: DiskEntry | null;
  readonly buildCache: DiskEntry | null;
}

/** `GET /api/hosts/{id}/disk`, as the console reads it. */
export interface HostDisk {
  readonly id: string;
  readonly status: string;
  readonly checkedAt: string;
  readonly supported: boolean;
  readonly reason: string | null;
  readonly detail: string | null;
  readonly breakdown: DiskBreakdown | null;
}

export interface DiskRow {
  readonly key: string;
  readonly label: string;
  /** The total, formatted by the caller's formatter. */
  readonly total: string;
  readonly totalBytes: number;
  /** Null when the engine did not report what a removal would free. */
  readonly reclaimable: string | null;
  readonly reclaimableBytes: number | null;
  readonly reclaimablePercent: number;
  readonly count: number | null;
  readonly activeCount: number | null;
}

export interface DiskReason {
  readonly key: string;
  readonly params: Readonly<Record<string, string | number>>;
}

export interface DiskReading {
  readonly reason: DiskReason | null;
  readonly rows: readonly DiskRow[];
}

export declare const DISK_CLASSES: readonly { readonly key: string; readonly label: string }[];

export declare function diskReading(disk: HostDisk | null | undefined, format: (bytes: number) => string): DiskReading;

export declare function diskReadings<T>(
  hosts: readonly { readonly id: string }[],
  get: (id: string) => Promise<T>,
): Promise<
  (
    | { readonly id: string; readonly disk: T; readonly error?: undefined }
    | { readonly id: string; readonly disk?: undefined; readonly error: unknown }
  )[]
>;
