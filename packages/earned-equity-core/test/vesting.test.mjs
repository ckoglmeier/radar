import test from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, vestedUnitsAt } from '../index.mjs';
import { f, makeGrant } from './fixtures/index.mjs';

const vesting = (over) => ({ commencementDate: f('2026-01-15'), totalMonths: 48, cliffMonths: 12, cadence: 'monthly', acceleration: 'none', ...over });
const grant = (over = {}, v = {}) => makeGrant({ units: f('48000'), vesting: vesting(v), ...over });

test('addMonths clamps to month end and never chains', () => {
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2024-01-31', 2), '2024-03-31');
  assert.equal(addMonths('2024-01-31', 3), '2024-04-30');
  assert.equal(addMonths('2023-01-31', 1), '2023-02-28');
  assert.equal(addMonths('2024-02-29', 12), '2025-02-28');
  assert.equal(addMonths('2024-02-29', 48), '2028-02-29');
  assert.equal(addMonths('2026-03-15', -3), '2025-12-15');
});

test('day before and day of the cliff', () => {
  const g = grant();
  assert.equal(vestedUnitsAt(g, '2027-01-14').units, '0');
  assert.equal(vestedUnitsAt(g, '2027-01-15').units, '12000');
  assert.equal(vestedUnitsAt(g, '2026-06-01').units, '0');
});

test('month-end clamping from a Jan 31 start', () => {
  const g = grant({ units: f('1200') }, { commencementDate: f('2024-01-31'), totalMonths: 12, cliffMonths: 0 });
  assert.equal(vestedUnitsAt(g, '2024-02-28').units, '0');
  assert.equal(vestedUnitsAt(g, '2024-02-29').units, '100');
  assert.equal(vestedUnitsAt(g, '2024-03-30').units, '100');
  assert.equal(vestedUnitsAt(g, '2024-03-31').units, '200');
  assert.equal(vestedUnitsAt(g, '2024-04-29').units, '200');
  assert.equal(vestedUnitsAt(g, '2024-04-30').units, '300');
});

test('leap day start with annual cadence', () => {
  const g = grant({ units: f('4800') }, { commencementDate: f('2024-02-29'), cadence: 'annual' });
  assert.equal(vestedUnitsAt(g, '2025-02-27').units, '0');
  assert.equal(vestedUnitsAt(g, '2025-02-28').units, '1200');
  assert.equal(vestedUnitsAt(g, '2028-02-28').units, '3600');
  assert.equal(vestedUnitsAt(g, '2028-02-29').units, '4800');
});

test('termination before the cliff vests nothing; partial service vests by month', () => {
  const g = grant();
  assert.equal(vestedUnitsAt(g, '2026-12-31').units, '0'); // service end before the cliff
  assert.equal(vestedUnitsAt(g, '2027-06-15').units, '17000');
  assert.equal(vestedUnitsAt(g, '2027-06-14').units, '16000');
});

test('no cliff, zero units, T = 0', () => {
  assert.equal(vestedUnitsAt(grant({}, { cliffMonths: 0 }), '2026-02-15').units, '1000');
  assert.equal(vestedUnitsAt(grant({ units: f('0') }), '2031-01-15').units, '0');
  const t0 = grant({}, { totalMonths: 0, cliffMonths: 0 });
  assert.equal(vestedUnitsAt(t0, '2026-01-14').units, '0');
  assert.equal(vestedUnitsAt(t0, '2026-01-15').units, '48000');
});

test('quarterly and annual cadence', () => {
  const q = grant({}, { cadence: 'quarterly' });
  assert.equal(vestedUnitsAt(q, '2027-01-15').units, '12000');
  assert.equal(vestedUnitsAt(q, '2027-03-15').units, '12000');
  assert.equal(vestedUnitsAt(q, '2027-04-15').units, '15000');
  const a = grant({}, { cadence: 'annual' });
  assert.equal(vestedUnitsAt(a, '2027-01-15').units, '12000');
  assert.equal(vestedUnitsAt(a, '2028-01-14').units, '12000');
  assert.equal(vestedUnitsAt(a, '2028-01-15').units, '24000');
});

test('performance and other cadences are unsupported', () => {
  for (const cadence of ['performance', 'other']) {
    const r = vestedUnitsAt(grant({}, { cadence }), '2030-01-15');
    assert.equal(r.units, null);
    assert.ok(r.limitations.includes('vesting_unsupported'));
  }
});

test('acceleration codes', () => {
  assert.deepEqual(vestedUnitsAt(grant(), '2027-01-15').limitations, []);
  for (const a of ['single_trigger', 'double_trigger']) {
    assert.ok(vestedUnitsAt(grant({}, { acceleration: a }), '2027-01-15').limitations.includes('acceleration_unmodeled'));
  }
  assert.ok(vestedUnitsAt(grant({}, { acceleration: 'unknown' }), '2027-01-15').limitations.includes('acceleration_unknown'));
});

test('missing or illustrative inputs give null with limitations', () => {
  assert.deepEqual(vestedUnitsAt(grant({ units: { value: null, state: 'missing' } }), '2030-01-15'), { units: null, limitations: ['units_missing'], errors: [] });
  assert.ok(vestedUnitsAt(grant({}, { commencementDate: { value: null, state: 'missing' } }), '2030-01-15').limitations.includes('commencement_date_missing'));
  assert.ok(vestedUnitsAt(grant({ units: f('100', 'illustrative') }), '2030-01-15').limitations.includes('illustrative_value_ignored:units'));
  assert.ok(vestedUnitsAt(grant({ units: f('100', 'conflicting') }), '2030-01-15').limitations.includes('units_conflicting'));
});

test('cumulative floor: remainder lands on the final event, total equals U', () => {
  for (const [U, T, K, cadence] of [[1000, 48, 12, 'monthly'], [1001, 36, 0, 'monthly'], [7, 10, 0, 'quarterly'], [999, 48, 12, 'annual']]) {
    const g = grant({ units: f(String(U)) }, { totalMonths: T, cliffMonths: K, cadence });
    const end = addMonths('2026-01-15', T);
    assert.equal(vestedUnitsAt(g, end).units, String(U), `${U}/${T}/${cadence}`);
    let prev = 0;
    for (let m = 0; m <= T; m += 1) {
      const v = Number(vestedUnitsAt(g, addMonths('2026-01-15', m)).units);
      assert.ok(v >= prev && v <= U);
      prev = v;
    }
  }
  // Monthly floor values on a non-divisible grant.
  const g = grant({ units: f('1000') }, { cliffMonths: 0 });
  assert.equal(vestedUnitsAt(g, '2026-02-15').units, '20'); // floor(1000/48)
  assert.equal(vestedUnitsAt(g, '2026-03-15').units, '41'); // floor(2000/48)
  assert.equal(vestedUnitsAt(g, '2030-01-15').units, '1000');
});
