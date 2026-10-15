import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createEmploymentEquityIssuer } from './employment-equity.js';
import {
  addOfferRevision, createGroup, createOpportunity, purgeEarnedEquityOpportunity, recordAnalysisSnapshot, recordDecision,
} from './earned-equity-opportunities.js';
import {
  beginCompanyReview, beginOfferReview, companyReviewChain, completeCompanyReview, completeOfferReview,
  failCompanyReview, failOfferReview, findCompletedCompanyReview, findCompletedOfferReview, getCompanyReview, getOfferReview,
  latestCompletedCompanyReview, listCompanyReviews, listOfferReviews, purgeCompanyReviews, setCompanyReviewStage,
} from './earned-equity-reviews.js';
import { earnedEquityCompanyReview } from '../council/earned-equity-mode.js';

const hex = n => String(n).padStart(64, '0');
const fact = (value, state = 'user_reported') => ({ value, state });
const code = expected => error => error.code === expected;
const group = id => ({ schemaVersion: 1, id, mode: 'employment', currency: 'USD', startDate: '2026-11-01', horizonMonths: 48, discountRateAnnual: '0.10',
  baseline: { kind: 'current_role', annualBase: '150000', annualCashBonus: '10000' }, status: 'open' });
const grant = () => ({ componentId: 'g1', instrument: 'nso', units: fact('1000'), quotedOwnershipPct: fact('0.05'),
  ownershipDenominator: { basis: 'fully_diluted', asOfDate: '2026-10-01' }, strikePrice: fact('1.25'), grantDate: fact(null, 'missing'),
  boardApproval: fact('pending'), vesting: { commencementDate: fact('2026-11-01'), totalMonths: 48, cliffMonths: 12, cadence: 'monthly', acceleration: 'none' },
  exercise: { postTerminationWindowMonths: fact('3'), expirationYears: fact('10'), earlyExercise: fact(false) } });
const revision = (id, opportunityId) => ({ schemaVersion: 1, id, opportunityId, supersedesRevisionId: null, asOfDate: '2026-10-15', status: 'proposed', currency: 'USD',
  cash: { annualBase: fact('160000'), annualTargetBonus: fact('12000'), signingBonus: fact('0') }, serviceStartDate: fact('2026-11-01'), grants: [grant()] });
const scenarioSet = revisionId => ({ schemaVersion: 1, id: `set-${revisionId}`, offerRevisionId: revisionId, currency: 'USD', scenarios: [{ scenarioId: 's1', label: 'Zero outcome',
  kind: 'failure', weightPct: null, serviceMonths: 24, liquidity: { occurs: false, monthsFromStart: null }, payout: { method: 'none' }, exercisePath: { kind: 'at_liquidity' } }] });

const key = (entity, extra = {}) => ({
  portfolioEntityId: entity, lensId: 'earned-equity-company', lensVersion: 1, policyVersion: 9,
  instructionHash: hex(1), sourceManifestHash: hex(2), runKey: hex(10), ...extra,
});
const artifact = (entity, runKey, gate = 'supported', extra = {}) => ({
  reviewMode: 'earned_equity_company', gate: { status: gate }, company: { portfolioEntityId: entity }, findings: [], provenance: { runKey }, ...extra,
});

