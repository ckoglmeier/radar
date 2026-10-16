import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'radar-earned-handoff-'));
process.env.HOME = scratch;
const { closeDb, query, withTenant } = await import('../db/index.js');
const { runMigrations } = await import('../db/migrate.js');
const { createGroup, createOpportunity, getOpportunityRow, addOfferRevision } = await import('../models/earned-equity-opportunities.js');
const { stageOfferDocument } = await import('../models/earned-equity-documents.js');
const { failCompanyReview } = await import('../models/earned-equity-reviews.js');
const { authorizeCommandProposal, commandMetadata, planCommandProposal } = await import('./service.js');

const fact = (value, state = 'user_reported') => ({ value, state });
const hash = label => createHash('sha256').update(label).digest('hex');
const actorCapabilities = ['portfolio:apply:additive', 'portfolio:apply:metadata', 'portfolio:apply:destructive'];
const SECRET_TEXT = 'Your annual base salary is $187,654 and we grant 48,000 stock options at a strike of $1.37 per share.';
const SECRET_FILE = 'confidential-offer-letter-zebra.txt';

let seq = 0;
const plan = (name, input) => planCommandProposal([{ name, input }], {
  originSurface: 'manual_ui', actorType: 'user', actorId: 'test', intentText: `handoff-${++seq}`, idempotencyKey: `handoff:${seq}` });
const authorize = (planned, kind = 'explicit_imperative') => authorizeCommandProposal(planned.proposal.id, planned.proposal.command_set_hash,
  { authorizationKind: kind, actorId: 'test', actorCapabilities });
const run = async (name, input, kind) => authorize(await plan(name, input), kind);
const result = receipt => receipt.receipt.commands[0].result;

