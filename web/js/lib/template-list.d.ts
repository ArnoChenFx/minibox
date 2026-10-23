export interface TemplateRow {
  hostId: string;
  ref: string;
  size: number;
  [key: string]: unknown;
}

/** One template reference with the hosts that hold it, in the order the server listed them. */
export type TemplateCard = TemplateRow & { holders: string[] };

export declare function templateSearchFields(template: TemplateRow, badge: string | undefined): unknown[];
export declare function templateCards(rows: readonly TemplateRow[]): TemplateCard[];
export declare function needsSync(card: { holders: readonly string[] } | undefined, hostId: string): boolean;
export declare function syncSizeMb(card: { size: number }): number;
