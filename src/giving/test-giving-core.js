// Pure giving contracts, checked against the fictional Rivera household
// (~/daily-lark/RADAR_GIVING_SYNTHETIC_EXAMPLE.md).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildReport, shiftMonths, trailingWindows } from './report.js';
import { assertRequestTransition, pledgeOutstanding, requestPaymentState } from './lifecycle.js';
import { forwardPlan, scenario, validateBudget } from './budget.js';
import { groupLikelySameGift, normalizeEin, suggestGiftMatches } from './matching.js';
import { isDismissed, lensHash, validateLens, validateLensDraft } from './lens.js';
import { parseGivingImport } from './import.js';

const gift = (id, org, cents, paid_on, extra = {}) => ({
  id, organization_id: org, organization_name: org, purpose: null, amount_cents: cents, currency: 'USD',
  paid_on, member_id: 'alex', vehicle: 'direct', voided: false, ...extra,
});

const gifts = [
  gift('G0', 'northside', 75000, '2025-10-16'), // prior-window boundary
  gift('G1', 'maple', 100000, '2025-12-10', { purpose: 'General operating' }),
  gift('G2', 'northside', 250000, '2026-02-01', { vehicle: 'daf_grant' }),
  gift('G3', 'harbor', 60000, '2026-03-01'),
  gift('G4', 'maple', 50000, '2026-06-01', { purpose: 'Summer reading' }),
  gift('G5', 'maple', 100000, '2026-09-01', { purpose: 'Capital campaign', pledge_id: 'P1' }),
  gift('G6', 'river', 25000, null),
  gift('G7', 'coastal', 40000, '2026-10-16', { member_id: 'sam' }), // current-window boundary
  gift('G8', 'maple', 100000, '2025-03-10'),
  gift('G9', 'harbor', 60000, '2025-02-14'),
  gift('GV', 'harbor', 99900, '2026-05-01', { voided: true }),
];
const refunds = [{ id: 'R1', gift_id: 'G3', amount_cents: 10000, refunded_on: '2026-03-20' }];

// ── Windows ──────────────────────────────────────────────────────────────
assert.deepEqual(trailingWindows('2026-10-16'), {
  current: { after: '2025-10-16', through: '2026-10-16' },
  prior: { after: '2024-10-16', through: '2025-10-16' },
});
assert.equal(shiftMonths('2024-02-29', -12), '2023-02-28');
assert.equal(shiftMonths('2026-03-31', -1), '2026-02-28');
assert.throws(() => trailingWindows('2026-02-30'));

// ── Report ───────────────────────────────────────────────────────────────
const causes = [
  { id: 'c-lit', label: 'Childhood literacy', gift_ids: ['G1', 'G4', 'G5'] },
  { id: 'c-food', label: 'Local food security', gift_ids: ['G2'] },
];
const report = buildReport({ asOf: '2026-10-16', gifts, refunds, causes });
assert.deepEqual(report.totals, [{ currency: 'USD', gross_cents: 600000, refunds_cents: 10000, net_cents: 590000 }]);
assert.deepEqual(report.prior_totals, [{ currency: 'USD', gross_cents: 235000, refunds_cents: 0, net_cents: 235000 }]);
assert.deepEqual(report.change, [{ currency: 'USD', net_change_cents: 355000 }]);
assert.deepEqual(report.unknown_date_queue, ['G6']);
const maple = report.by_organization.find(org => org.organization_id === 'maple');
assert.equal(maple.totals[0].net_cents, 250000);
assert.equal(maple.purposes.length, 3, 'three purposes at one organization stay separate');
assert.equal(report.by_organization.find(org => org.organization_id === 'harbor').totals[0].net_cents, 50000);
// Prior-window giving per organization, and whether each was new, repeated or not repeated.
const harbor = report.by_organization.find(org => org.organization_id === 'harbor');
assert.equal(harbor.prior_totals[0].net_cents, 60000);
assert.equal(harbor.status, 'repeat');
assert.equal(report.by_organization.find(org => org.organization_id === 'coastal').status, 'new');
assert.equal(report.by_organization.find(org => org.organization_id === 'northside').prior_totals[0].net_cents, 75000);
const lapsed = buildReport({ asOf: '2026-10-16', gifts: [gift('L1', 'lapsed', 1000, '2025-06-01')] });
assert.equal(lapsed.by_organization[0].status, 'prior_only');
assert.deepEqual(lapsed.by_organization[0].totals, []);
assert.equal(report.by_cause.find(c => c.cause_id === 'c-lit').totals[0].net_cents, 250000);
assert.deepEqual(report.unassigned_to_cause.sort(), ['G3', 'G7']);
assert.equal(report.by_member.find(m => m.member_id === 'sam').totals[0].net_cents, 40000);
assert.equal(report.mixed_currencies, false);
// Aging out: a month later, G1 (2025-12-10) is still in, the 2025-10-16 boundary gift is gone from prior.
const later = buildReport({ asOf: '2026-12-11', gifts, refunds });
assert.equal(later.totals[0].net_cents, 490000, 'G1 aged out of the window');
// Mixed currencies are never summed together.
const mixed = buildReport({ asOf: '2026-10-16', gifts: [...gifts, gift('GE', 'eu', 1000, '2026-05-05', { currency: 'EUR' })], refunds });
assert.equal(mixed.mixed_currencies, true);
assert.deepEqual(mixed.totals.map(t => t.currency), ['EUR', 'USD']);
assert.equal(mixed.totals.find(t => t.currency === 'USD').net_cents, 590000);

