// Pure calendar arithmetic on YYYY-MM-DD strings. No clocks, no time zones.
import { CoreInputError } from './decimal.mjs';

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

export function parseIsoDate(text) {
  const m = typeof text === 'string' ? ISO_RE.exec(text) : null;
  if (!m) throw new CoreInputError('invalid_date', `Invalid ISO date "${text}".`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
    throw new CoreInputError('invalid_date', `Invalid calendar date "${text}".`);
  }
  return { y, m: mo, d };
}

export function isValidIsoDate(text) {
  try {
    parseIsoDate(text);
    return true;
  } catch {
    return false;
  }
}

const pad = (n, w) => String(n).padStart(w, '0');
export const formatIsoDate = ({ y, m, d }) => `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;

// Days since 1970-01-01 (proleptic Gregorian).
function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: m <= 2 ? y + 1 : y, m, d };
}

/** Keep the day-of-month, clamped to the target month's last day. Never chained. */
export function addMonths(iso, n) {
  if (!Number.isInteger(n)) throw new CoreInputError('invalid_months', `Month count must be an integer, got ${n}.`);
  const { y, m, d } = parseIsoDate(iso);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  return formatIsoDate({ y: ny, m: nm, d: Math.min(d, daysInMonth(ny, nm)) });
}

export function addDays(iso, n) {
  const { y, m, d } = parseIsoDate(iso);
  return formatIsoDate(civilFromDays(daysFromCivil(y, m, d) + n));
}

/** Whole months from a to b (b >= a), counting a month only once its anniversary is reached. */
export function monthsBetween(a, b) {
  const pa = parseIsoDate(a);
  const pb = parseIsoDate(b);
  let n = (pb.y - pa.y) * 12 + (pb.m - pa.m);
  if (addMonths(a, n) > b) n -= 1;
  return n;
}

export const minDate = (a, b) => (a < b ? a : b);
