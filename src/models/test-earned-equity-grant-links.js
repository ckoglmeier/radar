import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createEmploymentEquityIssuer, createEmploymentEquityPosition, employmentEquitySummary } from './employment-equity.js';
import {
  addOfferRevision, createGroup, createOpportunity, getOpportunityRow, purgeEarnedEquityGroup, purgeEarnedEquityOpportunity, recordDecision,
} from './earned-equity-opportunities.js';
import { describeVesting, linkConfirmedGrant, listGrantLinks } from './earned-equity-grant-links.js';
import { createDatabaseBackupPayload, restoreDatabase } from '../db/backup.js';
import { annualDeploymentPlanReport } from '../reports/deployment-plan.js';
import { portfolioSummary } from '../reports/portfolio.js';
import { authorizeCommandProposal, planCommandProposal } from '../commands/service.js';

const fact = (value, state = 'user_reported') => ({ value, state });
const code = expected => error => error.code === expected;
const component = id => ({
  componentId: id, instrument: 'nso', units: fact('48000'), quotedOwnershipPct: fact('0.05'),
  ownershipDenominator: { basis: 'fully_diluted', asOfDate: '2026-10-01' }, strikePrice: fact('1.25'),
  grantDate: fact(null, 'missing'), boardApproval: fact('pending'),
  vesting: { commencementDate: fact('2026-11-01'), totalMonths: 48, cliffMonths: 12, cadence: 'monthly', acceleration: 'none' },
  exercise: { postTerminationWindowMonths: fact('3'), expirationYears: fact('10'), earlyExercise: fact(false) },
});
const revision = (id, opportunityId, supersedes = null) => ({
  schemaVersion: 1, id, opportunityId, supersedesRevisionId: supersedes, asOfDate: '2026-10-15', status: 'signed', currency: 'USD',
  cash: { annualBase: fact('212345'), annualTargetBonus: fact('0'), signingBonus: fact('0') },
  serviceStartDate: fact('2026-11-01'), grants: [component('g1'), component('g2')],
});
const decision = (id, groupId, extra = {}) => ({
  schemaVersion: 1, id, groupId, comparedSnapshotIds: [], selectedOfferRevisionIds: [], outcome: 'stay_put',
  rationale: 'Synthetic rationale', acknowledgedRisks: [], gates: { business: 'supported', participation: 'financially_attractive' }, ...extra,
});
const confirmed = (extra = {}) => ({
  legalInstrumentName: 'Synthetic 2026 option grant', instrumentType: 'nso', grantDate: '2026-11-15', unitsGranted: '48000',
  strikePrice: '1.25', expirationDate: '2036-11-14', serviceStartDate: '2026-11-01',
  vesting: { commencementDate: '2026-11-01', totalMonths: 48, cliffMonths: 12, cadence: 'monthly', acceleration: 'none' },
  balanceAsOfDate: '2026-11-15', boardApproval: 'approved', ...extra,
});
const counts = async () => (await query(`
  SELECT (SELECT COUNT(*)::int FROM investments WHERE asset_class = 'employment_equity') AS positions,
         (SELECT COUNT(*)::int FROM employment_equity_grants) AS grants,
         (SELECT COUNT(*)::int FROM investment_lots) AS lots,
         (SELECT COUNT(*)::int FROM employment_equity_events) AS events,
         (SELECT COUNT(*)::int FROM earned_equity_grant_links) AS links,
         (SELECT COUNT(*)::int FROM investments) AS investments`))[0];

assert.equal(describeVesting(confirmed().vesting), '48-month monthly vesting from 2026-11-01, 12-month cliff, no acceleration');
assert.equal(describeVesting({ commencementDate: '2026-11-01', totalMonths: 36, cliffMonths: 0, cadence: 'quarterly', acceleration: 'double_trigger' }),
  '36-month quarterly vesting from 2026-11-01, no cliff, double-trigger acceleration');

