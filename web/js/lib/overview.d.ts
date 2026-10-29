export interface OverviewRow {
  readonly box: { readonly id: string; readonly name: string; readonly hostId: string };
  readonly principal: { readonly type: "token" | "box-self"; readonly id: string; readonly name: string };
  readonly lastAt: string;
  readonly lastOp: string;
  readonly command: {
    readonly text: string;
    readonly execId: string;
    readonly running: boolean;
    readonly output: readonly string[];
  } | null;
  readonly session: string | null;
  readonly note: string | null;
}

export interface AttentionItem {
  readonly kind: string;
  readonly severity: "error" | "warning";
  readonly hostId: string;
  readonly at: string | null;
  readonly subject: string;
  readonly box: { readonly id: string; readonly name: string } | null;
  readonly params: Readonly<Record<string, string | number>>;
}

export interface Overview {
  readonly inProgress: readonly OverviewRow[];
  readonly attention: readonly AttentionItem[];
}

export interface AttentionText {
  readonly key: string;
  readonly params: Readonly<Record<string, string | number>>;
}

export declare const ATTENTION_LABEL: Readonly<Record<string, string>>;

export declare function attentionHref(item: AttentionItem): string;

/** Whether an attention item has a fix MiniBox applies itself once the owner confirms it. */
export declare function canRepair(item: AttentionItem): boolean;

export declare function attentionText(
  item: AttentionItem,
  options?: {
    bytes?: (count: number) => string;
    cpus?: (count: number) => string;
  },
): AttentionText | null;

export declare function pollDelay(overview: Pick<Overview, "inProgress">): number;

export declare function activityByBox(inProgress: readonly OverviewRow[]): Map<string, OverviewRow>;

export declare function scopeToHost<T>(items: readonly T[], host: string, hostOf: (item: T) => string): T[];
