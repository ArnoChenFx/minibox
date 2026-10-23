export const PAGE_SIZE: number;
export const CATEGORIES: readonly string[];
export interface ActivityFilters {
  readonly box?: string;
  readonly category?: string;
  readonly status?: string;
  readonly principal?: string;
  readonly reads?: boolean;
}
export function eventsQuery(filters: ActivityFilters, cursor?: number | null): string;
