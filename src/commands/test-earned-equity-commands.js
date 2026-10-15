import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createEmploymentEquityIssuer } from '../models/employment-equity.js';
import { getGroup } from '../models/earned-equity-opportunities.js';
import { authorizeCommandProposal, commandMetadata, planCommandProposal } from './service.js';

const fact = (value, state = 'user_reported') => ({ value, state });
const hash = n => String(n).padStart(64, '0');
const actorCapabilities = ['portfolio:apply:additive', 'portfolio:apply:metadata', 'portfolio:apply:destructive'];
const group = (extra = {}) => ({
  schemaVersion: 1, id: 'cg1', mode: 'employment', currency: 'USD', startDate: '2026-11-01', horizonMonths: 48,
  discountRateAnnual: null, baseline: { kind: 'none', annualBase: null, annualCashBonus: null }, status: 'open', ...extra,
});
const opportunity = (extra = {}) => ({ schemaVersion: 1, id: 'co1', groupId: 'cg1', companyName: 'Synthetic Command Co', relationship: 'employment', lifecycle: 'considering', ...extra });
const revision = (id, supersedes = null) => ({
  schemaVersion: 1, id, opportunityId: 'co1', supersedesRevisionId: supersedes, asOfDate: '2026-10-15', status: 'proposed', currency: 'USD',
  cash: { annualBase: fact('170000'), annualTargetBonus: fact(null, 'missing'), signingBonus: fact('0') },
  serviceStartDate: fact(null, 'missing'), grants: [],
});
const scenarioSet = revisionId => ({
  schemaVersion: 1, id: `set-${revisionId}`, offerRevisionId: revisionId, currency: 'USD',
  scenarios: [{ scenarioId: 's1', label: 'Zero outcome', kind: 'failure', weightPct: null, serviceMonths: 12,
    liquidity: { occurs: false, monthsFromStart: null }, payout: { method: 'none' }, exercisePath: { kind: 'at_liquidity' } }],
});

async function plan(name, input, key) {
  return planCommandProposal([{ name, input }], {
    originSurface: 'manual_ui', actorType: 'user', actorId: 'test', intentText: key, idempotencyKey: `earned-opps:${key}`,
  });
}
async function run(name, input, key) {
  const planned = await plan(name, input, key);
  return authorizeCommandProposal(planned.proposal.id, planned.proposal.command_set_hash,
    { authorizationKind: 'explicit_imperative', actorId: 'test', actorCapabilities });
}
const result = receipt => receipt.receipt.commands[0].result;

