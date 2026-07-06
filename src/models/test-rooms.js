#!/usr/bin/env node

import { query } from '../db/index.js';
import { upsertInvestment } from './investments.js';
import { upsertInvite } from './pipeline.js';
import {
  createRoom,
  addHolding,
  addPipelineItem,
  addView,
  updateView,
  deleteView,
  listRooms,
  getRoom,
} from './rooms.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function eq(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function ok(value, msg = 'expected truthy value') {
  if (!value) throw new Error(msg);
}

const BASE_INVESTMENT = {
  status: 'Live',
  invested: 5000,
  unrealized_value: null,
  realized_value: null,
  net_value: null,
  multiple: null,
  investment_entity: null,
  lead: 'Apex Syndicate',
  investment_type: null,
  round: 'Seed',
  stage_bucket: null,
  market: 'AI',
  fund_name: null,
  allocation: null,
  instrument: null,
  round_size: null,
  valuation_cap_type: null,
  valuation_cap: null,
  discount: null,
  carry: null,
  share_class: null,
  source: 'test',
};

async function cleanup(roomId, companyName, dealSlug) {
  if (roomId) {
    await query(`DELETE FROM rooms WHERE id = $1`, [roomId]);
  }

  if (dealSlug) {
    const invites = await query(`SELECT id FROM pipeline_invites WHERE deal_slug = $1`, [dealSlug]);
    if (invites.length > 0) {
      const inviteIds = invites.map(row => row.id);
      await query(`DELETE FROM pipeline_events WHERE invite_id = ANY($1::int[])`, [inviteIds]);
      await query(`DELETE FROM pipeline_invites WHERE id = ANY($1::int[])`, [inviteIds]);
    }
  }

  if (companyName) {
    const investments = await query(`SELECT id FROM investments WHERE company_name = $1`, [companyName]);
    if (investments.length > 0) {
      const investmentIds = investments.map(row => row.id);
      await query(`DELETE FROM investment_theses WHERE investment_id = ANY($1::int[])`, [investmentIds]);
      await query(`DELETE FROM investments WHERE id = ANY($1::int[])`, [investmentIds]);
    }
  }
}

async function run() {
  const stamp = Date.now();

  await test('create room -> add holding/pipeline/view -> getRoom nests presentational arrays', async () => {
    const company = `Test Rooms Holding ${stamp}`;
    const dealSlug = `test-rooms-pipeline-${stamp}`;
    let roomId = null;

    try {
      const investment = await upsertInvestment({
        ...BASE_INVESTMENT,
        company_name: company,
        invest_date: '2026-07-06',
      });

      const invite = await upsertInvite({
        gmail_message_id: `rooms-${stamp}@example.com`,
        email_received_at: '2026-07-06T10:00:00Z',
        source: 'test',
        deal_slug: dealSlug,
        company_name: company,
        status: 'invite',
      });

      const room = await createRoom({
        name: 'Radar Room',
        cols: [
          { key: 'company', label: 'Company' },
          { key: 'status', label: 'Status' },
        ],
      });
      roomId = room.id;

      const holding = await addHolding(room.id, {
        investment_id: investment.id,
        cells: {
          company: company,
          status: 'Live',
        },
      });
      eq(holding.room_id, room.id);

      const pipelineItem = await addPipelineItem(room.id, {
        pipeline_invite_id: invite.id,
        cells: {
          company,
          stage: 'Invite',
        },
      });
      eq(pipelineItem.room_id, room.id);

      const view = await addView(room.id, {
        name: 'Main',
        cols: [{ key: 'company', visible: true }],
        cells: { emphasis: 'company' },
      });
      eq(view.room_id, room.id);

      const loaded = await getRoom(room.id);
      ok(loaded, 'getRoom should return a room');
      eq(loaded.name, 'Radar Room');
      eq(loaded.cols.length, 2, 'room cols');
      eq(loaded.holdings.length, 1, 'holdings length');
      eq(loaded.pipeline.length, 1, 'pipeline length');
      eq(loaded.views.length, 1, 'views length');
      eq(loaded.holdings[0].investment_id, investment.id);
      eq(loaded.holdings[0].cells.company, company);
      eq(loaded.pipeline[0].pipeline_invite_id, invite.id);
      eq(loaded.pipeline[0].cells.stage, 'Invite');
      eq(loaded.views[0].name, 'Main');
      eq(loaded.views[0].cols[0].key, 'company');
      eq(loaded.views[0].cells.emphasis, 'company');

      const rooms = await listRooms();
      ok(rooms.some(row => row.id === room.id), 'listRooms should include the new room');
    } finally {
      await cleanup(roomId, company, dealSlug);
    }
  });

  await test('updateView and deleteView mutate only saved views', async () => {
    let roomId = null;

    try {
      const room = await createRoom({
        name: `View Room ${stamp}`,
        cols: [{ key: 'company' }],
      });
      roomId = room.id;

      const view = await addView(room.id, {
        name: 'Before',
        cols: [{ key: 'company', visible: true }],
        cells: { density: 'comfortable' },
      });

      const updated = await updateView(view.id, {
        name: 'After',
        cols: [{ key: 'status', visible: true }],
        cells: { density: 'compact' },
      });
      eq(updated.name, 'After');
      eq(updated.cols[0].key, 'status');
      eq(updated.cells.density, 'compact');

      const deleted = await deleteView(view.id);
      eq(deleted, true);

      const loaded = await getRoom(room.id);
      eq(loaded.views.length, 0, 'view should be deleted');
    } finally {
      await cleanup(roomId, null, null);
    }
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