const scratch = mkdtempSync(join(tmpdir(), 'radar-earned-links-'));
try {
  await withTenant(`file:${join(scratch, 'db')}`, async () => {
    await runMigrations();
    const issuer = await createEmploymentEquityIssuer({ legalName: 'Synthetic Link Co', relationshipStatus: 'other' });
    const entity = issuer.entity.id;
    await createGroup({ schemaVersion: 1, id: 'g1', mode: 'employment', currency: 'USD', startDate: '2026-11-01', horizonMonths: 48,
      discountRateAnnual: null, baseline: { kind: 'none', annualBase: null, annualCashBonus: null }, status: 'open' });
    const opp = (id, extra = {}) => ({ schemaVersion: 1, id, groupId: 'g1', companyName: `Synthetic ${id}`, relationship: 'employment', lifecycle: 'accepted', ...extra });
    await createOpportunity(opp('o1', { portfolioEntityId: entity }));
    await createOpportunity(opp('o2', { relationship: 'advisory' }));
    await addOfferRevision(revision('r1', 'o1'));
    await addOfferRevision(revision('r2', 'o2'));

    const portfolioBefore = await portfolioSummary();
    const budgetBefore = await annualDeploymentPlanReport({ budgetYear: 2026, fallbackAnnualBudget: 65000 });
    const employmentBefore = await employmentEquitySummary();
    const countsBefore = await counts();

    // Acceptance alone creates no holdings.
    await recordDecision(decision('d-stay', 'g1'));
    await recordDecision(decision('d1', 'g1', { outcome: 'selected', selectedOfferRevisionIds: ['r1'] }));
    assert.deepEqual(await counts(), countsBefore);

    const link = (extra = {}, confirmedExtra = {}) => linkConfirmedGrant({
      decisionId: 'd1', offerRevisionId: 'r1', componentId: 'g1', confirmed: confirmed(confirmedExtra), ...extra,
    });

    // Rejections create nothing.
    await assert.rejects(link({}, { boardApproval: 'pending' }), code('grant_not_approved'));
    await assert.rejects(link({}, { instrumentType: 'rsu' }), code('instrument_unsupported'));
    await assert.rejects(link({}, { unitsVestedConfirmed: '48001' }), code('invalid_vested_units'));
    await assert.rejects(link({}, { unitsGranted: '12.5' }), code('invalid_payload'));
    await assert.rejects(link({}, { surprise: 1 }), code('invalid_payload'));
    await assert.rejects(link({ componentId: 'nope' }), code('not_found'));
    await assert.rejects(link({ offerRevisionId: 'ghost' }), code('not_found'));
    await assert.rejects(link({ decisionId: 'd-stay' }), code('decision_superseded'));
    await assert.rejects(linkConfirmedGrant({ decisionId: 'd-stay', offerRevisionId: 'r1', componentId: 'g1', confirmed: confirmed() }), code('decision_superseded'));
    assert.deepEqual(await counts(), countsBefore);

    // A latest decision that does not select the revision is rejected; so is a superseded latest decision id.
    await recordDecision(decision('d-none', 'g1'));
    await assert.rejects(link({ decisionId: 'd-none' }), code('decision_not_selected'));
    await assert.rejects(link(), code('decision_superseded'));
    await recordDecision(decision('d2', 'g1', { outcome: 'selected', selectedOfferRevisionIds: ['r1'] }));
    await assert.rejects(link({ decisionId: 'd1' }), code('decision_superseded'));
    assert.deepEqual(await counts(), countsBefore);
    const linkOk = (extra = {}, confirmedExtra = {}) => link({ decisionId: 'd2', ...extra }, confirmedExtra);

    // Happy path: position + grant, vested defaults to zero, nothing computed.
    const first = await linkOk();
    assert.equal(first.created, true);
    assert.equal(first.positionCreated, true);
    const [grantRow] = await query('SELECT *, expiration_date::text AS exp, service_start_date::text AS svc FROM employment_equity_grants WHERE id = $1', [first.link.grantId]);
    assert.equal(Number(grantRow.units_vested_confirmed), 0);
    assert.equal(grantRow.status, 'active');
    assert.equal(grantRow.vesting_terms_summary, '48-month monthly vesting from 2026-11-01, 12-month cliff, no acceleration');
    assert.equal(grantRow.exp, '2036-11-14');
    assert.equal(grantRow.svc, '2026-11-01');
    assert.equal(Number(grantRow.units_granted), 48000);
    const [positionRow] = await query('SELECT acquisition_origin, instrument_family FROM employment_equity_positions WHERE investment_id = $1', [first.link.investmentId]);
    assert.equal(positionRow.acquisition_origin, 'employment');
    assert.equal(first.link.confirmedTerms.vesting.totalMonths, 48);
    assert.equal(first.link.confirmedTerms.unitsVestedConfirmed, '0');
    const after1 = await counts();
    assert.equal(after1.positions, countsBefore.positions + 1);
    assert.equal(after1.grants, countsBefore.grants + 1);
    assert.equal(after1.links, 1);
    assert.equal(after1.lots, countsBefore.lots);
    assert.equal(after1.events, countsBefore.events);

    // Retry is idempotent, even with a decision since superseded.
    const retry = await linkOk();
    assert.equal(retry.created, false);
    assert.equal(retry.link.id, first.link.id);
    assert.equal(retry.termsDiffer, false);
    assert.equal((await linkOk({}, { unitsGranted: '50000' })).termsDiffer, true);
    assert.deepEqual(await counts(), after1);

    // Refresh grant on the same position: 2 grants on 1 position; partial vested units are exact.
    await assert.rejects(linkOk({ componentId: 'g2', existingInvestmentId: 999999 }), code('not_found'));
    const other = await createEmploymentEquityIssuer({ legalName: 'Synthetic Other Co', relationshipStatus: 'other' });
    const foreign = await createEmploymentEquityPosition({ portfolioEntityId: other.entity.id, displayName: 'Foreign', instrumentFamily: 'nso', investDate: '2026-01-01' });
    await assert.rejects(linkOk({ componentId: 'g2', existingInvestmentId: Number(foreign.investment.id) }), code('position_mismatch'));
    const refresh = await linkOk({ componentId: 'g2', existingInvestmentId: first.link.investmentId },
      { unitsGranted: '48000', unitsVestedConfirmed: '12000', balanceAsOfDate: '2027-11-15' });
    assert.equal(refresh.positionCreated, false);
    assert.equal(refresh.link.investmentId, first.link.investmentId);
    const grants = await query('SELECT units_vested_confirmed FROM employment_equity_grants WHERE investment_id = $1 ORDER BY created_at, id', [first.link.investmentId]);
    assert.equal(grants.length, 2);
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM employment_equity_positions WHERE investment_id = $1`, [first.link.investmentId]))[0].n, 1);
    assert.deepEqual(grants.map(row => Number(row.units_vested_confirmed)).sort((a, b) => a - b), [0, 12000]);
    assert.equal((await listGrantLinks({ investmentId: first.link.investmentId })).length, 2);

    // Appears-after-linking invariants: earned equity is not direct portfolio; summary changes by the new position only.
    const portfolioAfter = await portfolioSummary();
    const budgetAfter = await annualDeploymentPlanReport({ budgetYear: 2026, fallbackAnnualBudget: 65000 });
    assert.deepEqual(portfolioAfter, portfolioBefore);
    assert.deepEqual(budgetAfter, budgetBefore);
    const employmentAfter = await employmentEquitySummary();
    assert.notDeepEqual(employmentAfter, employmentBefore);
    // Two positions were added to the ledger: the linked one and the foreign-company fixture.
    assert.equal(employmentAfter.position_count, employmentBefore.position_count + 2);
    assert.equal(employmentAfter.issuer_count, employmentBefore.issuer_count + 2);

    // Concurrent calls produce exactly one position and one link.
    await recordDecision(decision('d3', 'g1', { outcome: 'selected', selectedOfferRevisionIds: ['r2'] }));
    const before = await counts();
    const raced = await Promise.allSettled([0, 1].map(() => linkConfirmedGrant({
      decisionId: 'd3', offerRevisionId: 'r2', componentId: 'g1', legalName: 'Synthetic Advisory Co', confirmed: confirmed(),
    })));
    assert.deepEqual(raced.map(result => result.status), ['fulfilled', 'fulfilled']);
    assert.equal(raced.filter(result => result.value.created).length, 1);
    assert.equal(raced[0].value.link.id, raced[1].value.link.id);
    const afterRace = await counts();
    assert.equal(afterRace.positions, before.positions + 1);
    assert.equal(afterRace.grants, before.grants + 1);
    assert.equal(afterRace.links, before.links + 1);
    // Constraint backstops hold even if the model check is bypassed.
    await assert.rejects(query(`INSERT INTO earned_equity_grant_links (id, decision_id, offer_revision_id, grant_component_id, investment_id, grant_id, confirmed_terms)
      SELECT 'dup', decision_id, offer_revision_id, grant_component_id, investment_id, grant_id, confirmed_terms FROM earned_equity_grant_links LIMIT 1`), /unique|duplicate/i);
    await assert.rejects(query(`UPDATE earned_equity_grant_links SET grant_component_id = 'x'`), /append-only/);
    await assert.rejects(query(`DELETE FROM earned_equity_grant_links`), /append-only/);

    // The opportunity had no company: one was created, linked back (revision-guarded), and the position is an advisory origin.
    const o2 = await getOpportunityRow('o2');
    assert.ok(o2.portfolioEntityId);
    assert.equal(o2.revision, 2);
    assert.equal(o2.lifecycle, 'accepted');
    const [advisory] = await query('SELECT acquisition_origin FROM employment_equity_positions WHERE investment_id = $1', [raced[0].value.link.investmentId]);
    assert.equal(advisory.acquisition_origin, 'advisory');
    // No legal name for an unlinked opportunity is a clear error; offers, decisions and snapshots are untouched.
    await createOpportunity(opp('o3'));
    await addOfferRevision(revision('r3', 'o3'));
    await recordDecision(decision('d4', 'g1', { outcome: 'selected', selectedOfferRevisionIds: ['r3'] }));
    await assert.rejects(linkConfirmedGrant({ decisionId: 'd4', offerRevisionId: 'r3', componentId: 'g1', confirmed: confirmed() }), code('legal_name_required'));
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM earned_equity_decisions`))[0].n, 6);

    // Backup round trip includes the link table.
    const backup = await createDatabaseBackupPayload();
    assert.equal(Number(backup.tables.find(table => table.table === 'earned_equity_grant_links').rows), 3);
    const linksBackup = JSON.stringify(await listGrantLinks());
    await restoreDatabase({ content: backup.content });
    assert.equal(JSON.stringify(await listGrantLinks()), linksBackup);
    assert.deepEqual(await counts(), { ...afterRace, links: 3 });

    // Purge removes link rows but never the ledger.
    const ledger = async () => JSON.stringify([
      await query('SELECT * FROM investments ORDER BY id'), await query('SELECT * FROM employment_equity_positions ORDER BY investment_id'),
      await query('SELECT * FROM employment_equity_grants ORDER BY id'), await query('SELECT * FROM investment_lots ORDER BY id'),
      await query('SELECT * FROM employment_equity_events ORDER BY id'),
    ]);
    const ledgerBefore = await ledger();
    await purgeEarnedEquityOpportunity('o1');
    assert.equal((await counts()).links, 1);
    assert.equal(await ledger(), ledgerBefore);
    await purgeEarnedEquityGroup('g1');
    assert.equal((await counts()).links, 0);
    assert.equal(await ledger(), ledgerBefore);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM earned_equity_decisions'))[0].n, 0);

    // Command path: plan -> confirmation_required -> inline_confirmation, preview without salary or strike.
    await createGroup({ schemaVersion: 1, id: 'cg', mode: 'employment', currency: 'USD', startDate: '2026-11-01', horizonMonths: 48,
      discountRateAnnual: null, baseline: { kind: 'none', annualBase: null, annualCashBonus: null }, status: 'open' });
    await createOpportunity({ ...opp('co1', { groupId: 'cg', portfolioEntityId: entity }) });
    await addOfferRevision(revision('cr1', 'co1'));
    await recordDecision(decision('cd1', 'cg', { outcome: 'selected', selectedOfferRevisionIds: ['cr1'] }));
    const input = { decisionId: 'cd1', offerRevisionId: 'cr1', componentId: 'g1', confirmed: confirmed({ strikePrice: '3.14159' }) };
    const actorCapabilities = ['portfolio:apply:additive', 'portfolio:apply:metadata', 'portfolio:apply:destructive'];
    const plan = key => planCommandProposal([{ name: 'earned_equity.link_confirmed_grant', input }], {
      originSurface: 'manual_ui', actorType: 'user', actorId: 'test', intentText: key, idempotencyKey: `links:${key}` });
    await assert.rejects(planCommandProposal([{ name: 'earned_equity.link_confirmed_grant', input: { ...input, confirmed: confirmed({ boardApproval: 'pending' }) } }],
      { originSurface: 'manual_ui', actorType: 'user', actorId: 'test', intentText: 'bad', idempotencyKey: 'links:bad' }), /board-approved/);
    await assert.rejects(planCommandProposal([{ name: 'earned_equity.link_confirmed_grant', input: { ...input, decisionId: 'ghost' } }],
      { originSurface: 'manual_ui', actorType: 'user', actorId: 'test', intentText: 'bad2', idempotencyKey: 'links:bad2' }), /latest decision/);
    const planned = await plan('one');
    const preview = JSON.stringify(planned.proposal.previews);
    for (const secret of ['212345', '3.14159']) assert.ok(!preview.includes(secret), 'preview must not echo compensation');
    assert.match(preview, /48000/);
    assert.match(preview, /units_vested_confirmed/);
    const authorize = kind => authorizeCommandProposal(planned.proposal.id, planned.proposal.command_set_hash,
      { authorizationKind: kind, actorId: 'test', actorCapabilities });
    const beforeCommand = await counts();
    assert.equal((await authorize('explicit_imperative')).status, 'confirmation_required');
    assert.deepEqual(await counts(), beforeCommand);
    const applied = await authorize('inline_confirmation');
    assert.equal(applied.status, 'applied');
    const commandResult = applied.receipt.commands[0].result;
    assert.equal(commandResult.created, true);
    assert.equal((await counts()).links, 1);
    assert.equal((await counts()).positions, beforeCommand.positions + 1);
    // A fresh proposal for the same component previews as already linked and creates nothing.
    const again = await plan('two');
    assert.match(JSON.stringify(again.proposal.previews), /already linked/);
    const againApplied = await authorizeCommandProposal(again.proposal.id, again.proposal.command_set_hash,
      { authorizationKind: 'inline_confirmation', actorId: 'test', actorCapabilities });
    assert.equal(againApplied.receipt.commands[0].result.created, false);
    assert.equal((await counts()).links, 1);
    assert.equal((await counts()).positions, beforeCommand.positions + 1);
    // A second component of the same opportunity joins the first one's position without existingInvestmentId.
    const second = await linkConfirmedGrant({ decisionId: 'cd1', offerRevisionId: 'cr1', componentId: 'g2', confirmed: confirmed() });
    assert.equal(second.target, 'prior_link');
    assert.equal(second.positionCreated, false);
    assert.equal(second.link.investmentId, commandResult.link.investmentId);
    assert.equal((await counts()).positions, beforeCommand.positions + 1);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM employment_equity_grants WHERE investment_id = $1', [commandResult.link.investmentId]))[0].n, 2);
    assert.equal((await listGrantLinks({ offerRevisionId: 'cr1' })).length, 2);
    assert.equal(commandResult.target, 'new_position');
    console.log('Earned Equity confirmed-grant links: PASS');
  });
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
