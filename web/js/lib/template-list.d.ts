export interface TemplateRow {
  hostId: string;
  ref: string;
  size: number;
  [key: string]: unknown;
}

/** One template reference with the hosts that hold it, in the order the server listed them. */
export type TemplateCard = TemplateRow & { holders: string[] };

/** One detail row a template card shows: which i18n key labels it, and the text to show. */
export interface TemplateDetailRow {
  key: "tp.postCreate" | "tp.ports";
  text: string;
}

/** A template's setup as the template list reports it. */
export interface TemplateSetup {
  postCreate?: string[];
  forwardPorts?: number[];
}

/** An official template from GET /api/templates/official. */
export interface OfficialRow {
  name: string;
  ref: string;
  description: string;
  base: string;
}

/** An official template no host holds yet: a card with no holder, and no size or creation time. */
export interface UnbuiltCard extends OfficialRow {
  buildKind: "official";
  tags: [];
  size: null;
  holders: [];
}

export declare function templateSearchFields(template: TemplateRow | UnbuiltCard, badge: string | undefined): unknown[];
export declare function templateDetailRows(template: TemplateSetup): TemplateDetailRow[];
export declare function templateCards(rows: readonly TemplateRow[]): TemplateCard[];
export declare function withOfficialCards(
  cards: readonly TemplateCard[],
  official: readonly OfficialRow[],
): (TemplateCard | UnbuiltCard)[];
export declare function isUnbuilt(card: { holders: readonly string[] } | undefined): boolean;
export declare function needsSync(card: { holders: readonly string[] } | undefined, hostId: string): boolean;
export declare function syncSizeMb(card: { size: number }): number;