try {
  await withTenant(`file:${join(scratch, 'db')}`, async () => {
    await runMigrations();
    const names = commandMetadata().commands.filter(command => command.name.startsWith('earned_equity.'));
    for (const name of ['attach_offer_document', 'set_document_consent', 'record_document_review', 'reject_document_review', 'start_company_review', 'request_offer_memo']) {
      const command = names.find(item => item.name === `earned_equity.${name}`);
      assert.ok(command, name);
      assert.equal(command.plannerExposure, false);
    }

    await createGroup({ schemaVersion: 1, id: 'g1', mode: 'employment', currency: 'USD', startDate: '2026-11-01', horizonMonths: 48,
      discountRateAnnual: null, baseline: { kind: 'none', annualBase: null, annualCashBonus: null }, status: 'open' });
    const opp = id => ({ schemaVersion: 1, id, groupId: 'g1', companyName: `Synthetic ${id}`, relationship: 'employment', lifecycle: 'offer_received' });
    await createOpportunity(opp('o1'));
    await createOpportunity(opp('o2'));

    // attach_offer_document: staged bytes, personal_sensitive + local_only, replay-safe.
    const staged = await stageOfferDocument({ filename: SECRET_FILE, mime: 'text/plain', content: Buffer.from(SECRET_TEXT) });
    await assert.rejects(plan('earned_equity.attach_offer_document', { opportunityId: 'nope', previewId: staged.id }), /not found/i);
    const attachPlan = await plan('earned_equity.attach_offer_document', { opportunityId: 'o1', previewId: staged.id });
    assert.ok(!JSON.stringify(attachPlan.proposal.previews).includes(SECRET_FILE));
    const attached = await authorize(attachPlan);
    assert.equal(attached.status, 'applied');
    const documentId = result(attached).document.id;
    const [doc] = await query('SELECT confidentiality, processing_policy, entity_id FROM documents WHERE id = $1', [documentId]);
    assert.deepEqual({ ...doc }, { confidentiality: 'personal_sensitive', processing_policy: 'local_only', entity_id: 'o1' });
    assert.equal((await authorize(attachPlan)).idempotent_replay, true);
    const attachAgain = await run('earned_equity.attach_offer_document', { opportunityId: 'o1', previewId: staged.id });
    assert.equal(result(attachAgain).idempotentReplay, true);
    assert.equal(result(attachAgain).document.id, documentId);
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM documents WHERE entity_type = 'earned_equity_opportunity'`))[0].n, 1);
    await assert.rejects(run('earned_equity.attach_offer_document', { opportunityId: 'o2', previewId: staged.id }), /already attached/);

    // record_document_review: deterministic review on device; identical retry reuses the open proposal.
    await assert.rejects(plan('earned_equity.record_document_review', { opportunityId: 'o2', documentId }), /not attached/);
    const reviewApplied = await run('earned_equity.record_document_review', { opportunityId: 'o1', documentId });
    const reviewId = result(reviewApplied).review.id;
    assert.equal(result(reviewApplied).reused, false);
    const rowsAfterReview = (await query('SELECT COUNT(*)::int AS n FROM earned_equity_document_reviews'))[0].n;
    assert.equal(rowsAfterReview, 1);
    const reviewAgain = await run('earned_equity.record_document_review', { opportunityId: 'o1', documentId });
    assert.equal(result(reviewAgain).reused, true);
    assert.equal(result(reviewAgain).review.id, reviewId);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM earned_equity_document_reviews'))[0].n, 1);

    // reject_document_review.
    const rejectPlan = await plan('earned_equity.reject_document_review', { reviewId });
    assert.equal(result(await authorize(rejectPlan)).review.status, 'rejected');
    assert.equal((await authorize(rejectPlan)).idempotent_replay, true);
    await assert.rejects(plan('earned_equity.reject_document_review', { reviewId }), /cannot be rejected/);
    await assert.rejects(plan('earned_equity.reject_document_review', { reviewId: 'ghost' }), /not found/i);

    // set_document_consent: allowing needs explicit confirmation; withdrawing does not.
    const allowPlan = await plan('earned_equity.set_document_consent', { documentId, allowed: true });
    assert.equal((await authorize(allowPlan)).status, 'confirmation_required');
    assert.equal((await query('SELECT processing_policy FROM documents WHERE id = $1', [documentId]))[0].processing_policy, 'local_only');
    assert.equal((await authorize(allowPlan, 'inline_confirmation')).status, 'applied');
    assert.equal((await query('SELECT processing_policy FROM documents WHERE id = $1', [documentId]))[0].processing_policy, 'model_allowed');
    assert.equal((await authorize(allowPlan, 'inline_confirmation')).idempotent_replay, true);
    assert.equal((await run('earned_equity.set_document_consent', { documentId, allowed: false })).status, 'applied');
    assert.equal((await query('SELECT processing_policy FROM documents WHERE id = $1', [documentId]))[0].processing_policy, 'local_only');
    await assert.rejects(plan('earned_equity.set_document_consent', { documentId: 999999, allowed: true }), /not found/i);

    // start_company_review: claims the run, creates and links the company through the revision guard.
    const claim = (extra = {}) => ({
      opportunityId: 'o1', reviewKind: 'initial', lensId: 'earned-equity-company', lensVersion: 1, policyVersion: 1,
      instructionHash: hash('instr'), sourceManifestHash: hash('manifest'), runKey: hash('run-1'), ...extra,
    });
    await assert.rejects(plan('earned_equity.start_company_review', claim()), /legal name/i);
    await assert.rejects(plan('earned_equity.start_company_review', claim({ runKey: 'short' })), /runKey|pattern|invalid/i);
    await assert.rejects(plan('earned_equity.start_company_review', claim({ reviewKind: 'followup' })), /parent/i);
    const startPlan = await plan('earned_equity.start_company_review', claim({ legalName: 'Synthetic Handoff Co' }));
    const started = await authorize(startPlan);
    assert.equal(result(started).state, 'started');
    assert.equal(result(started).issuerCreated, true);
    const entityId = result(started).portfolioEntityId;
    const linked = await getOpportunityRow('o1');
    assert.equal(linked.portfolioEntityId, entityId);
    assert.equal(linked.revision, 2);
    assert.equal((await authorize(startPlan)).idempotent_replay, true);
    const restart = await run('earned_equity.start_company_review', claim({ legalName: 'Synthetic Handoff Co' }));
    assert.equal(result(restart).state, 'running');
    assert.equal(result(restart).review.id, result(started).review.id);
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM earned_equity_company_reviews`))[0].n, 1);
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM portfolio_entities WHERE legal_name = 'Synthetic Handoff Co'`))[0].n, 1);
    // A second opportunity cannot create a company that already exists; linking the existing one works,
    // but not while another review of that company is running.
    await assert.rejects(plan('earned_equity.start_company_review', claim({ opportunityId: 'o2', runKey: hash('run-2'), legalName: 'Synthetic Handoff Co' })), /already exists/);
    await assert.rejects(plan('earned_equity.start_company_review', claim({ opportunityId: 'o2', runKey: hash('run-2'), portfolioEntityId: entityId })), /already running/);
    assert.equal((await getOpportunityRow('o2')).portfolioEntityId, null);
    await failCompanyReview(result(started).review.id);
    const second = await run('earned_equity.start_company_review', claim({ opportunityId: 'o2', runKey: hash('run-2'), portfolioEntityId: entityId }));
    assert.equal(result(second).linkedExisting, true);
    assert.equal(result(second).state, 'started');
    assert.equal((await getOpportunityRow('o2')).portfolioEntityId, entityId);

    // request_offer_memo.
    await addOfferRevision({
      schemaVersion: 1, id: 'r1', opportunityId: 'o1', supersedesRevisionId: null, asOfDate: '2026-10-15', status: 'signed', currency: 'USD',
      cash: { annualBase: fact('187654'), annualTargetBonus: fact('0'), signingBonus: fact('0') }, serviceStartDate: fact('2026-11-01'), grants: [],
    });
    await assert.rejects(plan('earned_equity.request_offer_memo', { offerRevisionId: 'ghost', runKey: hash('m1') }), /not found/i);
    const memoPlan = await plan('earned_equity.request_offer_memo', { offerRevisionId: 'r1', runKey: hash('m1') });
    const memo = await authorize(memoPlan);
    assert.equal(result(memo).state, 'started');
    assert.equal((await authorize(memoPlan)).idempotent_replay, true);
    assert.equal(result(await run('earned_equity.request_offer_memo', { offerRevisionId: 'r1', runKey: hash('m1') })).state, 'running');
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM earned_equity_offer_reviews'))[0].n, 1);

    // add_offer_revision confirms document reviews atomically with the new revision.
    await createOpportunity(opp('o3'));
    const reviewIds = [];
    for (const [opportunityId, name] of [['o3', 'a'], ['o3', 'b'], ['o2', 'c']]) {
      const st = await stageOfferDocument({ filename: `${name}.txt`, mime: 'text/plain', content: Buffer.from(`Synthetic offer text ${name} ${SECRET_TEXT}`) });
      await run('earned_equity.attach_offer_document', { opportunityId, previewId: st.id });
      const [d] = await query(`SELECT id FROM documents WHERE entity_id = $1 AND sha256 = $2`, [opportunityId, createHash('sha256').update(`Synthetic offer text ${name} ${SECRET_TEXT}`).digest('hex')]);
      reviewIds.push(result(await run('earned_equity.record_document_review', { opportunityId, documentId: Number(d.id) })).review.id);
    }
    const rev = (id, supersedes = null, opportunityId = 'o3') => ({
      schemaVersion: 1, id, opportunityId, supersedesRevisionId: supersedes, asOfDate: '2026-10-15', status: 'proposed', currency: 'USD',
      cash: { annualBase: fact('150000'), annualTargetBonus: fact('0'), signingBonus: fact('0') }, serviceStartDate: fact(null, 'missing'), grants: [] });
    const statusOf = async id => (await query('SELECT status, confirmed_offer_revision_id AS rev FROM earned_equity_document_reviews WHERE id = $1', [id]))[0];
    const revisionCount = async () => (await query('SELECT COUNT(*)::int AS n FROM earned_equity_offer_revisions'))[0].n;
    const before = await revisionCount();
    // Wrong opportunity, duplicates and unknown ids fail the whole command with nothing written.
    await assert.rejects(plan('earned_equity.add_offer_revision', { payload: rev('c1'), confirmsDocumentReviewIds: [reviewIds[0], reviewIds[2]] }), /different opportunity/);
    await assert.rejects(plan('earned_equity.add_offer_revision', { payload: rev('c1'), confirmsDocumentReviewIds: [reviewIds[0], reviewIds[0]] }), /twice/);
    await assert.rejects(plan('earned_equity.add_offer_revision', { payload: rev('c1'), confirmsDocumentReviewIds: ['ghost'] }), /not found/);
    // Rejected at apply time (state changed after planning): rolls back the revision too.
    const stalePlan = await plan('earned_equity.add_offer_revision', { payload: rev('c1'), confirmsDocumentReviewIds: [reviewIds[0], reviewIds[1]] });
    await run('earned_equity.reject_document_review', { reviewId: reviewIds[1] });
    // The reviewed preconditions changed: the proposal goes stale and nothing is written.
    const staleOutcome = await authorize(stalePlan);
    assert.equal(staleOutcome.stale, true);
    await assert.rejects(authorize(stalePlan), /stale/);
    assert.equal(await revisionCount(), before);
    assert.equal((await statusOf(reviewIds[0])).status, 'proposed');
    // A review that is already rejected/confirmed is refused at plan time.
    await assert.rejects(plan('earned_equity.add_offer_revision', { payload: rev('c1'), confirmsDocumentReviewIds: [reviewIds[1]] }), /cannot be confirmed/);
    // Two reviews confirmed in one revision (second review for o3 recorded fresh).
    const st2 = await stageOfferDocument({ filename: 'd.txt', mime: 'text/plain', content: Buffer.from(`Synthetic offer text d ${SECRET_TEXT}`) });
    await run('earned_equity.attach_offer_document', { opportunityId: 'o3', previewId: st2.id });
    const [d2] = await query(`SELECT id FROM documents WHERE entity_id = 'o3' AND sha256 = $1`, [createHash('sha256').update(`Synthetic offer text d ${SECRET_TEXT}`).digest('hex')]);
    const reviewD = result(await run('earned_equity.record_document_review', { opportunityId: 'o3', documentId: Number(d2.id) })).review.id;
    const okPlan = await plan('earned_equity.add_offer_revision', { payload: rev('c1'), confirmsDocumentReviewIds: [reviewIds[0], reviewD] });
    assert.match(JSON.stringify(okPlan.proposal.previews), /document_reviews_confirmed/);
    const okApplied = await authorize(okPlan);
    assert.deepEqual(result(okApplied).confirmedReviewIds.sort(), [reviewIds[0], reviewD].sort());
    for (const id of [reviewIds[0], reviewD]) assert.deepEqual({ ...(await statusOf(id)) }, { status: 'confirmed', rev: 'c1' });
    // Retrying the proposal replays the receipt: no second revision, no double confirmation.
    assert.equal((await authorize(okPlan)).idempotent_replay, true);
    assert.equal(await revisionCount(), before + 1);
    // Existing callers without the field still work.
    await run('earned_equity.add_offer_revision', { payload: rev('c2', 'c1') });
    assert.equal(await revisionCount(), before + 2);

    // Privacy: no document text, filename or salary in any command proposal or receipt.
    const stored = JSON.stringify([
      await query('SELECT * FROM command_proposals'), await query('SELECT * FROM command_receipts'),
    ]);
    for (const secret of ['187,654', '187654', '48,000', '1.37', 'annual base salary', SECRET_FILE, 'zebra']) {
      assert.ok(!stored.includes(secret), `command records must not contain: ${secret}`);
    }
    assert.ok(stored.includes('earned_equity.attach_offer_document'));
    console.log('Earned Equity handoff commands: PASS');
  });
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