const scratch = mkdtempSync(join(tmpdir(), 'radar-earned-opps-commands-'));
try {
  await withTenant(`file:${join(scratch, 'db')}`, async () => {
    await runMigrations();
    const issuer = await createEmploymentEquityIssuer({ legalName: 'Synthetic Command Issuer', relationshipStatus: 'other' });

    const names = commandMetadata().commands.map(command => command.name).filter(name => name.startsWith('earned_equity.'));
    assert.deepEqual(names.sort(), ['earned_equity.add_offer_revision', 'earned_equity.attach_offer_document', 'earned_equity.create_group', 'earned_equity.create_opportunity',
      'earned_equity.link_confirmed_grant', 'earned_equity.purge_opportunity', 'earned_equity.record_analysis_snapshot', 'earned_equity.record_decision', 'earned_equity.record_document_review', 'earned_equity.reject_document_review', 'earned_equity.request_offer_memo', 'earned_equity.set_document_consent', 'earned_equity.start_company_review', 'earned_equity.update_group', 'earned_equity.update_opportunity']);

    const groupPlan = await plan('earned_equity.create_group', { payload: group() }, 'cg');
    const authorize = () => authorizeCommandProposal(groupPlan.proposal.id, groupPlan.proposal.command_set_hash,
      { authorizationKind: 'explicit_imperative', actorId: 'test', actorCapabilities });
    assert.equal(result(await authorize()).group.revision, 1);
    // A retry of the same proposal replays the receipt without duplicating.
    assert.equal((await authorize()).idempotent_replay, true);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM earned_equity_decision_groups'))[0].n, 1);
    await assert.rejects(plan('earned_equity.create_group', { payload: group() }, 'cg-again'), /already exists/);
    await assert.rejects(plan('earned_equity.create_group', { payload: { ...group(), mode: 'nope' } }, 'cg-bad'), /Invalid decision group/);

    assert.equal(result(await run('earned_equity.update_group', { groupId: 'cg1', expectedRevision: 1, payload: group({ title: 'Command group' }) }, 'ug')).group.revision, 2);
    await assert.rejects(plan('earned_equity.update_group', { groupId: 'cg1', expectedRevision: 1, payload: group() }, 'ug-stale'), /revision/);

    const created = result(await run('earned_equity.create_opportunity', { payload: opportunity({ portfolioEntityId: issuer.entity.id }), portfolioEntityId: issuer.entity.id }, 'co'));
    assert.equal(created.opportunity.portfolioEntityId, issuer.entity.id);
    await run('earned_equity.create_opportunity', { payload: opportunity({ id: 'co2', companyName: 'Synthetic Second Co' }), portfolioEntityId: null }, 'co2');
    const updated = result(await run('earned_equity.update_opportunity', { opportunityId: 'co1', expectedRevision: 1, payload: opportunity({ lifecycle: 'offer_received', portfolioEntityId: issuer.entity.id }), portfolioEntityId: issuer.entity.id }, 'uo'));
    assert.equal(updated.opportunity.lifecycle, 'offer_received');
    assert.equal(updated.opportunity.revision, 2);
    await assert.rejects(plan('earned_equity.update_opportunity', { opportunityId: 'co1', expectedRevision: 1, payload: opportunity({ portfolioEntityId: issuer.entity.id }) }, 'uo-stale'), /revision/);

    const revisionPlan = await plan('earned_equity.add_offer_revision', { payload: revision('cr1') }, 'cr1');
    const serializedPreview = JSON.stringify(revisionPlan.proposal.previews);
    assert.ok(!serializedPreview.includes('170000'), 'preview must not echo compensation');
    await authorizeCommandProposal(revisionPlan.proposal.id, revisionPlan.proposal.command_set_hash,
      { authorizationKind: 'explicit_imperative', actorId: 'test', actorCapabilities });
    await assert.rejects(plan('earned_equity.add_offer_revision', { payload: revision('cr1b') }, 'cr1b'), /changed since/);
    await run('earned_equity.add_offer_revision', { payload: revision('cr2', 'cr1') }, 'cr2');

    const snapshotInput = { offerRevisionId: 'cr2', scenarioSet: scenarioSet('cr2'), result: { ok: true }, calculatorVersion: 'c1', inputHash: hash(5), companyAssessmentRef: null, benchmark: null };
    const snap = result(await run('earned_equity.record_analysis_snapshot', snapshotInput, 'snap'));
    assert.equal(snap.idempotent, false);
    // Same content, new idempotency key: the model absorbs it without a second row.
    const snap2 = result(await run('earned_equity.record_analysis_snapshot', snapshotInput, 'snap-again'));
    assert.equal(snap2.idempotent, true);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM earned_equity_analysis_snapshots'))[0].n, 1);

    const decisionPayload = {
      schemaVersion: 1, id: 'cd1', groupId: 'cg1', comparedSnapshotIds: [snap.snapshot.id], selectedOfferRevisionIds: ['cr2'],
      outcome: 'selected', rationale: 'Synthetic rationale', acknowledgedRisks: [], gates: { business: 'supported', participation: 'financially_attractive' },
    };
    await assert.rejects(plan('earned_equity.record_decision', { payload: { ...decisionPayload, outcome: 'stay_put' } }, 'cd-bad'), /cannot select/);
    const decisionPlan = await plan('earned_equity.record_decision', { payload: decisionPayload }, 'cd');
    const decide = () => authorizeCommandProposal(decisionPlan.proposal.id, decisionPlan.proposal.command_set_hash,
      { authorizationKind: 'explicit_imperative', actorId: 'test', actorCapabilities });
    assert.equal(result(await decide()).decision.id, 'cd1');
    assert.equal((await decide()).idempotent_replay, true);
    const view = await getGroup('cg1');
    assert.equal(view.latestDecision.id, 'cd1');
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM earned_equity_decisions'))[0].n, 1);
    assert.equal((await query("SELECT COUNT(*)::int AS n FROM investments WHERE asset_class = 'employment_equity'"))[0].n, 0);
    // Purge needs explicit confirmation and removes the tree, including the decision that selected it.
    const purgePlan = await plan('earned_equity.purge_opportunity', { opportunityId: 'co1' }, 'purge');
    const purgeAuth = kind => authorizeCommandProposal(purgePlan.proposal.id, purgePlan.proposal.command_set_hash,
      { authorizationKind: kind, actorId: 'test', actorCapabilities });
    assert.equal((await purgeAuth('explicit_imperative')).status, 'confirmation_required');
    assert.equal((await query("SELECT COUNT(*)::int AS n FROM earned_equity_opportunities WHERE id = 'co1'"))[0].n, 1);
    const purged = await purgeAuth('inline_confirmation');
    assert.equal(purged.status, 'applied');
    assert.deepEqual(result(purged).purged, { opportunities: 1, revisions: 2, snapshots: 1, decisions: 1 });
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM earned_equity_offer_revisions'))[0].n, 0);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM earned_equity_opportunities'))[0].n, 1);
    console.log('Earned Equity opportunity commands: PASS');
  });
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
