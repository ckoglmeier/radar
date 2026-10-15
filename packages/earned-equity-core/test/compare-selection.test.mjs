import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOffer, compareOffers, validateSelection } from '../index.mjs';
import { run } from './helpers.mjs';
import { f, makeGrant, makeGroup, makeOffer, makeOpportunity, makeScenario, makeScenarioSet } from './fixtures/index.mjs';

const group = makeGroup();
const offer1 = makeOffer();
const offer2 = makeOffer({ id: 'rev-2', opportunityId: 'opp-2', grants: [makeGrant({ units: f('90000'), strikePrice: f('0.25') })] });
const set2 = makeScenarioSet([makeScenario()], { id: 'set-2', offerRevisionId: 'rev-2' });
const opp1 = makeOpportunity();
const opp2 = makeOpportunity({ id: 'opp-2', companyName: 'Contoso Synthetic' });
const result1 = run();
const result2 = run({ offer: offer2, set: set2 });
const entries = [
  { opportunity: opp1, offerRevision: offer1, result: result1 },
  { opportunity: opp2, offerRevision: offer2, result: result2 },
];

function keysOf(v, acc = []) {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, acc));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { acc.push(k); keysOf(x, acc); }
  return acc;
}

test('compareOffers lists known values and crossovers without ranking', () => {
  const out = compareOffers({ group, entries });
  assert.equal(out.ok, true);
  const row = out.comparison.rows.find((r) => r.kind === 'base');
  assert.equal(row.offers.length, 2);
  assert.equal(row.offers[0].cashSacrifice, '200000.00');
  assert.equal(row.offers[0].breakEvenCommonPrice, '5.166667');
  assert.equal(out.comparison.crossovers.length, 1);
  assert.equal(out.comparison.crossovers[0].a.breakEvenCommonPrice, '5.166667');
  assert.equal(out.comparison.crossovers[0].b.breakEvenCommonPrice, '2.472222');
  assert.equal(out.comparison.crossovers[0].breakEvenDifference, '-2.694445');
});

test('compareOffers output has no rank, score or winner fields', () => {
  const out = compareOffers({ group, entries });
  for (const k of keysOf(out)) assert.ok(!/rank|score|winner|best|overall|composite/i.test(k), `unexpected key ${k}`);
});

test('basis mismatch fails', () => {
  for (const g of [makeGroup({ startDate: '2026-02-15' }), makeGroup({ horizonMonths: 36 }), makeGroup({ discountRateAnnual: '0.1' })]) {
    const bad = [entries[0], { ...entries[1], group: g }];
    const out = compareOffers({ group, entries: bad });
    assert.equal(out.ok, false);
    assert.equal(out.errors[0].code, 'comparison_basis_mismatch');
  }
  const eur = compareOffers({ group, entries: [entries[0], { ...entries[1], result: { ...result2, currency: 'EUR' } }] });
  assert.equal(eur.ok, false);
  assert.equal(eur.errors[0].code, 'comparison_basis_mismatch');
});

test('missing material inputs are listed as unresolved', () => {
  const r = run({ offer: makeOffer({ grants: [makeGrant({ strikePrice: { value: null, state: 'missing' } })] }) });
  const out = compareOffers({ group, entries: [{ opportunity: opp1, offerRevision: offer1, result: r }] });
  assert.ok(out.comparison.unresolved.some((u) => u.code === 'strike_price_missing'));
  assert.ok(out.comparison.unresolved.some((u) => u.code.startsWith('net_pre_tax_unavailable')));
});

const revs = [
  makeOffer({ id: 'r1', opportunityId: 'opp-1' }),
  makeOffer({ id: 'r1b', opportunityId: 'opp-1', supersedesRevisionId: 'r1' }),
  makeOffer({ id: 'r2', opportunityId: 'opp-2' }),
];
const sel = (ids, over = {}) => validateSelection({ group, opportunities: [opp1, opp2], offerRevisions: revs, selectedOfferRevisionIds: ids, ...over });
const codes = (r) => r.errors.map((e) => e.code);

test('validateSelection: one selection is clean', () => {
  const r = sel(['r1b']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
});

test('validateSelection: two employment selections', () => {
  const r = sel(['r1b', 'r2']);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['employment_multiple_primary']);
  assert.ok(r.warnings.some((w) => w.code === 'correlated_concentration'));
});

test('validateSelection: two revisions of one opportunity, and a superseded one', () => {
  const r = sel(['r1', 'r1b']);
  assert.ok(codes(r).includes('same_opportunity_revisions'));
  assert.ok(codes(r).includes('superseded_revision'));
  assert.deepEqual(codes(sel(['r1'])), ['superseded_revision']);
});

test('validateSelection: declined or expired opportunities are not selectable', () => {
  for (const lifecycle of ['declined', 'expired', 'withdrawn']) {
    const r = sel(['r2'], { opportunities: [opp1, makeOpportunity({ id: 'opp-2', lifecycle })] });
    assert.deepEqual(codes(r), ['opportunity_not_selectable']);
  }
});

test('validateSelection: advisory capacity warnings do not block', () => {
  const advisory = makeGroup({ mode: 'advisory', capacity: { maxSelections: 1, hoursPerMonth: '10', exerciseFundingCapacity: '1000' } });
  const o1 = makeOpportunity({ relationship: 'advisory', commitmentHoursPerMonth: '6' });
  const o2 = makeOpportunity({ id: 'opp-2', relationship: 'advisory', commitmentHoursPerMonth: '6' });
  const r = validateSelection({
    group: advisory, opportunities: [o1, o2], offerRevisions: revs, selectedOfferRevisionIds: ['r1b', 'r2'],
    results: { r1b: result1, r2: { scenarios: [{ maxCumulativeFundingNeed: '5000.00' }] } },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings.map((w) => w.code).sort(), ['capacity_hours_exceeded', 'capacity_selection_exceeded', 'correlated_concentration', 'exercise_funding_capacity_exceeded']);
});

test('validateSelection: unknown ids are errors', () => {
  assert.deepEqual(codes(sel(['nope'])), ['unknown_offer_revision']);
});

test('compare still works from calculateOffer output shape', () => {
  assert.equal(calculateOffer({ group, offerRevision: offer1, scenarioSet: makeScenarioSet() }).ok, true);
});
