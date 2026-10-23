const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

export const AGE_PATTERN = /^(\d{1,6})([smhdw])$/;

/** A span such as `30d` or `12h` in milliseconds, or null when the text is not a whole number and one unit. */
export function ageMs(text: string): number | null {
  const match = AGE_PATTERN.exec(text);
  if (!match) return null;
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}