// ── Lifecycle ────────────────────────────────────────────────────────────
assertRequestTransition('requested', 'approved');
assertRequestTransition('approved', 'pledged');
assertRequestTransition('deferred', 'requested');
assert.throws(() => assertRequestTransition('approved', 'paid'), /Unknown request status/);
assert.throws(() => assertRequestTransition('cancelled', 'requested'));
assert.throws(() => assertRequestTransition('pledged', 'approved'));
const pledge = { id: 'P1', total_cents: 300000, status: 'active' };
assert.deepEqual(pledgeOutstanding(pledge, [gifts[5]]), { paid_cents: 100000, outstanding_cents: 200000 });
assert.deepEqual(pledgeOutstanding({ ...pledge, status: 'cancelled' }, [gifts[5]]), { paid_cents: 100000, outstanding_cents: 0 });
assert.equal(requestPaymentState({ decided_cents: 250000 }, []).state, 'unpaid');
assert.equal(requestPaymentState({ decided_cents: 250000 }, [gift('x', 'harbor', 100000, '2026-11-01')]).state, 'partially_paid');
assert.equal(requestPaymentState({ decided_cents: 250000 }, [gift('x', 'harbor', 250000, '2026-11-20')]).state, 'paid_in_full');

// ── Budget ───────────────────────────────────────────────────────────────
const budget = validateBudget({
  starts_on: '2026-10-17', ends_on: '2027-10-16', mode: 'custom', amount_cents: 800000,
  planned: [{ organization_id: 'maple', amount_cents: 100000 }, { organization_id: 'northside', amount_cents: 250000 }],
});
const plan = forwardPlan({ budget, gifts, pledges: [pledge] });
assert.equal(plan.committed_cents, 200000);
assert.equal(plan.planned_remaining_cents, 350000);
assert.equal(plan.paid_in_period_cents, 0);
assert.equal(plan.unallocated_cents, 250000, 'trailing total is not subtracted from the forward budget');
const harborAsk = scenario(plan, { amount_cents: 500000, organization_id: 'harbor' });
assert.equal(harborAsk.over_budget_cents, 250000);
assert.equal(scenario(plan, { amount_cents: 250000, organization_id: 'harbor' }).unallocated_after_cents, 0);
assert.equal(scenario(plan, { amount_cents: 250000, organization_id: 'northside', already_counted_cents: 250000 }).increment_cents, 0);
// Paying the Harbor gift in-period moves it from unallocated capacity to paid.
const paidPlan = forwardPlan({ budget, gifts: [...gifts, gift('G10', 'harbor', 250000, '2026-11-20')], pledges: [pledge] });
assert.equal(paidPlan.paid_in_period_cents, 250000);
assert.equal(paidPlan.unallocated_cents, 0);
// Paying a planned org reduces its planned remainder instead of double counting.
const mapleRenewal = forwardPlan({ budget, gifts: [...gifts, gift('G11', 'maple', 100000, '2026-12-01')], pledges: [pledge] });
assert.equal(mapleRenewal.planned_remaining_cents, 250000);
assert.equal(mapleRenewal.unallocated_cents, 250000);
// Zero and skipped budgets.
assert.equal(forwardPlan({ budget: validateBudget({ starts_on: '2026-10-17', ends_on: '2027-10-16', mode: 'custom', amount_cents: 0 }), gifts: [], pledges: [] }).unallocated_cents, 0);
const skipped = forwardPlan({ budget: validateBudget({ starts_on: '2026-10-17', ends_on: '2027-10-16', mode: 'skipped', amount_cents: null }), gifts: [], pledges: [] });
assert.equal(skipped.unallocated_cents, null);
assert.throws(() => validateBudget({ starts_on: '2026-10-17', ends_on: '2027-10-16', mode: 'skipped', amount_cents: null, planned: [{ organization_id: 'x', amount_cents: 1 }] }));
assert.throws(() => validateBudget({ starts_on: '2027-10-16', ends_on: '2026-10-17', mode: 'custom', amount_cents: 1 }));

