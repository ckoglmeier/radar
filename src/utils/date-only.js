// Calendar-date helpers that do not shift across time zones or DST.
//
// pg and PGlite deliver Postgres DATE values as JS Dates at LOCAL midnight. Reading
// those with toISOString() (UTC) moves the date back a day east of UTC. A Date at
// exactly local midnight is therefore read from its local calendar fields; any other
// Date is a timestamp and keeps its UTC date (unchanged behavior, so stored hashes and
// keys computed west of UTC stay identical).
// Arithmetic on YYYY-MM-DD strings is done entirely in UTC, so DST never moves a day.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const pad = number => String(number).padStart(2, '0');

const atLocalMidnight = date => date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0 && date.getMilliseconds() === 0;

export function dateOnly(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return atLocalMidnight(value)
      ? `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
      : value.toISOString().slice(0, 10);
  }
  const text = String(value);
  if (ISO_DATE.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : dateOnly(parsed);
}

const utc = iso => new Date(`${dateOnly(iso)}T00:00:00Z`);
const iso = date => date.toISOString().slice(0, 10);

export function addDaysIso(value, days) {
  const date = utc(value);
  date.setUTCDate(date.getUTCDate() + days);
  return iso(date);
}

export function addYearsIso(value, years) {
  const date = utc(value);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return iso(date);
}

export function daysBetweenIso(start, end) {
  return Math.round((utc(end) - utc(start)) / 86_400_000);
}

// Today's calendar date where the person is (not UTC): east of UTC the UTC date is still
// yesterday in the morning; west of UTC it is already tomorrow in the evening.
export function localToday(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
