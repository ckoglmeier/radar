import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import {
  createEmploymentEquityIssuer, createEmploymentEquityPosition, employmentEquitySummary,
} from './employment-equity.js';
import {
  addOfferRevision, createGroup, createOpportunity, getGroup, getOfferRevisionHistory, listGroups,
  recordAnalysisSnapshot, recordDecision, updateGroup, updateOpportunity, purgeEarnedEquityGroup, purgeEarnedEquityOpportunity,
} from './earned-equity-opportunities.js';
import { createDatabaseBackupPayload, restoreDatabase } from '../db/backup.js';
import { annualDeploymentPlanReport } from '../reports/deployment-plan.js';
import { portfolioSummary } from '../reports/portfolio.js';

const fact = (value, state = 'user_reported') => ({ value, state });
const hash = n => String(n).padStart(64, '0');
const group = (id, mode = 'employment', extra = {}) => ({
  schemaVersion: 1, id, mode, currency: 'USD', startDate: '2026-11-01', horizonMonths: 48, discountRateAnnual: '0.10',
  baseline: { kind: 'current_role', annualBase: '150000', annualCashBonus: '10000' }, status: 'open', ...extra,
});
const opp = (id, groupId, extra = {}) => ({
  schemaVersion: 1, id, groupId, companyName: `Synthetic ${id}`, relationship: 'employment', lifecycle: 'offer_received', ...extra,
});
const grant = () => ({
  componentId: 'g1', instrument: 'nso', units: fact('1000'), quotedOwnershipPct: fact('0.05'),
  ownershipDenominator: { basis: 'fully_diluted', asOfDate: '2026-10-01' }, strikePrice: fact('1.25'),
  grantDate: fact(null, 'missing'), boardApproval: fact('pending'),
  vesting: { commencementDate: fact('2026-11-01'), totalMonths: 48, cliffMonths: 12, cadence: 'monthly', acceleration: 'none' },
  exercise: { postTerminationWindowMonths: fact('3'), expirationYears: fact('10'), earlyExercise: fact(false) },
});
const revision = (id, opportunityId, supersedes = null, extra = {}) => ({
  schemaVersion: 1, id, opportunityId, supersedesRevisionId: supersedes, asOfDate: '2026-10-15', status: 'proposed', currency: 'USD',
  cash: { annualBase: fact('160000'), annualTargetBonus: fact('12000'), signingBonus: fact('0') },
  serviceStartDate: fact('2026-11-01'), grants: [grant()], ...extra,
});
const scenarioSet = revisionId => ({
  schemaVersion: 1, id: `set-${revisionId}`, offerRevisionId: revisionId, currency: 'USD',
  scenarios: [{ scenarioId: 's1', label: 'Zero outcome', kind: 'failure', weightPct: null, serviceMonths: 24,
    liquidity: { occurs: false, monthsFromStart: null }, payout: { method: 'none' }, exercisePath: { kind: 'at_liquidity' } }],
});
const decision = (id, groupId, extra = {}) => ({
  schemaVersion: 1, id, groupId, comparedSnapshotIds: [], selectedOfferRevisionIds: [], outcome: 'stay_put',
  rationale: 'Synthetic rationale', acknowledgedRisks: [], gates: { business: 'supported', participation: 'financially_attractive' }, ...extra,
});
const code = expected => error => error.code === expected;

const TABLES = ['earned_equity_decision_groups', 'earned_equity_opportunities', 'earned_equity_offer_revisions', 'earned_equity_analysis_snapshots', 'earned_equity_decisions'];
const dumpTables = async () => Object.fromEntries(await Promise.all(TABLES.map(async table => [table, await query(`SELECT * FROM ${table} ORDER BY ${table.includes('groups') || table.includes('opportunities') ? 'id' : 'seq'}`)])));
let backupContent; let rowsBefore;

