import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createDocument } from './documents.js';
import {
  buildEmploymentEquityAudit,
  formatEmploymentEquityAuditSummary,
} from './employment-equity-audit.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-employment-equity-audit-'));
const databaseUrl = `file:${join(scratch, 'db')}`;

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();
    const entities = await query(`
      INSERT INTO portfolio_entities
        (legal_name, normalized_name, entity_type, legal_form, jurisdiction)
      VALUES
        ('Artwork Archive', 'artwork archive', 'operating_company', 'llc', NULL),
        ('Guild Education, Inc.', 'guild education', 'operating_company', 'c_corporation', 'Delaware')
      RETURNING id, legal_name
    `);
    const entityId = name => entities.find(row => row.legal_name === name).id;
    const positions = await query(`
      INSERT INTO investments
        (portfolio_entity_id, company_name, status, invest_date, invested,
         net_value, investment_entity, instrument, source, asset_class)
      VALUES
        ($1, 'Artwork Archive', 'Live', '2021-01-15', 0, 10000, 'Personal', 'PPU', 'manual', 'direct'),
        ($1, 'Artwork Archive', 'Live', '2022-06-01', 0, 20000, 'Personal', 'PPU', 'employment_record', 'direct'),
        ($2, 'Guild Education, Inc.', 'Live', '2020-03-10', 1000, 50000, 'Personal', 'ISO', 'manual', 'direct'),
        (NULL, 'Archived Artwork Record', 'Live', '2019-01-01', 0, 0, 'Personal', 'PPU', 'manual', 'merged'),
        (NULL, 'Unmatched Employer Equity', 'Live', '2024-01-01', 0, 0, 'Personal', 'RSU grant', 'employment_record', 'direct')
      RETURNING id, company_name
    `, [entityId('Artwork Archive'), entityId('Guild Education, Inc.')]);
    const positionsNamed = name => positions.filter(row => row.company_name === name);
    await query(`
      INSERT INTO investment_consolidations
        (source_investment_id, target_investment_id, source_snapshot)
      VALUES ($1, $2, '{}'::jsonb)
    `, [positionsNamed('Archived Artwork Record')[0].id, positionsNamed('Artwork Archive')[0].id]);
    await query(`
      INSERT INTO valuations
        (investment_id, snapshot_date, net_value, source)
      VALUES ($1, '2026-01-01', 10000, 'manual')
    `, [positionsNamed('Artwork Archive')[0].id]);
    await query(`
      INSERT INTO cash_flows
        (investment_id, flow_date, type, amount, source, external_hash)
      VALUES ($1, '2020-03-10', 'investment', -1000, 'test', 'ee-audit-guild-exercise')
    `, [positionsNamed('Guild Education, Inc.')[0].id]);
    await createDocument({
      entity_type: 'portfolio_entity',
      entity_id: entityId('Guild Education, Inc.'),
      filename: 'Guild Rule 701 disclosure.pdf',
      mime: 'application/pdf',
      content: Buffer.from('restricted source fixture'),
      confidentiality: 'confidential_company',
      processing_policy: 'local_only',
      sync_policy: 'local_only',
      executionMode: 'desktop',
    });
    const [room] = await query(`INSERT INTO rooms (name) VALUES ('Employment Equity') RETURNING id`);
    await query(`
      INSERT INTO room_holdings (room_id, cells)
      VALUES ($1, $2::jsonb)
    `, [room.id, JSON.stringify({ company: 'Guild Education', instrument: 'Option grant' })]);

    const before = {
      positions: Number((await query(`SELECT COUNT(*) AS n FROM investments`))[0].n),
      documents: Number((await query(`SELECT COUNT(*) AS n FROM documents`))[0].n),
    };
    const audit = await buildEmploymentEquityAudit();
    assert.deepEqual(await buildEmploymentEquityAudit(), audit, 'unchanged data produces an identical audit');
    const after = {
      positions: Number((await query(`SELECT COUNT(*) AS n FROM investments`))[0].n),
      documents: Number((await query(`SELECT COUNT(*) AS n FROM documents`))[0].n),
    };
    assert.deepEqual(after, before, 'audit is read-only');

    const artwork = audit.issuer_candidates.find(row => row.issuer_key === 'artwork_archive');
    const guild = audit.issuer_candidates.find(row => row.issuer_key === 'guild_education');
    assert.equal(artwork.status, 'found');
    assert.equal(artwork.confirmed_instrument_family, 'ppu');
    assert.equal(artwork.existing_positions.length, 2);
    assert.equal(guild.status, 'found');
    assert.equal(guild.proposed_entity.legal_form, 'c_corporation');
    assert.equal(guild.proposed_entity.jurisdiction, 'Delaware');
    assert.equal(audit.counts.document_candidates, 1);
    assert.equal(audit.document_candidates[0].processing_policy, 'local_only');
    assert.equal('content' in audit.document_candidates[0], false);
    assert.equal(audit.counts.unknown_document_policies, 0);
    assert.equal(audit.room_candidates.length, 1);
    assert.equal(audit.merged_resolutions.length, 1);
    assert.equal(audit.unmatched_employment_source_candidates.length, 1);
    assert.equal(audit.multiple_position_entities.length, 1);
    assert.equal(audit.direct_analytics_baseline.position_count, 4);
    assert.equal(audit.direct_analytics_if_all_candidates_reclassified.position_count, 1);
    assert.equal(audit.vesting_schedule_decision, 'defer_schedule_machinery');
    assert.ok(artwork.required_owner_confirmations.length > 0);
    assert.ok(guild.required_owner_confirmations.length > 0);
    assert.match(formatEmploymentEquityAuditSummary(audit), /No database records were changed/);
  });

  console.log('employment equity audit: read-only inventory and review candidates passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