// ── Matching ─────────────────────────────────────────────────────────────
assert.equal(normalizeEin('12-3456789'), '123456789');
assert.equal(normalizeEin('123'), null);
const withEin = gifts.map(g => ({ ...g, ein: g.organization_id === 'northside' ? '123456789' : null }));
const receipt = { ein: '12-3456789', organization_name: 'Northside Food Bank', amount_cents: 250000, date: '2026-02-04', kind: 'receipt' };
const [pair] = suggestGiftMatches(receipt, withEin);
assert.equal(pair.gift_id, 'G2');
assert.equal(pair.strength, 'strong');
assert.ok(pair.reasons.includes('daf_grant_receipt_pair'));
assert.equal(pair.requires_review, true, 'never auto-merged');
const nameOnly = suggestGiftMatches({ organization_name: 'The Harbor', amount_cents: 60000, date: '2026-03-01', kind: 'receipt' }, [{ ...gifts[3], organization_name: 'Harbor' }]);
assert.equal(nameOnly[0].strength, 'possible');
assert.ok(nameOnly[0].reasons.includes('same_name_only'));
assert.deepEqual(suggestGiftMatches({ organization_name: 'Nobody', amount_cents: 1, date: '2026-01-01' }, gifts), []);

// Daffy recommendation + approval + disbursement for one gift group together; a different amount does not.
const daffy = [
  { id: 'a', kind: 'daf_grant', organization_name: 'Lakeside Youth Camp', amount_cents: 100000, date: '2026-07-01' },
  { id: 'b', kind: 'daf_grant', organization_name: 'Lakeside Youth Camp', amount_cents: 100000, date: '2026-07-08' },
  { id: 'c', kind: 'receipt', organization_name: 'Lakeside Youth Camp', amount_cents: 100000, date: '2026-07-20' },
  { id: 'd', kind: 'daf_grant', organization_name: 'Lakeside Youth Camp', amount_cents: 300000, date: '2026-07-08' },
  { id: 'e', kind: 'daf_grant', organization_name: 'Lakeside Youth Camp', amount_cents: 100000, date: '2025-07-08' },
];
assert.deepEqual(groupLikelySameGift(daffy).map(group => group.sort()), [['a', 'b', 'c']]);
// A recommendation whose amount could not be read joins the one same-day receipt...
assert.deepEqual(groupLikelySameGift([
  { id: 'r', kind: 'daf_grant', organization_name: 'Valley Trails Fund', amount_cents: null, date: '2025-10-11' },
  { id: 's', kind: 'daf_grant', organization_name: 'Valley Trails Fund', amount_cents: 5000, date: '2025-10-11' },
]).map(group => group.sort()), [['r', 's']]);
// ...but not when two different gifts are equally close, nor when weeks apart.
assert.deepEqual(groupLikelySameGift([
  { id: 'r', kind: 'daf_grant', organization_name: 'Org', amount_cents: null, date: '2025-10-11' },
  { id: 's', kind: 'daf_grant', organization_name: 'Org', amount_cents: 5000, date: '2025-10-11' },
  { id: 't', kind: 'daf_grant', organization_name: 'Org', amount_cents: 9000, date: '2025-10-12' },
]), []);
assert.deepEqual(groupLikelySameGift([
  { id: 'r', kind: 'daf_grant', organization_name: 'Org', amount_cents: null, date: '2025-07-25' },
  { id: 's', kind: 'daf_grant', organization_name: 'Org', amount_cents: 50000, date: '2026-10-16' },
]), []);

