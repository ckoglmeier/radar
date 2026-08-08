import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { fundMetrics } from './funds.js';
import {
  applyFundsMigrationManifest,
  buildFundsMigrationManifest,
} from './funds-migration.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-funds-migration-'));
const databaseUrl = `file:${join(scratch, 'db')}`;

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();
    const entities = await query(`
      INSERT INTO portfolio_entities (legal_name, normalized_name, entity_type)
      VALUES
        ('Incisive Access Fund', 'incisive access fund', 'fund_vehicle'),
        ('Future Food Fund', 'future food fund', 'fund_vehicle'),
        ('Calm Company', 'calm company', 'operating_company')
      RETURNING id, legal_name
    `);
    const incisiveEntity = entities.find(row => row.legal_name === 'Incisive Access Fund');
    const futureEntity = entities.find(row => row.legal_name === 'Future Food Fund');
    const calmEntity = entities.find(row => row.legal_name === 'Calm Company');
    const positions = await query(`
      INSERT INTO investments
        (portfolio_entity_id, company_name, status, invest_date, invested, asset_class, source)
      VALUES
        ($1, 'Incisive Access Fund', 'Live', '2022-01-01', 100, 'fund', 'test'),
        ($2, 'Future Food Fund', 'Realized', '2023-01-01', 200, 'fund', 'test'),
        ($3, 'Calm Company Fund', 'Live', '2024-01-01', 50, 'direct', 'test')
      RETURNING id, company_name
    `, [incisiveEntity.id, futureEntity.id, calmEntity.id]);
    const incisive = positions.find(row => row.company_name === 'Incisive Access Fund');
    const future = positions.find(row => row.company_name === 'Future Food Fund');
    const flows = await query(`
      INSERT INTO cash_flows
        (investment_id, flow_date, type, amount, description, spv_raw,
         source, external_hash, reconciliation_status)
      VALUES
        ($1, '2022-02-01', 'investment', -100, 'Initial contribution', NULL,
         'test', 'legacy:contribution', 'matched'),
        (NULL, '2023-01-01', 'distribution', 10, 'Incisive distribution', 'Incisive Access Fund',
         'test', 'legacy:distribution', 'fund'),
        (NULL, '2023-02-01', 'distribution', 5, 'Correct ignored flow', 'Incisive Access Fund',
         'test', 'legacy:ignored', 'ignored'),
        (NULL, '2023-03-01', 'distribution', 7, 'Unknown fund flow', 'Unknown SPV',
         'test', 'legacy:unknown', 'fund')
      RETURNING id, description
    `, [incisive.id]);

    const manifest = await buildFundsMigrationManifest();
    assert.equal(manifest.profile_candidates.length, 2);
    assert.equal(manifest.flow_candidates.length, 4);
    assert.equal(manifest.conflicts.length, 0);
    manifest.profile_candidates.forEach(candidate => {
      candidate.decision = { action: 'migrate' };
    });
    manifest.flow_candidates.forEach(candidate => {
      candidate.decision = candidate.source.description === 'Unknown fund flow'
        ? { action: 'leave_unresolved' }
        : { action: 'attach', investment_id: Number(incisive.id) };
    });

    const applied = await applyFundsMigrationManifest(manifest);
    assert.equal(applied.failed, 0);
    assert.deepEqual(applied.unresolved_flows, [
      Number(flows.find(row => row.description === 'Unknown fund flow').id),
    ]);
    assert.equal(applied.reports.reduce((sum, report) => sum + report.profile_created, 0), 2);
    assert.equal(applied.reports.reduce((sum, report) => sum + report.flows_attached, 0), 3);

    const incisiveMetrics = await fundMetrics(incisive.id);
    assert.equal(incisiveMetrics.commitment, null);
    assert.equal(incisiveMetrics.paid_in, 100);
    assert.equal(incisiveMetrics.distributed, 15);
    assert.equal(incisiveMetrics.nav, null);
    const futureMetrics = await fundMetrics(future.id);
    assert.equal(futureMetrics.paid_in, null);
    assert.equal(futureMetrics.distributed, 0);
    assert.equal(futureMetrics.nav, null);
    assert.equal((await query(`
      SELECT fund_status FROM fund_profiles WHERE investment_id = $1
    `, [future.id]))[0].fund_status, 'realized');

    const [correctedIgnored] = await query(`
      SELECT investment_id, reconciliation_status
        FROM cash_flows WHERE description = 'Correct ignored flow'
    `);
    assert.equal(Number(correctedIgnored.investment_id), Number(incisive.id));
    assert.equal(correctedIgnored.reconciliation_status, 'matched');
    const [unresolved] = await query(`
      SELECT investment_id, reconciliation_status
        FROM cash_flows WHERE description = 'Unknown fund flow'
    `);
    assert.equal(unresolved.investment_id, null);
    assert.equal(unresolved.reconciliation_status, 'fund');

    const replay = await applyFundsMigrationManifest(manifest);
    assert.equal(replay.failed, 0);
    assert.equal(replay.reports.reduce((sum, report) => sum + report.profile_created, 0), 0);
    assert.equal(replay.reports.reduce((sum, report) => sum + report.flows_attached, 0), 0);
    assert.equal(replay.reports.reduce((sum, report) => sum + report.flows_unchanged, 0), 3);

    const tampered = structuredClone(manifest);
    tampered.flow_candidates[0].source.amount = '-999';
    await assert.rejects(
      () => applyFundsMigrationManifest(tampered),
      /modified after audit/,
    );

    const staleDb = await buildFundsMigrationManifest();
    staleDb.profile_candidates.forEach(candidate => {
      candidate.decision = { action: 'migrate' };
    });
    staleDb.flow_candidates.forEach(candidate => {
      candidate.decision = candidate.source.description === 'Unknown fund flow'
        ? { action: 'attach', investment_id: Number(incisive.id) }
        : { action: 'leave_unresolved' };
    });
    await query(`
      UPDATE cash_flows SET description = 'Changed after review'
       WHERE description = 'Unknown fund flow'
    `);
    const staleResult = await applyFundsMigrationManifest(staleDb);
    assert.equal(staleResult.failed, 1);
    assert.match(staleResult.reports.find(report => report.status === 'failed').error, /stale/);
  });

  console.log('funds migration: manifest, gated apply, unresolved flows, stale checks, and replay passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
