import assert from 'node:assert/strict';
import {
  descriptiveCoverage,
  historicalCoverage,
  validateMetricQuery,
} from './contract.js';

const query = validateMetricQuery({
  metric: 'dpi',
  groupBy: ['gp', 'vintage'],
  filters: { market: ['Aerospace', 'Defense'], invested_since: '2023-01-01' },
  window: { until: '2026-07-22' },
  excludeIds: ['7', 7, 9],
});

assert.deepEqual(query, {
  metric: 'dpi',
  groupBy: ['gp', 'vintage'],
  filters: { market: ['Aerospace', 'Defense'], invested_since: '2023-01-01' },
  window: { until: '2026-07-22' },
  excludeIds: [7, 9],
});

assert.throws(
  () => validateMetricQuery({ metric: 'made_up' }),
  /metric must be one of/,
);
assert.throws(
  () => validateMetricQuery({ metric: 'tvpi', groupBy: ['gp', 'gp'] }),
  /must be unique/,
);
assert.throws(
  () => validateMetricQuery({ metric: 'period_return', window: { since: '2026-01-01' } }),
  /requires window.since and window.until/,
);
assert.throws(
  () => validateMetricQuery({ metric: 'irr', window: { since: '2026-02-01', until: '2026-01-01' } }),
  /on or before/,
);
assert.throws(
  () => validateMetricQuery({ metric: 'irr', filters: { sql: 'DROP TABLE' } }),
  /unknown filter field/,
);

assert.deepEqual(
  historicalCoverage(
    [{ id: 1, company_name: 'Orbital Forge' }],
    [{ id: 1, company_name: 'Orbital Forge' }],
  ),
  {
    state: 'unavailable',
    positions: 1,
    missing_opening_positions: [{ id: 1, company_name: 'Orbital Forge' }],
  },
);

assert.deepEqual(
  descriptiveCoverage([
    { id: 1, company_name: 'Orbital Forge', current_value: 75, marked: true },
    { id: 2, company_name: 'Tidal Works', current_value: 25, marked: false },
  ]),
  {
    state: 'descriptive',
    positions: 2,
    marked: 1,
    value_share_marked: 0.75,
    unmarked_positions: [{ id: 2, company_name: 'Tidal Works' }],
  },
);

console.log('metric contract: all tests passed');