// ── Lens ─────────────────────────────────────────────────────────────────
const lens = validateLens({
  causes: [
    { id: 'c-lit', label: ' Childhood literacy ', note: 'early grades, our county', origin: { kind: 'drafted_from_gifts', gift_ids: ['G5', 'G1', 'G4'], basis: 'Maple, 3 gifts' } },
    { id: 'c-food', label: 'Local food security' },
  ],
  priorities: [{ id: 'p-local', label: 'Local reach', must_have: false, origin: { kind: 'hint', gift_ids: ['G1'], basis: '4 of 4 organizations are local' } }],
});
assert.equal(lens.causes[0].id, 'c-food', 'causes are unranked (stored in id order)');
assert.equal(lens.causes[1].label, 'Childhood literacy');
assert.deepEqual(lens.causes[1].origin.gift_ids, ['G1', 'G4', 'G5']);
assert.equal(lensHash(lens), lensHash(validateLens({ causes: [...lens.causes].reverse().map(({ origin, ...c }) => ({ ...c, origin })), priorities: lens.priorities })));
assert.deepEqual(validateLens({}).causes, [], 'empty lens is valid (unspecified)');
assert.throws(() => validateLens({ priorities: Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, label: `P${i}` })) }));
assert.throws(() => validateLens({ causes: [{ id: 'c', label: 'x', origin: { kind: 'drafted_from_gifts', gift_ids: [] } }] }));
assert.throws(() => validateLens({ causes: [{ id: 'c', label: 'x', weight: 3 }] }), /unexpected field weight/);
// Organization links are a set; a saved lens can be validated again; dismissals are deduped.
const linked = validateLens({ causes: [{ id: 'c', label: 'Literacy', organization_ids: ['maple', 'maple', 'harbor'] }], dismissed: [{ kind: 'cause', label: 'Health' }, { kind: 'cause', label: 'health' }] });
assert.deepEqual(linked.causes[0].organization_ids, ['harbor', 'maple']);
assert.equal(linked.dismissed.length, 1);
assert.equal(lensHash(validateLens(linked)), lensHash(linked), 'a saved lens round-trips');
assert.ok(isDismissed(linked, 'cause', ' HEALTH '));
assert.throws(() => validateLens({ dismissed: [{ kind: 'value', label: 'x' }] }), /unknown/);
const draft = validateLensDraft({
  causes: [{ label: 'Childhood literacy', basis: 'Maple Literacy, 3 gifts', gift_ids: ['G1', 'G4', 'G5'] }],
  hints: [{ label: 'All organizations are local', count: 4, of: 4, gift_ids: ['G1', 'G2'] }],
}, ['G1', 'G2', 'G4', 'G5']);
assert.equal(draft.causes.length, 1);
assert.throws(() => validateLensDraft({ causes: [{ label: 'x', basis: 'y', gift_ids: ['NOPE'] }] }, ['G1']), /unknown gift/);
assert.throws(() => validateLensDraft({ hints: [{ label: 'Values equity', count: 5, of: 4, gift_ids: ['G1'] }] }, ['G1']), /count basis/);
assert.throws(() => validateLensDraft({ hints: [1, 2, 3].map(() => ({ label: 'h', count: 1, of: 1, gift_ids: ['G1'] })) }, ['G1']));

// ── Import ───────────────────────────────────────────────────────────────
const example = JSON.parse(readFileSync(new URL('./fixtures/example.rivera.json', import.meta.url), 'utf8'));
const parsed = parseGivingImport(example);
assert.equal(parsed.source.kind, 'sample');
assert.equal(parsed.items.length, 7);
const byId = Object.fromEntries(parsed.items.map(item => [item.proposed.item_id, item]));
assert.equal(byId.E2.proposed.organization.ein, '123456789');
assert.equal(byId.E2.issues.length, 0);
assert.ok(byId.E11.issues.some(issue => issue.code === 'DATE_UNKNOWN'));
assert.ok(byId.E3.issues.some(issue => issue.code === 'DATE_IS_EMAIL_PROXY'));
assert.equal(byId.E12.proposed.request.requested_cents, 500000);
// A literal that is not in the excerpt clears the value.
const tampered = structuredClone(example);
tampered.items.find(i => i.item_id === 'E11').proposed.amount.literal = '$260';
const cleared = parseGivingImport(tampered).items.find(i => i.proposed.item_id === 'E11');
assert.equal(cleared.proposed.amount.cents, null);
assert.ok(cleared.issues.some(issue => issue.code === 'LITERAL_NOT_IN_EXCERPT'));
// An amount with no literal is never trusted.
const noLiteral = structuredClone(example);
noLiteral.items.find(i => i.item_id === 'E1').proposed.amount.literal = null;
assert.equal(parseGivingImport(noLiteral).items.find(i => i.proposed.item_id === 'E1').proposed.amount.cents, null);
// Schema and count checks.
assert.throws(() => parseGivingImport({ ...example, format: 'giving-import/v2' }), /does not match/);
assert.throws(() => parseGivingImport({ ...example, scan: { ...example.scan, items_proposed: 3 } }), /items_proposed/);
const dup = structuredClone(example);
dup.items.push({ ...dup.items[0], item_id: 'E99' });
dup.scan.items_proposed = dup.items.length;
assert.throws(() => parseGivingImport(dup), /appears twice/);

console.log('giving core: ok');
