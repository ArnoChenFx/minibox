export declare const TARGET_KINDS: readonly ["s3", "sftp", "webdav"];

export declare const KIND_FIELDS: Readonly<Record<string, readonly string[]>>;

export interface TargetForm {
  kind: string;
  name?: string | null;
  path?: string | null;
  [field: string]: string | null | undefined;
}

export interface TargetBodyOptions {
  named?: boolean;
  fingerprint?: string;
}

export declare function targetBody(form: TargetForm, options?: TargetBodyOptions): Record<string, unknown>;
