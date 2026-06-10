/**
 * Parse AngelList money string like "$1,000" or "$13,912.69" to a number.
 * Returns null for empty strings, "Locked", or unparseable values.
 */
export function parseMoney(str) {
  if (!str || str === 'Locked' || str.trim() === '') return null;
  const cleaned = str.replace(/[$,]/g, '').trim();
  // Handle currency symbols like £
  const num = parseFloat(cleaned.replace(/[^0-9.\-]/g, ''));
  return isNaN(num) ? null : num;
}

/**
 * Parse AngelList date string "MM/DD/YYYY" to "YYYY-MM-DD".
 */
export function parseDate(str) {
  if (!str || str.trim() === '') return null;
  const parts = str.trim().split('/');
  if (parts.length !== 3) return null;
  const [month, day, year] = parts;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * Parse percentage string like "20%" to a number (20).
 * Returns null for empty/missing values.
 */
export function parsePercent(str) {
  if (!str || str.trim() === '') return null;
  const num = parseFloat(str.replace('%', ''));
  return isNaN(num) ? null : num;
}

/**
 * Parse multiple value — could be a number or empty.
 */
export function parseMultiple(str) {
  if (!str || str.trim() === '') return null;
  const num = parseFloat(str);
  return isNaN(num) ? null : num;
}

/**
 * Format a number as currency for display.
 */
export function formatMoney(num) {
  if (num == null) return '—';
  return '$' + Number(num).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Format a multiple for display.
 */
export function formatMultiple(num) {
  if (num == null) return '—';
  return Number(num).toFixed(2) + 'x';
}

/**
 * Format IRR as a percentage for display.
 * Input: decimal (e.g. 0.152 → "15.2%"), null → "—"
 */
export function formatIRR(num) {
  if (num == null) return '—';
  const pct = Number(num) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}
