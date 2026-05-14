/** Jakarta is always UTC+7 (no DST). */
const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

function toJakartaDate(date: Date): Date {
  return new Date(date.getTime() + JAKARTA_OFFSET_MS);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Returns the current time as an ISO 8601 string with +07:00 offset.
 * Example: "2026-05-14T12:02:24+07:00"
 */
export function formatIsoWithJakarta(date: Date = new Date()): string {
  const j = toJakartaDate(date);
  const year = j.getUTCFullYear();
  const month = pad(j.getUTCMonth() + 1);
  const day = pad(j.getUTCDate());
  const hour = pad(j.getUTCHours());
  const minute = pad(j.getUTCMinutes());
  const second = pad(j.getUTCSeconds());
  return `${year}-${month}-${day}T${hour}:${minute}:${second}+07:00`;
}

/**
 * Formats a Date as HH:MM:SS in Jakarta timezone.
 * Example: "12:02:24"
 */
export function formatTime(date: Date): string {
  const j = toJakartaDate(date);
  return `${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}:${pad(j.getUTCSeconds())}`;
}
