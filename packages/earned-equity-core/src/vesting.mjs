// Vesting schedule: cumulative floor, remainder lands on the final event.
import { addMonths } from './dates.mjs';
import { parseUnits } from './decimal.mjs';
import { readFact } from './facts.mjs';
import { sortedUnique } from './canonical-json.mjs';

const STEP = Object.freeze({ monthly: 1, quarterly: 3, annual: 12 });

/** Month offsets (from commencement) at which units vest. */
export function vestEventMonths(vesting) {
  const step = STEP[vesting.cadence];
  const T = vesting.totalMonths;
  const K = vesting.cliffMonths;
  if (!step) return [];
  if (T === 0) return [0];
  const out = [];
  for (let m = 0; m <= T; m += 1) if (m % step === 0 && m >= K) out.push(m);
  // The schedule always ends at T so the remainder vests and the sum is exact.
  if (T >= K && !out.includes(T)) out.push(T);
  return out;
}

function accelerationLimitations(vesting) {
  if (vesting.acceleration === 'single_trigger' || vesting.acceleration === 'double_trigger') return ['acceleration_unmodeled'];
  if (vesting.acceleration === 'unknown') return ['acceleration_unknown'];
  return [];
}

/**
 * Fraction of the grant vested on `date` (service assumed to continue through it).
 * @returns {{ num: bigint|null, den: bigint, limitations: string[] }}
 */
export function vestedFractionAt(grant, date) {
  const v = grant.vesting;
  const limitations = accelerationLimitations(v);
  if (!STEP[v.cadence]) {
    return { num: null, den: 1n, limitations: sortedUnique([...limitations, 'vesting_unsupported']) };
  }
  const c = readFact(v.commencementDate, 'commencement_date');
  limitations.push(...c.limitations);
  if (c.value === null) return { num: null, den: 1n, limitations: sortedUnique(limitations) };
  const T = v.totalMonths;
  let last = -1;
  for (const m of vestEventMonths(v)) {
    if (addMonths(c.value, m) <= date) last = m;
    else break;
  }
  let num;
  let den;
  if (last < 0) {
    num = 0n;
    den = 1n;
  } else if (T === 0) {
    num = 1n;
    den = 1n;
  } else {
    num = BigInt(last);
    den = BigInt(T);
  }
  return { num, den, limitations: sortedUnique(limitations) };
}

/** Units vested on `date` as a BigInt (or null) with limitations. */
export function vestedUnitsBigAt(grant, date) {
  const frac = vestedFractionAt(grant, date);
  const u = readFact(grant.units, 'units');
  const limitations = [...frac.limitations, ...u.limitations];
  if (frac.num === null || u.value === null) return { units: null, frac, U: u.value === null ? null : parseUnits(u.value), limitations: sortedUnique(limitations) };
  const U = parseUnits(u.value);
  return { units: (U * frac.num) / frac.den, frac, U, limitations: sortedUnique(limitations) };
}

/** Public API: units vested on `isoDate`, as an integer string or null. */
export function vestedUnitsAt(grant, isoDate) {
  const r = vestedUnitsBigAt(grant, isoDate);
  return { units: r.units === null ? null : r.units.toString(), limitations: r.limitations };
}
