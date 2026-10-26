/** The security profiles a box can hold, in the order the console offers them. */
export declare const SECURITY_PROFILES: readonly string[];

/** What an egress form holds. */
export interface EgressDraft {
  mode: string;
  presets: string[];
  /** The extra hosts as typed: one per line, or separated by commas or spaces. */
  domains: string;
}

/** The `egress` object a staged change names. */
export interface EgressField {
  mode: string;
  presets?: string[];
  domains?: string[];
}

export interface ProfileField {
  profile: string;
}

export interface TemplateField {
  template: string;
}

/** The egress a box holds, as its card shows it. `allow` is what the proxy enforces and is not part of a draft. */
export interface BoxEgressView {
  mode: string;
  presets?: string[];
  domains?: string[];
  allow?: string[];
}

export declare function egressDraftOf(egress?: BoxEgressView | null): EgressDraft;
export declare function egressFieldOf(draft: EgressDraft): EgressField;
export declare function sameEgressDraft(a: EgressDraft, b: EgressDraft): boolean;
export declare function profileFieldOf(profile: string): ProfileField | null;
export declare function templateFieldOf(ref: unknown): TemplateField | { problem: string };
export declare function sameTemplate(box: { template?: string } | null, ref: unknown): boolean;