const scratch = mkdtempSync(join(tmpdir(), 'radar-earned-opps-'));
try {
  await withTenant(`file:${join(scratch, 'db')}`, async () => {
    // Upgrade from an 083 workspace keeps existing rows and positions.
    await runMigrations();
    const issuer = await createEmploymentEquityIssuer({ legalName: 'Synthetic Legacy Co', relationshipStatus: 'other' });
    const position = await createEmploymentEquityPosition({
      portfolioEntityId: issuer.entity.id, instrumentFamily: 'nso', investDate: '2026-10-14', displayName: 'Legacy award',
      description: 'Pre-existing', firstGrant: { legalInstrumentName: 'Synthetic option', instrumentType: 'nso',
        grantDate: '2026-10-14', unitsGranted: 100, unitsVestedConfirmed: 100, balanceAsOfDate: '2026-10-14', strikePrice: 1 } });
    const history = await query('SELECT * FROM schema_migrations WHERE version < 84 ORDER BY version');
    // Later Earned Equity migrations depend on 084, so replay them together.
    await query('DROP TABLE earned_equity_grant_links');
    await query('DROP TABLE earned_equity_offer_reviews');
    await query('DROP TABLE earned_equity_company_reviews');
    await query('DROP TABLE earned_equity_document_reviews');
    await query('DROP FUNCTION radar_earned_equity_review_guard()');
    await query('DROP FUNCTION radar_earned_equity_document_reviews_guard()');
    await query('DROP TABLE earned_equity_decisions');
    await query('DROP TABLE earned_equity_analysis_snapshots');
    await query('DROP TABLE earned_equity_offer_revisions');
    await query('DROP TABLE earned_equity_opportunities');
    await query('DROP TABLE earned_equity_decision_groups');
    await query('DROP FUNCTION radar_earned_equity_append_only()');
    await query('DELETE FROM schema_migrations WHERE version >= 84');
    assert.deepEqual((await runMigrations()).migrations,
      ['084_earned_equity_opportunities', '085_earned_equity_document_reviews', '086_earned_equity_reviews', '087_earned_equity_grant_links']);
    assert.deepEqual(await query('SELECT * FROM schema_migrations WHERE version < 84 ORDER BY version'), history);
    assert.equal((await query('SELECT company_name FROM investments WHERE id = $1', [position.investment.id]))[0].company_name, 'Synthetic Legacy Co');
    assert.equal((await runMigrations()).applied, 0);

    const angelBefore = await portfolioSummary();
    const budgetBefore = await annualDeploymentPlanReport({ budgetYear: 2026, fallbackAnnualBudget: 65000 });
    const employmentBefore = await employmentEquitySummary();

    // CRUD round trips and schema rejection.
    const g = await createGroup(group('g1'));
    assert.equal(g.revision, 1);
    await assert.rejects(createGroup(group('g1')), code('already_exists'));
    await assert.rejects(createGroup({ ...group('gx'), mode: 'solo' }), code('invalid_payload'));
    await assert.rejects(createGroup({ ...group('gx'), extra: 1 }), code('invalid_payload'));
    const g2 = await updateGroup('g1', 1, group('g1', 'employment', { title: 'Fall 2026 offers' }));
    assert.equal(g2.revision, 2);
    await assert.rejects(updateGroup('g1', 1, group('g1')), code('stale_revision'));
    await assert.rejects(updateGroup('g1', 2, group('g1', 'advisory')), code('invalid_payload'));
    assert.deepEqual((await listGroups()).map(row => row.id), ['g1']);

    const entity = issuer.entity.id;
    const o1 = await createOpportunity(opp('o1', 'g1', { portfolioEntityId: entity }));
    assert.equal(o1.portfolioEntityId, entity);
    await createOpportunity(opp('o2', 'g1'));
    await createOpportunity(opp('o3', 'g1', { isStayPut: true, companyName: 'Current employer' }));
    await assert.rejects(createOpportunity(opp('o4', 'nope')), code('not_found'));
    await assert.rejects(createOpportunity(opp('o4', 'g1', { lifecycle: 'maybe' })), code('invalid_payload'));
    await assert.rejects(createOpportunity(opp('o4', 'g1', { portfolioEntityId: 'not-a-uuid' })), code('invalid_payload'));
    await assert.rejects(createOpportunity(opp('o4', 'g1'), entity), /disagrees/);
    await assert.rejects(createOpportunity(opp('o4', 'g1', { portfolioEntityId: '11111111-1111-4111-8111-111111111111' })), code('not_found'));
    const updated = await updateOpportunity('o1', 1, opp('o1', 'g1', { lifecycle: 'considering', role: 'Engineer', portfolioEntityId: entity }));
    assert.equal(updated.lifecycle, 'considering');
    assert.equal(updated.revision, 2);
    await assert.rejects(updateOpportunity('o1', 1, opp('o1', 'g1', { portfolioEntityId: entity })), code('stale_revision'));
    await assert.rejects(updateOpportunity('o1', 2, opp('o1', 'g1'), entity), /disagrees/);
    assert.equal((await query('SELECT portfolio_entity_id FROM earned_equity_opportunities WHERE id = $1', ['o1']))[0].portfolio_entity_id, entity);
    assert.equal((await query('SELECT lifecycle FROM earned_equity_opportunities WHERE id = $1', ['o1']))[0].lifecycle, 'considering');
    await assert.rejects(updateOpportunity('o1', 2, opp('o1', 'other-group', { portfolioEntityId: entity })), code('invalid_payload'));

    // Offer revisions: validation, head rule, concurrent supersession.
    await assert.rejects(addOfferRevision(revision('bad', 'o1', null, { currency: 'EUR' })), code('invalid_payload'));
    await assert.rejects(addOfferRevision(revision('bad', 'missing')), code('not_found'));
    const r1 = await addOfferRevision(revision('r1', 'o1'));
    assert.match(r1.payloadSha256, /^[0-9a-f]{64}$/);
    assert.equal(r1.asOfDate, '2026-10-15');
    await assert.rejects(addOfferRevision(revision('r1b', 'o1')), code('stale_revision'));
    await assert.rejects(addOfferRevision(revision('r2x', 'o1', 'ghost')), code('stale_revision'));
    const raced = await Promise.allSettled([
      addOfferRevision(revision('r2a', 'o1', 'r1')), addOfferRevision(revision('r2b', 'o1', 'r1')),
    ]);
    assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(raced.find(result => result.status === 'rejected').reason.code, 'stale_revision');
    const winner = raced.find(result => result.status === 'fulfilled').value.id;
    // The unique indexes hold even if the model check is bypassed.
    await assert.rejects(query(`INSERT INTO earned_equity_offer_revisions (id, opportunity_id, supersedes_revision_id, as_of_date, status, payload, payload_sha256)
      VALUES ('fork', 'o1', 'r1', '2026-10-15', 'proposed', '{}', $1)`, [hash(1)]), /unique|duplicate/i);
    await assert.rejects(query(`INSERT INTO earned_equity_offer_revisions (id, opportunity_id, supersedes_revision_id, as_of_date, status, payload, payload_sha256)
      VALUES ('second-root', 'o1', NULL, '2026-10-15', 'proposed', '{}', $1)`, [hash(1)]), /unique|duplicate/i);
    assert.deepEqual((await getOfferRevisionHistory('o1')).map(row => row.id), ['r1', winner]);

    // Append-only triggers.
    await assert.rejects(query("UPDATE earned_equity_offer_revisions SET status = 'signed' WHERE id = 'r1'"), /append-only/);
    await assert.rejects(query("DELETE FROM earned_equity_offer_revisions WHERE id = 'r1'"), /append-only/);

    // Snapshots: idempotent, validated, stale after a new revision.
    const first = await recordAnalysisSnapshot({ offerRevisionId: 'r1', scenarioSet: scenarioSet('r1'), result: { ok: true },
      calculatorVersion: 'c1', inputHash: hash(7), benchmark: null });
    assert.equal(first.idempotent, false);
    const again = await recordAnalysisSnapshot({ offerRevisionId: 'r1', scenarioSet: scenarioSet('r1'), result: { ok: true },
      calculatorVersion: 'c1', inputHash: hash(7) });
    assert.equal(again.idempotent, true);
    assert.equal(again.snapshot.id, first.snapshot.id);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM earned_equity_analysis_snapshots'))[0].n, 1);
    await assert.rejects(recordAnalysisSnapshot({ offerRevisionId: 'r1', scenarioSet: scenarioSet('r1'), result: {}, calculatorVersion: 'c1', inputHash: 'short' }), code('invalid_payload'));
    await assert.rejects(recordAnalysisSnapshot({ offerRevisionId: 'r1', scenarioSet: scenarioSet('other'), result: {}, calculatorVersion: 'c1', inputHash: hash(8) }), code('invalid_payload'));
    await assert.rejects(recordAnalysisSnapshot({ offerRevisionId: 'nope', scenarioSet: scenarioSet('nope'), result: {}, calculatorVersion: 'c1', inputHash: hash(8) }), code('not_found'));
    await assert.rejects(query('DELETE FROM earned_equity_analysis_snapshots'), /append-only/);
    await assert.rejects(query("UPDATE earned_equity_analysis_snapshots SET calculator_version = 'x'"), /append-only/);
    const current = await recordAnalysisSnapshot({ offerRevisionId: winner, scenarioSet: scenarioSet(winner), result: { ok: 1 }, calculatorVersion: 'c1', inputHash: hash(9), companyAssessmentRef: 'assess-1' });
    const view = await getGroup('g1');
    const flags = Object.fromEntries(view.snapshots.map(snapshot => [snapshot.offerRevisionId, snapshot.stale]));
    assert.deepEqual(flags, { r1: true, [winner]: false });
    const o1View = view.opportunities.find(row => row.id === 'o1');
    assert.equal(o1View.headRevision.id, winner);
    assert.equal(o1View.revisions.length, 2);
    assert.equal(view.latestDecision, null);
    assert.equal(current.snapshot.companyAssessmentRef, 'assess-1');

    // Decision rules.
    const r2 = await addOfferRevision(revision('r-o2', 'o2'));
    const r3 = await addOfferRevision(revision('r-o3', 'o3'));
    await createGroup(group('g-adv', 'advisory'));
    await createOpportunity(opp('a1', 'g-adv', { relationship: 'advisory' }));
    const a1 = await addOfferRevision(revision('r-a1', 'a1'));
    await createOpportunity(opp('a2', 'g-adv', { relationship: 'board' }));
    const a2 = await addOfferRevision(revision('r-a2', 'a2'));
    const pick = (id, groupId, ids, extra = {}) => decision(id, groupId, { outcome: 'selected', selectedOfferRevisionIds: ids, ...extra });
    await assert.rejects(recordDecision(pick('d0', 'g1', [])), code('invalid_decision'));
    await assert.rejects(recordDecision(decision('d0', 'g1', { outcome: 'decline_all', selectedOfferRevisionIds: [winner] })), code('invalid_decision'));
    await assert.rejects(recordDecision(decision('d0', 'g1', { outcome: 'deferred', selectedOfferRevisionIds: [winner] })), code('invalid_decision'));
    await assert.rejects(recordDecision(pick('d0', 'g1', ['r1'])), /superseded/);
    await assert.rejects(recordDecision(pick('d0', 'g1', [a1.id])), /belong/);
    await assert.rejects(recordDecision(pick('d0', 'g1', ['ghost'])), /belong/);
    await assert.rejects(recordDecision(pick('d0', 'g1', [winner, r2.id])), /at most one/);
    await assert.rejects(recordDecision(pick('d0', 'g1', [winner], { comparedSnapshotIds: ['ghost'] })), /snapshot/);
    await assert.rejects(recordDecision(pick('d0', 'g1', [winner], { gates: { business: 'supported', participation: 'learning_led_user_choice' } })), code('learning_judgment_required'));
    await assert.rejects(recordDecision(pick('d0', 'g1', [winner], { gates: { business: 'supported', participation: 'learning_led_user_choice' }, learningJudgment: null })), code('learning_judgment_required'));
    await assert.rejects(recordDecision({ ...pick('d0', 'g1', [winner]), outcome: 'maybe' }), code('invalid_payload'));
    // Two revisions of one opportunity: r1 is superseded, so exercise the same-opportunity rule in an advisory group.
    await addOfferRevision(revision('r-a1b', 'a1', 'r-a1'));
    await assert.rejects(recordDecision(pick('d0', 'g-adv', ['r-a1', 'r-a1b'])), /superseded/);
    await assert.rejects(recordDecision(pick('d0', 'g-adv', ['r-a1b', 'r-a1b'])), /twice/);
    // Advisory groups may select several opportunities.
    const multi = await recordDecision(pick('d-adv', 'g-adv', ['r-a1b', a2.id]));
    assert.equal(multi.payload.selectedOfferRevisionIds.length, 2);

    const judgment = { expectedLearning: 'Synthetic learning', whyThisRole: 'Synthetic reason', compensatesForShortfall: true };
    const d1 = await recordDecision(pick('d1', 'g1', [winner], { comparedSnapshotIds: [current.snapshot.id],
      gates: { business: 'supported', participation: 'learning_led_user_choice' }, learningJudgment: judgment }));
    assert.equal(d1.groupId, 'g1');
    await recordDecision(decision('d2', 'g1', { outcome: 'deferred' }));
    assert.equal((await getGroup('g1')).latestDecision.id, 'd2');
    await assert.rejects(recordDecision(decision('d2', 'g1')), code('already_exists'));
    await assert.rejects(query("UPDATE earned_equity_decisions SET group_id = 'g1'"), /append-only/);
    await assert.rejects(query('DELETE FROM earned_equity_decisions'), /append-only/);
    assert.equal(r3.id, 'r-o3');

    // Prospects never touch Angel totals, grant balances or the employment summary.
    assert.deepEqual(await portfolioSummary(), angelBefore);
    assert.deepEqual(await annualDeploymentPlanReport({ budgetYear: 2026, fallbackAnnualBudget: 65000 }), budgetBefore);
    assert.deepEqual(await employmentEquitySummary(), employmentBefore);
    assert.equal((await query("SELECT COUNT(*)::int AS n FROM investments WHERE asset_class = 'employment_equity'"))[0].n, 1);

    // Chain of length 3 for the backup round trip (o1 already has r1 -> winner).
    const third = await addOfferRevision(revision('r3-chain', 'o1', winner));
    await recordAnalysisSnapshot({ offerRevisionId: third.id, scenarioSet: scenarioSet(third.id), result: { n: 3 }, calculatorVersion: 'c1', inputHash: hash(11) });
    await recordDecision(decision('d3', 'g1', { outcome: 'selected', selectedOfferRevisionIds: [third.id] }));
    rowsBefore = await dumpTables();
    backupContent = (await createDatabaseBackupPayload()).content;

    // Purge: plain deletes stay blocked; purge removes the tree atomically.
    await assert.rejects(query("DELETE FROM earned_equity_offer_revisions WHERE id = 'r-a2'"), /append-only/);
    const purged = await purgeEarnedEquityOpportunity('a2');
    assert.deepEqual(purged, { opportunities: 1, revisions: 1, snapshots: 0, decisions: 1 });
    assert.equal(await getGroup('g-adv').then(view => view.opportunities.length), 1);
    assert.equal((await getGroup('g-adv')).latestDecision, null);
    await assert.rejects(query("DELETE FROM earned_equity_decisions"), /append-only/);
    await assert.rejects(purgeEarnedEquityOpportunity('a2'), code('not_found'));
    const groupPurge = await purgeEarnedEquityGroup('g1');
    assert.equal(groupPurge.group, 1);
    assert.equal(await getGroup('g1'), null);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM earned_equity_analysis_snapshots'))[0].n, 0);
    assert.deepEqual(await portfolioSummary(), angelBefore);
  });

  // Restore into a fresh workspace; shuffle rows to prove dependency ordering.
  const dump = JSON.parse(backupContent);
  for (const table of TABLES) dump.tables[table].reverse();
  await withTenant(`file:${join(scratch, 'restored')}`, async () => {
    await runMigrations();
    await restoreDatabase({ content: JSON.stringify(dump) });
    assert.deepEqual(await dumpTables(), rowsBefore);
    const view = await getGroup('g1');
    assert.equal(view.opportunities.find(row => row.id === 'o1').headRevision.id, 'r3-chain');
    assert.equal(view.latestDecision.id, 'd3');
    assert.deepEqual(view.snapshots.map(row => row.stale), [true, true, false]);
    // New rows after restore continue the sequence order and chain.
    await addOfferRevision(revision('r4-chain', 'o1', 'r3-chain'));
    await recordDecision(decision('d4', 'g1', { outcome: 'deferred' }));
    assert.equal((await getGroup('g1')).latestDecision.id, 'd4');
    assert.deepEqual((await getOfferRevisionHistory('o1')).map(row => row.id).slice(-2), ['r3-chain', 'r4-chain']);
    await assert.rejects(query("UPDATE earned_equity_offer_revisions SET status = 'signed'"), /append-only/);
    console.log('Earned Equity opportunity persistence: PASS');
  });
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
