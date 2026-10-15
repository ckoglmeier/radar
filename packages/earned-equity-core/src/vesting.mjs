// Vesting schedule: cumulative floor, remainder lands on the final event.
import { addMonths, isValidIsoDate } from './dates.mjs';
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

/** Structural errors for a grant's vesting block. `base` is the path prefix. */
export function vestingErrors(grant, base) {
  const errors = [];
  const v = grant?.vesting;
  if (!v) return errors;
  const c = v.commencementDate;
  if (c?.state === 'not_applicable') errors.push({ path: `${base}.vesting.commencementDate`, code: 'not_applicable_not_allowed:commencement_date', message: 'commencementDate cannot be not_applicable.' });
  else {
    const r = readFact(c, 'commencement_date');
    if (r.value !== null && !isValidIsoDate(r.value)) errors.push({ path: `${base}.vesting.commencementDate`, code: 'invalid_date', message: 'commencementDate is not a valid calendar date.' });
  }
  if (v.totalMonths > 0 && v.cliffMonths > v.totalMonths) {
    errors.push({ path: `${base}.vesting.cliffMonths`, code: 'vesting_cliff_exceeds_term', message: 'cliffMonths exceeds totalMonths.' });
  }
  return errors;
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
  if (v.totalMonths > 0 && v.totalMonths >= v.cliffMonths && v.totalMonths % STEP[v.cadence] !== 0) {
    limitations.push('vesting_final_event_off_cadence');
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

/** Public API: units vested on `isoDate`, as an integer string or null. */
export function vestedUnitsAt(grant, isoDate) {
  const errors = [];
  if (!isValidIsoDate(isoDate)) errors.push({ path: 'isoDate', code: 'invalid_date', message: 'Query date is not a valid calendar date.' });
  if (!grant || typeof grant !== 'object' || !grant.vesting) errors.push({ path: 'grant.vesting', code: 'invalid_grant', message: 'grant.vesting is required.' });
  else errors.push(...vestingErrors(grant, 'grant'));
  const u = grant?.units;
  if (u?.state === 'not_applicable') errors.push({ path: 'grant.units', code: 'not_applicable_not_allowed:units', message: 'units cannot be not_applicable.' });
  if (errors.length) return { units: null, limitations: [], errors };
  const frac = vestedFractionAt(grant, isoDate);
  const ur = readFact(grant.units, 'units');
  const limitations = sortedUnique([...frac.limitations, ...ur.limitations]);
  if (frac.num === null || ur.value === null) return { units: null, limitations, errors: [] };
  return { units: ((parseUnits(ur.value) * frac.num) / frac.den).toString(), limitations, errors: [] };
}
