/** The tiers a box can name. Mirrors `EGRESS_MODES` in src/egress/policy.ts. */
export declare const EGRESS_TIERS: string[];

/** The presets proxy-only offers. Mirrors `EGRESS_PRESETS` in src/egress/policy.ts. */
export declare const EGRESS_PRESETS: string[];

/** The reasons the proxy gives for a refused connection. Mirrors the proxy program in src/egress/proxy.ts. */
export declare const DENIAL_REASONS: string[];

export interface EgressFormInput {
  mode?: string;
  presets?: string[];
  domains?: string;
}

/** The `egress` a create body names, as the REST API takes it. */
export interface EgressRequest {
  mode: string;
  presets?: string[];
  domains?: string[];
}

export declare function domainsOf(text?: string | null): string[];
export declare function egressRequestOf(form: EgressFormInput): EgressRequest | undefined;
export declare function tierKey(mode: string): string;
export declare function tierHintKey(mode: string): string;
export declare function presetKey(preset: string): string;
export declare function presetHintKey(preset: string): string;
export declare function denialReasonKey(reason: string): string;
