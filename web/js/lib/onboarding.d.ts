/** The id of a guide step: the base template, a first box, or the agent's connection. */
export type OnboardingStepId = "template" | "box" | "agent";

/** The client the agent step writes its MCP configuration for. */
export type ClientId = "claude-code" | "codex" | "other";

/** One step of the guide, as the page draws it. */
export interface OnboardingStep {
  readonly id: OnboardingStepId;
  readonly done: boolean;
  /** The one step that asks for something now: the first one that is not done. */
  readonly open: boolean;
  /** A step after the open one, which stays shut until the steps before it are done. */
  readonly locked: boolean;
}

/** What this browser saved about the guide. Neither flag is the judge: a console with a box shows no guide either way. */
export interface OnboardingState {
  readonly dismissed: boolean;
  readonly done: boolean;
  readonly client: ClientId | "";
}

/** What the base template's step shows. `unknown` is the state before GET /api/templates answers. */
export interface BaseTemplateState {
  readonly status: "unknown" | "built" | "missing";
  readonly ref: string;
  /** The hosts that hold the base template, empty when none does. */
  readonly hosts: readonly string[];
  readonly buildable: boolean;
  readonly reason: string;
}

/** A row of GET /api/templates, of which the step reads the reference and the host. */
export interface TemplateRow {
  readonly ref: string;
  readonly hostId: string;
}

/** The part of GET /api/templates the guide reads. */
export interface TemplateList {
  readonly baseTemplate?: string;
  readonly templates?: readonly TemplateRow[];
}

/** One preset of GET /api/tokens/presets. */
export interface TokenPreset {
  readonly name: string;
  readonly scopes: readonly string[];
  readonly boxes?: string;
}

/** The part of GET /api/tokens/presets the guide reads. */
export interface TokenCatalog {
  readonly presets?: readonly TokenPreset[];
}

/** The body of POST /api/tokens the agent step sends. */
export interface TokenRequest {
  readonly name: string;
  readonly preset: string;
}

/** The MCP configuration the agent step copies: `json` for a JSON client, `toml` for Codex. */
export interface McpSnippet {
  readonly kind: "json" | "toml";
  /** The file the snippet goes in, or the top-level key for a client whose file this does not name. */
  readonly path: string;
  readonly text: string;
}

export declare const ONBOARDING_STEPS: readonly OnboardingStepId[];

export declare const CLIENT_IDS: readonly ClientId[];

export declare const SERVER_NAME: string;

export declare const ONBOARDING_STORAGE_KEY: string;

export declare function onboardingShown(options: {
  boxes: readonly unknown[] | null | undefined;
  state: OnboardingState | null | undefined;
  /** Whether this page view already showed the guide while there was no box. */
  inProgress?: boolean;
}): boolean;

export declare function onboardingSteps(options: {
  templates: TemplateList | null;
  boxes: readonly unknown[] | null | undefined;
  agentDone?: boolean;
}): readonly OnboardingStep[];

export declare function baseTemplateState(templates: TemplateList | null): BaseTemplateState;

export declare function isBaseBuilt(templates: TemplateList | null): boolean;

export declare function defaultPreset(client: ClientId | string, catalog: TokenCatalog | null | undefined): string;

export declare const TOKEN_NAME_MAX: number;

export declare function tokenName(client: ClientId | string, taken?: readonly string[]): string;

export declare function tokenRequest(draft: {
  client: ClientId | string;
  preset: string;
  taken?: readonly string[];
}): TokenRequest;

export declare function mcpSnippet(options: {
  client: ClientId | string;
  origin: string | null | undefined;
  secret: string | null | undefined;
}): McpSnippet;

export declare function loadOnboardingState(): OnboardingState;

export declare function saveOnboardingState(patch: Partial<OnboardingState>): OnboardingState;
