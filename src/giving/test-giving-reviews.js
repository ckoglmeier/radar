// Giving research contracts and run lifecycle.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORG_DIMENSIONS, unsupportedFigures, validateOrgReview, validateRequestEvaluation } from './review-contract.js';
import { derivedFinancials } from '../models/giving-reviews.js';

// ── Figures ──
assert.deepEqual(unsupportedFigures('Revenue grew to $1.4 million in 2023.', ['totrevenue 1415000']), []);
assert.deepEqual(unsupportedFigures('Serves 12,000 students.', ['serves about 1,200 students']).length, 1);
assert.deepEqual(unsupportedFigures('Founded in 1998; 3 sites.', ['nothing']), [], 'years and single digits are not figures');

// ── Organization review ──
const registry = [
  { id: 'registry:org', kind: 'registry', text: 'Lakeside Youth Camp EIN 26-1234567 Lakeside CO' },
  { id: 'registry:filing:2023', kind: 'registry', text: '2023 990 revenue 4,200,000 expenses 3,900,000' },
  { id: 'derived:financials', kind: 'derived', text: '2023 approx_months_of_reserves 7.4 surplus 300000' },
];
const finding = (statement, extra = {}) => ({ statement, claim_type: 'output', provenance: 'organization_claim', direction: 'supports', uncertainty: 'medium', evidence_ids: ['web:1'], ...extra });
const dims = ORG_DIMENSIONS.map(d => ({ id: d.id, coverage: 'assessed', findings: [], open_questions: [] }));
dims[0].findings = [finding('Runs free medical camps for children with serious illness.')];
dims[1].findings = [
  finding('Served 1,000 campers last year.', { evidence_ids: ['web:1'] }),
  finding('Served 9,999 campers.', { evidence_ids: ['web:1'] }),
  finding('Cited a ghost.', { evidence_ids: ['web:9'] }),
  finding('Independent study shows outcomes.', { provenance: 'independent_evidence', evidence_ids: ['registry:org'] }),
  finding('Overall score 8/10.'),
];
dims[3].findings = [
  finding('About 7.4 months of reserves (approximation).', { provenance: 'derived_result', evidence_ids: ['derived:financials'] }),
  finding('Revenue of $4.2 million in 2023.', { provenance: 'regulatory_record', evidence_ids: ['registry:filing:2023'] }),
];
const review = validateOrgReview({
  identity_confirmed: true, identity_note: '', summary: 'Overall score 9/10. This organization reached 987654321 people.',
  dimensions: dims,
  evaluator_panel: [{ evaluator: 'Charity Navigator', status: 'Four-star rating (as of 2026)', evidence_ids: ['web:2', 'web:404'] }],
  web_sources: [
    { id: 'web:1', url: 'https://example.org/impact', title: 'Impact', quote: 'In 2025 we served 1,000 campers at no cost.' },
    { id: 'web:2', url: 'https://www.charitynavigator.org/ein/261234567', title: 'Charity Navigator', quote: 'Four-star rating' },
    { id: 'web:3', url: 'javascript:alert(1)', title: 'bad', quote: '' },
  ],
}, registry);
const byDim = Object.fromEntries(review.dimensions.map(d => [d.id, d]));
assert.equal(byDim.theory_of_change.findings[0].id, 'finding:theory_of_change:1');
assert.deepEqual(byDim.impact_evidence.findings.map(f => f.statement), ['Served 1,000 campers last year.']);
assert.equal(review.validation_notes.length, 4, review.validation_notes.join(' | '));
assert.ok(!review.summary.includes('987654321') && !review.summary.includes('9/10'), 'uncited summary cannot bypass finding validation');
assert.match(review.summary, /3 of 6 areas assessed/);
const emptyReview = validateOrgReview({ identity_confirmed: false, summary: 'Highly effective. Give now.', dimensions: ORG_DIMENSIONS.map(d => ({ id: d.id, coverage: 'assessed', findings: [], open_questions: [] })), web_sources: [] }, []);
assert.match(emptyReview.summary, /0 of 6 areas assessed/);
assert.ok(!emptyReview.summary.includes('Highly effective'), 'qualitative uncited claims are not promoted either');
assert.equal(byDim.financial_resilience.findings.length, 2);
assert.equal(byDim.use_of_funds.coverage, 'limited_evidence', 'assessed with no findings is downgraded');
assert.deepEqual(review.evaluator_panel[0].evidence_ids, ['web:2']);
assert.ok(!review.sources.some(s => s.url === 'javascript:alert(1)'));
assert.equal(byDim.financial_resilience.one_sided, true);
assert.throws(() => validateOrgReview({ ...review, dimensions: dims.slice(1), web_sources: [] }, registry), /exactly once/);

