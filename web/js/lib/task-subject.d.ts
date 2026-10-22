export interface SubjectSource {
  readonly op: string;
  readonly subject?: string;
  readonly result?: { readonly id?: string; readonly [field: string]: unknown } | null;
  readonly error?: { readonly params?: { readonly id?: string; readonly [field: string]: unknown } } | null;
}

export declare function subjectOf(task: SubjectSource): string;
