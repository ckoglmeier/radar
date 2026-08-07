import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createDocument } from './documents.js';
import { buildFundsAudit, formatFundsAuditSummary } from './funds-audit.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-funds-audit-'));
const databaseUrl = `file:${join(scratch, 'db')}`;

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();
    const entities = await query(`
      INSERT INTO portfolio_entities
        (legal_name, normalized_name, entity_type)
      VALUES
        ('Incisive Ventures Fund I', 'incisive ventures fund i', 'fund_vehicle'),
        ('Future of Food Fund', 'future of food fund', 'fund_vehicle'),
        ('Range Fund III', 'range fund iii', 'fund_vehicle')
      RETURNING id, legal_name
    `);
    const entityId = name => entities.find(row => row.legal_name === name).id;
    const positions = await query(`
      INSERT INTO investments
        (portfolio_entity_id, company_name, status, invest_date, invested,
         unrealized_value, net_value, asset_class, investment_entity, source)
      VALUES
        ($1, 'Incisive Ventures Fund I', 'Live', '2022-01-01', 100000, 110000, 110000, 'fund', 'CK LLC', 'test'),
        ($2, 'Future of Food Fund', 'Live', '2023-01-01', 50000, 52000, 52000, 'fund', 'CK LLC', 'test'),
        ($3, 'Range Fund III', 'Live', '2024-01-01', 25000, 25000, 25000, 'fund', 'CK LLC', 'test'),
        (NULL, 'Access Capital Opportunity', 'Live', '2025-01-01', 10000, 12000, 12000, 'direct', 'CK LLC', 'test'),
        (NULL, 'Incisive Archived Row', 'Live', '2021-01-01', 1000, 1000, 1000, 'merged', 'CK LLC', 'test')
      RETURNING id, company_name, position_key
    `, [
      entityId('Incisive Ventures Fund I'),
      entityId('Future of Food Fund'),
      entityId('Range Fund III'),
    ]);
    const position = name => positions.find(row => row.company_name === name);
    await query(`
      INSERT INTO investment_consolidations
        (source_investment_id, target_investment_id, source_snapshot)
      VALUES ($1, $2, '{}'::jsonb)
    `, [position('Incisive Archived Row').id, position('Incisive Ventures Fund I').id]);

    const [room] = await query(`
      INSERT INTO rooms (name, cols)
      VALUES ('Funds', $1::jsonb)
      RETURNING id
    `, [JSON.stringify([
      { key: 'fund_name', label: 'Fund' },
      { key: 'commitment', label: 'Commitment', type: 'money' },
      { key: 'vintage', label: 'Vintage', type: 'number' },
      { key: 'manager', label: 'Manager', type: 'text' },
    ])]);
    await query(`
      INSERT INTO room_holdings (room_id, investment_id, cells)
      VALUES
        ($1, $2, $3::jsonb),
        ($1, $2, $4::jsonb),
        ($1, NULL, $5::jsonb),
        ($1, NULL, $6::jsonb),
        ($1, $7, $8::jsonb),
        ($1, $9, $10::jsonb)
    `, [
      room.id,
      position('Incisive Ventures Fund I').id,
      JSON.stringify({ fund_name: 'Incisive Ventures', commitment: '$100,000', vintage: '2022', manager: 'Incisive' }),
      JSON.stringify({ fund_name: 'Incisive Ventures', commitment: '$100k', vintage: 2022 }),
      JSON.stringify({ fund_name: 'Range II', commitment: '$50k', vintage: '2021' }),
      JSON.stringify({ fund_name: 'S+H Capital', commitment: 'TBD', vintage: 'unknown' }),
      position('Access Capital Opportunity').id,
      JSON.stringify({ fund_name: 'Access Capital Opportunity', commitment: '$10,000' }),
      position('Incisive Archived Row').id,
      JSON.stringify({ fund_name: 'Incisive Ventures', commitment: '$100,000' }),
    ]);

    await query(`
      INSERT INTO valuations
        (investment_id, snapshot_date, unrealized_value, net_value, source)
      VALUES ($1, '2026-01-01', 110000, 110000, 'test')
    `, [position('Incisive Ventures Fund I').id]);
    await query(`
      INSERT INTO cash_flows
        (investment_id, flow_date, type, amount, company_raw, source, external_hash,
         reconciliation_status, reconciliation_note, contra_account)
      VALUES
        ($1, '2022-01-01', 'investment', -100000, 'Incisive Ventures Fund I', 'test', 'fund-audit-linked', 'matched', NULL, 'Cash:AngelList'),
        (NULL, '2024-06-01', 'investment', -50000, 'Range II', 'test', 'fund-audit-routed', 'fund', 'LP capital call', 'Cash:AngelList'),
        ($2, '2026-01-15', 'investment', -10000, 'Access Capital Opportunity', 'test', 'fund-audit-direct', 'matched', NULL, 'Cash:AngelList')
    `, [position('Incisive Ventures Fund I').id, position('Access Capital Opportunity').id]);
    await createDocument({
      entity_type: 'investment',
      entity_id: position('Incisive Ventures Fund I').id,
      filename: 'incisive-k1.pdf',
      mime: 'application/pdf',
      content: Buffer.from('private fixture bytes'),
      source: 'manual-upload',
    });

    const before = {
      investments: Number((await query(`SELECT COUNT(*) AS n FROM investments`))[0].n),
      holdings: Number((await query(`SELECT COUNT(*) AS n FROM room_holdings`))[0].n),
    };
    const audit = await buildFundsAudit();
    assert.deepEqual(await buildFundsAudit(), audit, 'unchanged data produces an identical audit');
    const after = {
      investments: Number((await query(`SELECT COUNT(*) AS n FROM investments`))[0].n),
      holdings: Number((await query(`SELECT COUNT(*) AS n FROM room_holdings`))[0].n),
    };
    assert.deepEqual(after, before, 'audit is read-only');

    assert.equal(audit.counts.fund_investments, 3);
    assert.equal(audit.counts.fund_rooms, 1);
    assert.equal(audit.counts.fund_room_holdings, 6);
    assert.equal(audit.counts.unlinked_room_holdings, 2);
    assert.equal(audit.counts.routed_fund_flows, 1);
    assert.equal(audit.duplicate_holding_links[0].holding_count, 2);
    assert.equal(audit.merged_resolutions.length, 1);
    assert.equal(audit.merged_resolutions[0].target_investment_id, Number(position('Incisive Ventures Fund I').id));

    const range = audit.holding_candidates.find(row => row.name === 'Range II');
    assert.equal(range.proposed_action, 'create_fund');
    assert.equal(range.parsed.commitment, 50000);
    const invalid = audit.holding_candidates.find(row => row.name === 'S+H Capital');
    assert.equal(invalid.parse_errors.length, 2);
    const direct = audit.holding_candidates.find(row => row.name === 'Access Capital Opportunity');
    assert.equal(direct.proposed_action, 'reclassify_direct');
    assert.ok(audit.fund_shaped_direct_candidates.some(row => row.id === direct.current_investment_id));
    assert.equal(audit.direct_analytics_baseline.position_count, 1);
    assert.equal(direct.direct_analytics_if_reclassified.position_count, 0);
    assert.equal(audit.fund_shaped_direct_candidates[0].if_reclassified.position_count, 0);

    assert.ok(audit.similar_fund_families.some(group =>
      group.records.some(row => row.name === 'Range II') &&
      group.records.some(row => row.name === 'Range Fund III')
    ));
    assert.ok(audit.expectations.every(item => item.status === 'found'));
    assert.equal(audit.fund_investments[0].documents[0].filename, 'incisive-k1.pdf');
    assert.equal('content' in audit.fund_investments[0].documents[0], false);
    assert.equal(audit.routed_fund_flows[0].source_account, 'Cash:AngelList');
    assert.equal(audit.routed_fund_flows[0].candidate_investments.length, 0);
    assert.ok(audit.holding_candidates.every(candidate => candidate.decision === null));
    assert.match(formatFundsAuditSummary(audit), /No database records were changed|Funds migration audit/);
  });

  console.log('funds audit: read-only inventory and review candidates passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
