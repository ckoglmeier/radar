#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import {
  createMetricView,
  deleteMetricView,
  getMetricView,
  listMetricViews,
  updateMetricView,
} from './metric-views.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-metric-views-'));
const databaseUrl = `file:${join(scratch, 'db')}`;

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();

    const created = await createMetricView({
      name: ' DPI by GP ',
      query: { metric: 'dpi', groupBy: ['gp'] },
    });
    assert.equal(created.name, 'DPI by GP');
    assert.deepEqual(created.query, {
      metric: 'dpi', groupBy: ['gp'], filters: {}, window: {}, excludeIds: [],
    });
    assert.deepEqual((await listMetricViews()).map(view => view.id), [created.id]);
    assert.equal((await getMetricView(created.id)).name, 'DPI by GP');

    const updated = await updateMetricView(created.id, {
      name: 'Aerospace IRR',
      query: { metric: 'irr', filters: { market: 'Aerospace' } },
    });
    assert.equal(updated.name, 'Aerospace IRR');
    assert.equal(updated.query.metric, 'irr');
    assert.equal(updated.query.filters.market, 'Aerospace');

    await assert.rejects(
      () => createMetricView({ name: 'Unsafe', query: { metric: 'tvpi', sql: 'DROP TABLE' } }),
      /unknown metric query field/,
    );
    await assert.rejects(
      () => updateMetricView(999999, { name: 'Missing' }),
      /metric view not found/,
    );

    assert.equal(await deleteMetricView(created.id), true);
    assert.equal(await deleteMetricView(created.id), false);
    assert.equal(await getMetricView(created.id), null);
  });

  console.log('metric views: CRUD tests passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
