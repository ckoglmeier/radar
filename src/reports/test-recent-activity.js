#!/usr/bin/env node

import assert from 'node:assert/strict';
import { projectRecentActivity } from './recent-activity.js';

const rows = projectRecentActivity({
  receipts: [{
    id: 'receipt-1', created_at: '2026-08-24T10:00:00Z',
    receipt: {
      commands: [{ name: 'pipeline.seal_decision' }],
      affectedResources: [{ type: 'pipeline_invite', id: 7, label: 'Acme' }],
    },
  }],
  councilEvents: [{
    id: 13, event_type: 'completed', occurred_at: '2026-08-24T11:00:00Z',
    company_name: 'Acme', deal_slug: 'acme',
  }],
  pipelineEvents: [
    { id: 9, invite_id: 7, event_type: 'status_change', event_date: '2026-08-24T10:00:00Z', company_name: 'Acme', deal_slug: 'acme' },
    { id: 8, invite_id: 8, event_type: 'invite_received', event_date: '2026-08-23T10:00:00Z', company_name: 'Beta', deal_slug: 'beta' },
  ],
  updates: [{ id: 'update-1', created_at: '2026-08-22T10:00:00Z', company_name: 'Gamma' }],
  pipelineSlugs: new Map([[7, 'acme']]),
});

assert.deepEqual(rows.map(row => row.key), [
  'council:13', 'receipt:receipt-1', 'pipeline:8', 'update:update-1',
]);
assert.equal(rows[0].detail, 'Council evaluation completed');
assert.equal(rows[1].detail, 'Decision recorded');
assert.equal(rows[1].href, '/pipeline/acme');
assert.equal(rows.some(row => row.key === 'pipeline:9'), false, 'receipt suppresses duplicate legacy event');
assert.equal(rows[2].occurredAt, '2026-08-23T10:00:00Z', 'uses immutable event time');

console.log('recent activity: receipt/event projection passed');