// ── Request evaluation ──
const snapshot = { causes: [{ id: 'c1', label: 'Camps for children with illness' }, { id: 'c2', label: 'Local food' }], priorities: [{ id: 'p1', label: 'Evidence of impact', must_have: true }, { id: 'p2', label: 'Local reach', must_have: false }] };
const evaluation = validateRequestEvaluation({
  summary: 'Overall score 9/10. This organization reached 987654321 people.',
  request_dimensions: [
    { id: 'use_of_these_funds', coverage: 'assessed', explanation: 'Funds one camper.', evidence_ids: ['request:text'], open_question: null },
    { id: 'marginal_effect', coverage: 'assessed', explanation: 'Unclear.', evidence_ids: ['nope'], open_question: 'What if unfunded?' },
    { id: 'terms_timing', coverage: 'limited_evidence', explanation: 'No deadline.', evidence_ids: [], open_question: null },
    { id: 'reporting_back', coverage: 'not_assessable', explanation: 'Not stated.', evidence_ids: [], open_question: null },
  ],
  causes: [{ item_id: 'c1', reading: 'addresses', explanation: 'Direct match.', evidence_ids: ['finding:theory_of_change:1'] }, { item_id: 'zz', reading: 'addresses', explanation: 'x', evidence_ids: [] }],
  priorities: [{ item_id: 'p2', reading: 'fits', explanation: 'Colorado camp.', evidence_ids: ['registry:org'], must_have_status: 'appears_met', next_question: null }],
  questions_for_organization: ['How many campers will this fund?'],
}, { snapshot, evidenceIds: ['request:text', 'registry:org', 'finding:theory_of_change:1'] });
assert.deepEqual(evaluation.causes.map(c => [c.label, c.reading]), [['Camps for children with illness', 'addresses'], ['Local food', 'unclear']], 'labels come from the lens; missing readings are unclear; unknown items ignored');
assert.equal(evaluation.priorities[0].must_have_status, 'unresolved', 'an unread must-have stays an open question');
assert.equal(evaluation.priorities[1].must_have_status, null, 'only must-haves carry a status');
assert.equal(evaluation.request_dimensions[1].coverage, 'limited_evidence');
assert.ok(evaluation.validation_notes.length >= 1);
assert.match(evaluation.summary, /1 of 4 areas assessed/);
assert.ok(!evaluation.summary.includes('987654321') && !evaluation.summary.includes('9/10'), 'request summary cannot introduce an unsupported verdict or figure');

// ── Derived financials ──
assert.deepEqual(derivedFinancials([{ taxYear: 2023, form: '990', totalRevenue: 1200, totalExpenses: 1200, totalAssets: 1300, totalLiabilities: 100 }])[0],
  { tax_year: 2023, form: '990', revenue: 1200, expenses: 1200, net_assets: 1200, approx_months_of_reserves: 12, surplus: 0 });

// ── Run lifecycle ──
const { closeDb, query, withTenant } = await import('../db/index.js');
const { runMigrations } = await import('../db/migrate.js');
const reviews = await import('../models/giving-reviews.js');
const giving = await import('../models/giving.js');
const scratch = mkdtempSync(join(tmpdir(), 'radar-giving-reviews-'));
try {
  await withTenant(`file:${join(scratch, 'db')}`, async () => {
    await runMigrations();
    const org = await giving.saveOrganization({ workspaceId: 'local', name: 'Lakeside Youth Camp', ein: '261234567' });
    await giving.createGift({ workspaceId: 'local', organization: { id: org.id }, gift: { amount_cents: 100000, paid_on: '2026-07-08', vehicle: 'daf_grant', purpose: 'Private family note' } });
    const request = await giving.createRequest({ workspaceId: 'local', organization: { id: org.id }, request: { purpose: 'Send a camper', requested_cents: 300000 } });
    await assert.rejects(reviews.startRequestEvaluation({ workspaceId: 'local', requestId: request.id }), /Research the organization first/);

    const started = await reviews.startOrgReview({ workspaceId: 'local', organizationId: org.id });
    assert.equal(started.already_running, false);
    assert.ok(!JSON.stringify(started.review.inputs).includes('Private family note'), 'research inputs never include gifts or notes');
    assert.equal((await reviews.startOrgReview({ workspaceId: 'local', organizationId: org.id })).already_running, true);
    await reviews.completeOrgReview({ workspaceId: 'local', reviewId: started.review.id, artifact: review });
    await assert.rejects(query(`UPDATE giving_org_reviews SET artifact = '{}' WHERE id = $1`, [started.review.id]), /immutable/);
    await assert.rejects(reviews.completeOrgReview({ workspaceId: 'local', reviewId: started.review.id, artifact: review }), /no longer running/);

    await giving.saveLens({ workspaceId: 'local', lens: { causes: [{ id: 'c1', label: 'Camps', organization_ids: [org.id] }], priorities: [{ id: 'p1', label: 'Evidence of impact', must_have: true }] } });
    await giving.saveBudget({ workspaceId: 'local', budget: { starts_on: '2026-10-17', ends_on: '2027-10-16', mode: 'custom', amount_cents: 200000 } });
    const evalStart = await reviews.startRequestEvaluation({ workspaceId: 'local', requestId: request.id });
    const inputs = evalStart.evaluation.inputs;
    assert.equal(inputs.org_review_id, started.review.id);
    assert.deepEqual(inputs.lens.causes.map(c => c.label), ['Camps']);
    assert.equal(inputs.budget.effect.over_budget_cents, 100000, '$3,000 ask against $2,000 unallocated');
    assert.match(evalStart.evaluation.inputs_sha256, /^[0-9a-f]{64}$/);
    await reviews.failRequestEvaluation({ workspaceId: 'local', evaluationId: evalStart.evaluation.id, code: 'X', message: 'boom' });
    assert.equal((await reviews.requestEvaluationState({ workspaceId: 'local', requestId: request.id })).lastFailure.error_code, 'X');

    // Interrupted runs older than the stale window are failed on the next start.
    const second = await reviews.startOrgReview({ workspaceId: 'local', organizationId: org.id });
    await query(`UPDATE giving_org_reviews SET created_at = NOW() - INTERVAL '2 hours' WHERE id = $1`, [second.review.id]);
    const third = await reviews.startOrgReview({ workspaceId: 'local', organizationId: org.id });
    assert.notEqual(third.review.id, second.review.id);
    assert.equal((await reviews.getOrgReview({ workspaceId: 'local', reviewId: second.review.id })).error_code, 'INTERRUPTED');

    const counts = await giving.resetGiving({ workspaceId: 'local' });
    assert.ok(counts.giving_org_reviews >= 3);
  });
  console.log('giving reviews: contracts, validation repairs and run lifecycle ok');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
