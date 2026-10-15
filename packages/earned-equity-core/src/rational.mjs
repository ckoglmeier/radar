// Exact BigInt rationals. All money arithmetic is exact; rounding happens once, in formatQ.
import { CoreInputError } from './decimal.mjs';

const abs = (x) => (x < 0n ? -x : x);
function gcd(a, b) {
  a = abs(a);
  b = abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1n;
}

export class Q {
  constructor(n, d = 1n) {
    if (d === 0n) throw new CoreInputError('division_by_zero', 'Division by zero.');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d);
    this.n = n / g;
    this.d = d / g;
  }

  static of(text) {
    const m = typeof text === 'string' ? /^(-?)(\d+)(?:\.(\d+))?$/.exec(text) : null;
    if (!m) throw new CoreInputError('invalid_decimal', `Invalid decimal "${text}".`);
    const frac = m[3] ?? '';
    return new Q((m[1] ? -1n : 1n) * BigInt(m[2] + frac), 10n ** BigInt(frac.length));
  }

  static int(x) {
    return new Q(BigInt(x));
  }

  add(o) { return new Q(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return new Q(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { return new Q(this.n * o.n, this.d * o.d); }
  div(o) { return new Q(this.n * o.d, this.d * o.n); }
  cmp(o) {
    const x = this.n * o.d - o.n * this.d;
    return x < 0n ? -1 : x > 0n ? 1 : 0;
  }
  isZero() { return this.n === 0n; }
}

export const ZERO = new Q(0n);

/** Round half-even to `dp` places and format. */
export function formatQ(q, dp) {
  if (q === null) return null;
  const s = 10n ** BigInt(dp);
  const num = q.n * s;
  let r = num / q.d;
  const rem = num % q.d;
  if (rem !== 0n) {
    const twice = abs(rem) * 2n;
    if (twice > q.d || (twice === q.d && r % 2n !== 0n)) r += num < 0n ? -1n : 1n;
  }
  const neg = r < 0n;
  let digits = abs(r).toString().padStart(dp + 1, '0');
  if (dp > 0) digits = `${digits.slice(0, digits.length - dp)}.${digits.slice(digits.length - dp)}`;
  return neg ? `-${digits}` : digits;
}
