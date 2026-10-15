// BigInt fixed-point helpers. Money and prices: scale 6. Ratios: scale 12.
// Rounding is half-even and is applied only when a value is parsed to a
// coarser scale or when an output is formatted.

export const MONEY_SCALE = 6;
export const RATIO_SCALE = 12;

export class CoreInputError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function pow10(n) {
  return 10n ** BigInt(n);
}

/** Integer division of BigInts, rounding half to even. */
export function divRound(num, den) {
  if (den === 0n) throw new CoreInputError('division_by_zero', 'Division by zero.');
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const q = num / den;
  const r = num % den;
  if (r === 0n) return q;
  const ar = r < 0n ? -r : r;
  const twice = ar * 2n;
  const away = twice > den || (twice === den && q % 2n !== 0n);
  if (!away) return q;
  return num < 0n ? q - 1n : q + 1n;
}

const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Parse a decimal string into a BigInt at the given scale (half-even if finer). */
export function parseDecimal(text, scale) {
  if (typeof text !== 'string') throw new CoreInputError('invalid_decimal', 'Decimal must be a string.');
  const m = DECIMAL_RE.exec(text);
  if (!m) throw new CoreInputError('invalid_decimal', `Invalid decimal "${text}".`);
  const frac = m[3] ?? '';
  let n = BigInt(m[2] + frac);
  if (frac.length <= scale) n *= pow10(scale - frac.length);
  else n = divRound(n, pow10(frac.length - scale));
  return m[1] === '-' ? -n : n;
}

export function parseUnits(text) {
  if (typeof text !== 'string' || !/^\d+$/.test(text)) {
    throw new CoreInputError('invalid_units', `Invalid integer units "${text}".`);
  }
  return BigInt(text);
}

/** Format a scaled BigInt with exactly `dp` decimal places (half-even). */
export function formatFixed(value, scale, dp) {
  const r = scale > dp ? divRound(value, pow10(scale - dp)) : value * pow10(dp - scale);
  const neg = r < 0n;
  const abs = neg ? -r : r;
  let digits = abs.toString();
  if (dp > 0) {
    digits = digits.padStart(dp + 1, '0');
    digits = `${digits.slice(0, digits.length - dp)}.${digits.slice(digits.length - dp)}`;
  }
  return neg && r !== 0n ? `-${digits}` : digits;
}

export const formatMoney = (v) => (v === null ? null : formatFixed(v, MONEY_SCALE, 2));
export const formatPerShare = (v) => (v === null ? null : formatFixed(v, MONEY_SCALE, 6));
export const formatPct = (v12) => (v12 === null ? null : formatFixed(v12, RATIO_SCALE, 4));

export function maxBig(a, b) {
  return a > b ? a : b;
}
export function minBig(a, b) {
  return a < b ? a : b;
}
