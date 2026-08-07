import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { saveCompanyAlias } from './company-aliases.js';
import {
  applyPortfolioEntityManifest,
  buildPortfolioEntityManifest,
} from './portfolio-entities.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-portfolio-entities-'));
const databaseUrl = `file:${join(scratch, 'db')}`;

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();

    const positions = await query(`
      INSERT INTO investments
        (company_name, status, invest_date, invested, asset_class, source)
      VALUES
        ('Identity Canonical, Inc.', 'Live', '2022-01-01', 1000, 'direct', 'test'),
        ('Identity Former Name', 'Live', '2023-01-01', 2000, 'direct', 'test'),
        ('Identity Canonical, Inc.', 'Live', '2024-01-01', 3000, 'employment_equity', 'test'),
        ('Range Fund II', 'Live', '2022-06-01', 4000, 'fund', 'test'),
        ('Range Fund III', 'Live', '2023-06-01', 5000, 'fund', 'test'),
        ('Identity Archived Duplicate', 'Live', '2021-01-01', 1000, 'merged', 'test'),
        ('Identity Archived Intermediate', 'Live', '2021-02-01', 1000, 'merged', 'test')
      RETURNING id, position_key, company_name, asset_class
    `);
    assert.equal(new Set(positions.map(row => row.position_key)).size, positions.length);
    assert.ok(positions.every(row => row.position_key));

    const canonical = positions.find(row => row.company_name === 'Identity Canonical, Inc.');
    const merged = positions.find(row => row.company_name === 'Identity Archived Duplicate');
    const mergedIntermediate = positions.find(row => row.company_name === 'Identity Archived Intermediate');
    await query(`
      INSERT INTO investment_consolidations
        (source_investment_id, target_investment_id, source_snapshot)
      VALUES
        ($1, $2, $3::jsonb),
        ($2, $4, $5::jsonb)
    `, [
      merged.id,
      mergedIntermediate.id,
      JSON.stringify({ company_name: merged.company_name }),
      canonical.id,
      JSON.stringify({ company_name: mergedIntermediate.company_name }),
    ]);

    const alias = await saveCompanyAlias({
      alias: 'Identity Former Name',
      canonicalCompanyName: 'Identity Canonical, Inc.',
      provenanceSource: 'test',
      provenanceNote: 'Reviewed legal-name change',
    });

    const manifest = await buildPortfolioEntityManifest();
    assert.deepEqual(await buildPortfolioEntityManifest(), manifest);
    assert.equal(manifest.conflicts.length, 0);
    assert.equal(manifest.merged_resolutions.length, 2);
    assert.ok(manifest.merged_resolutions.every(resolution =>
      resolution.target_investment_id === Number(canonical.id)
    ));
    assert.ok(manifest.merged_resolutions.some(resolution => resolution.path.length === 3));
    assert.ok(manifest.candidates.every(candidate =>
      !candidate.position_keys.includes(merged.position_key)
    ));

    const operating = manifest.candidates.find(candidate =>
      candidate.entity_type === 'operating_company'
    );
    const funds = manifest.candidates.filter(candidate => candidate.entity_type === 'fund_vehicle');
    assert.equal(operating.position_keys.length, 3);
    assert.deepEqual(operating.alias_ids, [Number(alias.id)]);
    assert.equal(funds.length, 2);
    assert.ok(funds.every(candidate => candidate.position_keys.length === 1));
    assert.notEqual(funds[0].entity_key, funds[1].entity_key);

    const constraint = await query(`
      SELECT 1
        FROM pg_constraint
       WHERE conrelid = 'investments'::regclass
         AND contype = 'u'
         AND pg_get_constraintdef(oid) LIKE '%company_name, invest_date%'
    `);
    assert.equal(constraint.length, 1, 'legacy importer uniqueness remains in place');

    const tampered = structuredClone(manifest);
    tampered.candidates[0].legal_name = 'Changed Outside Decision';
    tampered.candidates.forEach(candidate => {
      candidate.decision = { action: 'leave_unlinked' };
    });
    await assert.rejects(
      () => applyPortfolioEntityManifest(tampered),
      /modified after audit/,
    );

    const rollbackManifest = structuredClone(manifest);
    rollbackManifest.candidates.forEach(candidate => {
      candidate.decision = { action: 'leave_unlinked' };
    });
    rollbackManifest.candidates[0].decision = { action: 'create_and_link' };
    rollbackManifest.candidates[1].decision = {
      action: 'link_existing',
      entity_id: '00000000-0000-4000-8000-000000000001',
    };
    await assert.rejects(
      () => applyPortfolioEntityManifest(rollbackManifest),
      /references a missing entity/,
    );
    assert.equal((await query(`SELECT id FROM portfolio_entities`)).length, 0);
    assert.equal((await query(`
      SELECT id FROM investments WHERE portfolio_entity_id IS NOT NULL
    `)).length, 0);

    const reviewed = structuredClone(manifest);
    reviewed.candidates.forEach(candidate => {
      candidate.decision = { action: 'create_and_link' };
    });
    const applied = await applyPortfolioEntityManifest(reviewed);
    assert.deepEqual(applied, {
      entities_created: 3,
      positions_linked: 5,
      aliases_linked: 1,
      unchanged: 0,
    });

    const entities = await query(`
      SELECT entity_type, legal_name FROM portfolio_entities ORDER BY legal_name
    `);
    assert.equal(entities.filter(row => row.entity_type === 'operating_company').length, 1);
    assert.equal(entities.filter(row => row.entity_type === 'fund_vehicle').length, 2);
    const [linkedAlias] = await query(`
      SELECT portfolio_entity_id FROM company_aliases WHERE id = $1
    `, [alias.id]);
    assert.ok(linkedAlias.portfolio_entity_id);
    const mergedAfter = await query(`
      SELECT portfolio_entity_id FROM investments WHERE asset_class = 'merged'
    `);
    assert.ok(mergedAfter.every(row => row.portfolio_entity_id === null));

    const secondApply = await applyPortfolioEntityManifest(reviewed);
    assert.deepEqual(secondApply, {
      entities_created: 0,
      positions_linked: 0,
      aliases_linked: 0,
      unchanged: 5,
    });

    await query(`UPDATE investments SET instrument = 'changed' WHERE id = $1`, [canonical.id]);
    await assert.rejects(
      () => applyPortfolioEntityManifest(reviewed),
      /manifest is stale/,
    );

    await query(`
      UPDATE investment_consolidations
         SET target_investment_id = $1
       WHERE source_investment_id = $2
    `, [merged.id, mergedIntermediate.id]);
    const cycleManifest = await buildPortfolioEntityManifest();
    assert.ok(cycleManifest.conflicts.some(conflict =>
      conflict.reason === 'consolidation_cycle'
    ));
    await assert.rejects(
      () => applyPortfolioEntityManifest(cycleManifest),
      /unresolved conflict/,
    );

    const beforeKeys = positions.map(row => row.position_key).sort();
    assert.equal((await runMigrations()).applied, 0);
    const afterKeys = (await query(`
      SELECT position_key FROM investments ORDER BY position_key
    `)).map(row => row.position_key);
    assert.deepEqual(afterKeys, beforeKeys);
  });

  console.log('portfolio entities: additive identity and gated apply passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
