#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { thesisDetail } from './thesis.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-thesis-detail-'));
const databaseUrl = `file:${join(scratch, 'db')}`;

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();
    const [thesis] = await query(`
      UPDATE theses
         SET lens_thesis_id = 'resilient-systems', active = TRUE,
             belief = 'Systems adapt.', proves_true = 'Durable revenue',
             proves_false = 'Fragile demand', conviction_now = 4
       WHERE name = 'Resilient Systems'
       RETURNING id
    `);
    assert.ok(thesis, 'the canonical Resilient Systems fixture must exist');
    await query('DELETE FROM investment_theses WHERE thesis_id = $1', [thesis.id]);
    const [live] = await query(`
      INSERT INTO investments
        (company_name, status, invest_date, invested, unrealized_value, realized_value, net_value, source, asset_class)
      VALUES ('Anuvi', 'Live', '2022-01-01', 100, 200, 0, 200, 'test', 'direct') RETURNING id
    `);
    const [realized] = await query(`
      INSERT INTO investments
        (company_name, status, invest_date, invested, unrealized_value, realized_value, net_value, source, asset_class)
      VALUES ('Rippling', 'Realized', '2021-01-01', 100, 0, 116, 116, 'test', 'direct') RETURNING id
    `);
    const [secondLive] = await query(`
      INSERT INTO investments
        (company_name, status, invest_date, invested, unrealized_value, realized_value, net_value, source, asset_class)
      VALUES ('Anuvi', 'Live', '2023-01-01', 100, 150, 0, 150, 'test', 'direct') RETURNING id
    `);
    const [outside] = await query(`
      INSERT INTO investments
        (company_name, status, invest_date, invested, unrealized_value, realized_value, net_value, source, asset_class)
      VALUES ('Outside Co', 'Live', '2023-01-01', 100, 500, 0, 500, 'test', 'direct') RETURNING id
    `);
    await query(`
      INSERT INTO investment_theses
        (investment_id, thesis_id, is_primary, weight, confidence, tagged_by)
      VALUES ($1, $3, TRUE, 100, 'manual', 'test'),
             ($2, $3, TRUE, 50, 'manual', 'test'),
             ($4, $3, TRUE, 100, 'manual', 'test')
    `, [live.id, realized.id, thesis.id, secondLive.id]);

    const byId = await thesisDetail(Number(thesis.id), { asOf: '2026-08-31' });
    assert.equal(byId.kind, 'thesis_detail');
    assert.equal(byId.thesis.name, 'Resilient Systems');
    assert.deepEqual(byId.positions.map(row => row.company_name), ['Anuvi', 'Anuvi', 'Rippling']);
    assert.equal(byId.positions.some(row => row.position_id === Number(outside.id)), false);
    assert.equal(byId.positions[2].status, 'Realized');
    assert.equal(byId.positions[2].attribution.weight_percent, 50);
    assert.equal(byId.positions[2].attributed_invested_capital, 50);
    assert.equal(byId.summary.position_count, 3);
    assert.equal(byId.summary.invested_basis, 250);
    assert.equal(byId.summary.net_value, 408);
    assert.equal(byId.summary.tvpi, 408 / 250);

    const bySlug = await thesisDetail({ slug: 'resilient-systems' }, { asOf: '2026-08-31' });
    assert.equal(bySlug.thesis.id, Number(thesis.id));
    const byName = await thesisDetail({ name: 'resilient--systems' }, { asOf: '2026-08-31' });
    assert.equal(byName.thesis.id, Number(thesis.id));
    assert.equal(await thesisDetail({ name: 'Imaginary Thesis' }), null);

    await query(`INSERT INTO theses (name, lens_thesis_id, active) VALUES ('Resilient--Systems', 'resilient-systems-2', FALSE)`);
    const ambiguous = await thesisDetail({ name: 'resilient systems' });
    assert.equal(ambiguous.kind, 'ambiguous_thesis');
    assert.equal(ambiguous.matches.length, 2);
  });
  console.log('thesis detail: canonical identity, membership, lifecycle, weighting, and ambiguity passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