const scratch = mkdtempSync(join(tmpdir(), 'radar-earned-reviews-'));
try {
  await withTenant(`file:${join(scratch, 'db')}`, async () => {
    await runMigrations();
    const issuer = await createEmploymentEquityIssuer({ legalName: 'Synthetic Review Co', relationshipStatus: 'other' });
    const entity = issuer.entity.id;
    const other = (await createEmploymentEquityIssuer({ legalName: 'Synthetic Other Co', relationshipStatus: 'other' })).entity.id;

    // Company review lifecycle.
    const angelTables = ['pipeline_invites', 'council_runs', 'deal_evaluations', 'ad_hoc_reviews', 'council_followup_questions'];
    const angelBefore = await Promise.all(angelTables.map(async table => Number((await query(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n)));

    const started = await beginCompanyReview(key(entity));
    assert.equal(started.state, 'started');
    assert.equal(started.review.status, 'running');
    assert.equal((await beginCompanyReview(key(entity))).state, 'running');
    await assert.rejects(beginCompanyReview(key(entity, { runKey: hex(11) })), code('review_in_progress'));
    await setCompanyReviewStage(started.review.id, 'bull_bear');
    assert.equal((await getCompanyReview(started.review.id)).stage, 'bull_bear');
    await assert.rejects(completeCompanyReview(started.review.id, { artifact: artifact(entity, hex(99)) }), code('invalid_artifact'));
    await assert.rejects(completeCompanyReview(started.review.id, { artifact: artifact(other, hex(10)) }), code('invalid_artifact'));
    await assert.rejects(completeCompanyReview(started.review.id, { artifact: artifact(entity, hex(10), 'maybe') }), code('invalid_artifact'));
    const done = await completeCompanyReview(started.review.id, { artifact: artifact(entity, hex(10)), usage: { inputTokens: 5 } });
    assert.equal(done.status, 'completed');
    assert.equal(done.usage.inputTokens, 5);
    assert.equal((await findCompletedCompanyReview(hex(10))).id, done.id);
    const reused = await beginCompanyReview(key(entity));
    assert.equal(reused.state, 'reused');
    assert.equal(reused.review.id, done.id);
    await assert.rejects(beginCompanyReview(key(other)), code('run_key_conflict'));

    // Completed artifacts are immutable; triggers hold even for direct SQL.
    await assert.rejects(query(`UPDATE earned_equity_company_reviews SET artifact = '{}'::jsonb WHERE id = $1`, [done.id]), /immutable/);
    await assert.rejects(query(`UPDATE earned_equity_company_reviews SET status = 'failed' WHERE id = $1`, [done.id]), /immutable/);
    await assert.rejects(query('DELETE FROM earned_equity_company_reviews WHERE id = $1', [done.id]), /immutable/);
    await assert.rejects(completeCompanyReview(done.id, { artifact: artifact(entity, hex(10)) }), code('not_running'));
    assert.equal(await failCompanyReview(done.id, { errorCode: 'x' }), false);

    // A failed run can be restarted under the same key; identity never changes.
    const second = await beginCompanyReview(key(entity, { runKey: hex(12) }));
    assert.equal(second.state, 'started');
    assert.equal(await failCompanyReview(second.review.id, { errorCode: 'provider_error' }), true);
    assert.equal((await getCompanyReview(second.review.id)).errorCode, 'provider_error');
    assert.equal(await findCompletedCompanyReview(hex(12)), null);
    await assert.rejects(query(`UPDATE earned_equity_company_reviews SET run_key = $2 WHERE id = $1`, [second.review.id, hex(13)]), /identity is immutable/);
    const restarted = await beginCompanyReview(key(entity, { runKey: hex(12) }));
    assert.equal(restarted.state, 'restarted');
    assert.equal(restarted.review.errorCode, null);
    await failCompanyReview(second.review.id);

    // Different companies can run at once; one running per company.
    const otherRun = await beginCompanyReview(key(other, { runKey: hex(20) }));
    assert.equal(otherRun.state, 'started');
    await failCompanyReview(otherRun.review.id);

    // Follow-up: a new linked review. The parent row and its artifact are untouched.
    await assert.rejects(beginCompanyReview(key(entity, { runKey: hex(30), reviewKind: 'followup' })), code('invalid_input'));
    await assert.rejects(beginCompanyReview(key(entity, { runKey: hex(30), reviewKind: 'followup', parentReviewId: second.review.id })), code('invalid_parent'));
    await assert.rejects(beginCompanyReview(key(other, { runKey: hex(30), reviewKind: 'followup', parentReviewId: done.id })), code('invalid_parent'));
    await assert.rejects(beginCompanyReview(key(entity, { runKey: hex(30), parentReviewId: done.id })), code('invalid_input'));

    // Offer side: group, opportunity, revision, snapshot, decision.
    await createGroup(group('g1'));
    await createOpportunity({ schemaVersion: 1, id: 'o1', groupId: 'g1', companyName: 'Synthetic Review Co', relationship: 'employment', lifecycle: 'offer_received', portfolioEntityId: entity }, entity);
    await addOfferRevision(revision('r1', 'o1'));
    const { snapshot } = await recordAnalysisSnapshot({ offerRevisionId: 'r1', scenarioSet: scenarioSet('r1'), result: { ok: true }, calculatorVersion: 'c1', inputHash: hex(7) });
    const decisionRow = await recordDecision({ schemaVersion: 1, id: 'd1', groupId: 'g1', comparedSnapshotIds: [snapshot.id], selectedOfferRevisionIds: ['r1'], outcome: 'selected',
      rationale: 'Synthetic', acknowledgedRisks: [], gates: { business: 'supported', participation: 'financially_attractive' } });
    assert.ok(decisionRow);

    await assert.rejects(beginOfferReview({ offerRevisionId: 'missing', runKey: hex(40) }), code('not_found'));
    await assert.rejects(beginOfferReview({ offerRevisionId: 'r1', snapshotId: 'ghost', runKey: hex(40) }), code('invalid_snapshot'));
    await assert.rejects(beginOfferReview({ offerRevisionId: 'r1', companyReviewId: second.review.id, runKey: hex(40) }), code('invalid_company_review'));
    const offerStart = await beginOfferReview({ offerRevisionId: 'r1', companyReviewId: done.id, snapshotId: snapshot.id, runKey: hex(40) });
    assert.equal(offerStart.state, 'started');
    assert.equal((await beginOfferReview({ offerRevisionId: 'r1', companyReviewId: done.id, snapshotId: snapshot.id, runKey: hex(40) })).state, 'running');
    await assert.rejects(completeOfferReview(offerStart.review.id, { artifact: { reviewMode: 'earned_equity_company' } }), code('invalid_artifact'));
    const offerDone = await completeOfferReview(offerStart.review.id, { artifact: { reviewMode: 'earned_equity_offer', memo: { overview: 'Synthetic' } }, usage: { inputTokens: 3 } });
    assert.equal(offerDone.status, 'completed');
    assert.equal((await findCompletedOfferReview(hex(40))).id, offerDone.id);
    assert.equal((await beginOfferReview({ offerRevisionId: 'r1', companyReviewId: done.id, snapshotId: snapshot.id, runKey: hex(40) })).state, 'reused');
    await assert.rejects(query(`UPDATE earned_equity_offer_reviews SET artifact = '{}'::jsonb WHERE id = $1`, [offerDone.id]), /immutable/);
    await assert.rejects(query('DELETE FROM earned_equity_offer_reviews WHERE id = $1', [offerDone.id]), /immutable/);
    const failedOffer = await beginOfferReview({ offerRevisionId: 'r1', runKey: hex(41) });
    assert.equal(await failOfferReview(failedOffer.review.id, { errorCode: 'memo_rejected' }), true);
    assert.equal((await getOfferReview(failedOffer.review.id)).errorCode, 'memo_rejected');
    assert.equal(await findCompletedOfferReview(hex(41)), null);

    // Employer answers: a real follow-up run creates a new linked company review and a new offer review.
    const before = {
      parent: JSON.stringify(await getCompanyReview(done.id)),
      offer: JSON.stringify(await getOfferReview(offerDone.id)),
      snapshot: JSON.stringify(await query('SELECT * FROM earned_equity_analysis_snapshots ORDER BY seq')),
      decisions: JSON.stringify(await query('SELECT * FROM earned_equity_decisions ORDER BY seq')),
    };
    const followupStart = await beginCompanyReview(key(entity, { runKey: hex(31), reviewKind: 'followup', parentReviewId: done.id }));
    assert.equal(followupStart.state, 'started');
    assert.equal(followupStart.review.parentReviewId, done.id);
    const followupDone = await completeCompanyReview(followupStart.review.id, { artifact: artifact(entity, hex(31), 'unresolved', { reviewKind: 'followup' }) });
    assert.deepEqual((await companyReviewChain(followupDone.id)).map(row => row.id), [done.id, followupDone.id]);
    const offerFollowup = await beginOfferReview({ offerRevisionId: 'r1', companyReviewId: followupDone.id, snapshotId: snapshot.id, parentReviewId: offerDone.id, reviewKind: 'followup', runKey: hex(42) });
    assert.equal(offerFollowup.review.parentReviewId, offerDone.id);
    await completeOfferReview(offerFollowup.review.id, { artifact: { reviewMode: 'earned_equity_offer', memo: {} } });
    assert.equal(JSON.stringify(await getCompanyReview(done.id)), before.parent, 'the prior company review is unchanged');
    assert.equal(JSON.stringify(await getOfferReview(offerDone.id)), before.offer, 'the prior offer review is unchanged');
    assert.equal(JSON.stringify(await query('SELECT * FROM earned_equity_analysis_snapshots ORDER BY seq')), before.snapshot);
    assert.equal(JSON.stringify(await query('SELECT * FROM earned_equity_decisions ORDER BY seq')), before.decisions, 'decision snapshot references are unchanged');
    assert.equal((await getOfferReview(offerDone.id)).companyReviewId, done.id, 'the earlier offer review still cites the earlier company review');
    assert.equal((await latestCompletedCompanyReview(entity)).id, followupDone.id);
    assert.deepEqual((await listCompanyReviews(entity)).map(row => row.status), ['completed', 'failed', 'completed']);
    assert.deepEqual((await listOfferReviews('r1')).map(row => row.reviewKind), ['initial', 'initial', 'followup']);

    // The engine mode run key feeds this table: a full fake-provider review persists and is then reused.
    const fakeProvider = {
      calls: 0,
      async runSession(request) {
        this.calls += 1;
        const stage = /STAGE:\s*(\w+)/.exec(request.prompt)[1];
        const finding = { id: 'F1', rubricRowId: 'weak_retention_unproven_demand', statement: 'Strong retention.', evidenceIds: ['E1'], evidenceState: 'verified',
          applicability: { stage: 'series-a', businessModel: 'any' }, direction: 'strengthens', affectedAssumption: 'growth_trajectory',
          proposedSensitivity: { kind: 'none', description: 'None', value: null, unit: null, sourceEvidenceIds: [], userEstimate: false },
          uncertainty: 'low', counterevidence: [], confirmationState: 'proposed' };
        const data = {
          research: { evidence: ['[ee-demand-retention] VERIFIED | Retention was strong | 2026-06-30 | Source | n/a'], team_dossier: 'T', company_context: 'C', custom_questions: [], critical_unknowns: [], contradictions_to_resolve: [] },
          bull: { findings: [finding], key_argument: 'Up', gate_view: 'supported' },
          bear: { findings: [finding], key_argument: 'Down', gate_view: 'supported' },
          company_calibrator: { gate_proposal: { status: 'supported', rationale: 'Ok', deciding_finding_ids: ['F1'], unresolved_reasons: [] }, findings: [finding],
            evidence_confidence: 'high', stage_cap_ids: ['series_a_actual_revenue_missing'].slice(1), employee_common_equity_notes: [], questions_for_employer: [], net_assessment: 'Fine' },
        }[stage];
        return { structuredOutput: data, usage: { inputTokens: 1, outputTokens: 1, totalCostUsd: null }, sessionId: stage };
      },
    };
    const input = { portfolioEntityId: other, company: 'Synthetic Other Co', stage: 'Series A' };
    const dry = await earnedEquityCompanyReview(input, { dryRun: true, env: {} });
    const claim = await beginCompanyReview({ portfolioEntityId: other, lensId: dry.provenance.lensId, lensVersion: dry.provenance.lensVersion,
      policyVersion: dry.provenance.policyVersion, instructionHash: dry.provenance.instructionHash, sourceManifestHash: dry.provenance.sourceManifestHash, runKey: dry.provenance.runKey });
    assert.equal(claim.state, 'started');
    const run = await earnedEquityCompanyReview(input, { provider: fakeProvider, env: {}, onStage: stage => setCompanyReviewStage(claim.review.id, stage) });
    const persisted = await completeCompanyReview(claim.review.id, { artifact: run.review, usage: run.usage });
    assert.equal(persisted.artifact.gate.status, 'supported');
    const callsBefore = fakeProvider.calls;
    const again = await earnedEquityCompanyReview(input, { provider: fakeProvider, env: {}, findExisting: findCompletedCompanyReview });
    assert.equal(again.reused, true);
    assert.equal(again.reviewId, persisted.id);
    assert.equal(fakeProvider.calls, callsBefore);

    // Purging an opportunity removes its personal offer reviews but never company reviews.
    await purgeEarnedEquityOpportunity('o1');
    assert.deepEqual(await listOfferReviews('r1'), []);
    assert.equal((await getCompanyReview(done.id)).status, 'completed');
    assert.equal((await getCompanyReview(followupDone.id)).status, 'completed');
    // Company reviews go only through an explicit purge.
    assert.deepEqual(await purgeCompanyReviews(entity), { companyReviews: 3 });
    assert.deepEqual(await listCompanyReviews(entity), []);

    // No angel tables were touched.
    const angelAfter = await Promise.all(angelTables.map(async table => Number((await query(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n)));
    assert.deepEqual(angelAfter, angelBefore);
  });
  console.log('Earned Equity reviews: lifecycle, reuse by run key, follow-up chain, immutability, purge boundaries, and angel-table isolation passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
