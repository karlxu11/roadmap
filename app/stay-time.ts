export const MIN_STAY_MINUTES = 30;
export const MAX_STAY_MINUTES = 6 * 60;

export function normalizedStayMinutes(value: unknown) {
  const minutes = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.min(MAX_STAY_MINUTES, Math.max(MIN_STAY_MINUTES, Math.round(minutes)));
}
