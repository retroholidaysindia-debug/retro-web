/**
 * Text helpers shared by the engine. Kept separate from the ETL's
 * `normalise.ts` so nothing in the runtime bundle pulls in Node built-ins.
 */

/** Case/accent/punctuation-insensitive comparison key. */
export function normaliseKey(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019'`\u00b4]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function formatInr(value: number): string {
  return `₹${Math.round(value).toLocaleString("en-IN")}`;
}

/** "9h 20m" / "45m" / "1d 4h" — journey times, not clock times. */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total}m`;
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}
