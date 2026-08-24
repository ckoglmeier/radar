import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import {
  appendCommandMessage,
  createCommandThread,
  getCommandThread,
} from '../models/command-conversations.js';
import { assignPrimaryThesis, listTheses, primaryThesisAssignments } from '../models/theses.js';
import { thesisPerformance } from '../reports/thesis.js';
import {
  authorizeCommandProposal,
  commandMetadata,
  planCommandProposal,
  undoCommandReceipt,
} from './service.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-thesis-commands-'));
const databaseUrl = `file:${join(scratch, 'db')}`;
const actorCapabilities = ['portfolio:apply:metadata'];

async function plan(name, input, suffix) {
  const planned = await planCommandProposal([{ name, input }], {
    originSurface: 'ask_radar',
    actorType: 'user',
    actorId: 'test-user',
    intentText: suffix,
    idempotencyKey: `thesis-test:${suffix}`,
  });
  return planned.proposal;
}

async function authorize(proposal, authorizationKind = 'explicit_imperative') {
  return authorizeCommandProposal(proposal.id, proposal.command_set_hash, {
    authorizationKind,
    actorType: 'user',
    actorId: 'test-user',
    actorCapabilities,
  });
}

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();

    const thesisMetadata = commandMetadata().commands.filter(command => command.name.startsWith('thesis.'));
    assert.equal(thesisMetadata.length, 5);
    assert.ok(thesisMetadata.every(command => command.plannerExposure));
    assert.ok(thesisMetadata.every(command => command.undoPolicy === 'inverse'));

    const thread = await createCommandThread({ title: 'Legacy cleanup' });
    await appendCommandMessage(thread.id, { role: 'user', content: 'Move every position without a thesis to Legacy.' });
    assert.equal((await getCommandThread(thread.id)).messages.length, 1);

    const legacyCreate = await plan('thesis.create', { name: 'Legacy / No recorded thesis' }, 'create-legacy');
    const legacyApplied = await authorize(legacyCreate);
    assert.equal(legacyApplied.status, 'applied');
    assert.equal(legacyApplied.receipt.undo.available, true);
    const legacyId = legacyApplied.receipt.commands[0].result.thesis.id;

    const activeCreate = await plan('thesis.create', { name: 'Physical Intelligence' }, 'create-active');
    const activeApplied = await authorize(activeCreate);
    const activeId = activeApplied.receipt.commands[0].result.thesis.id;

    const investments = await query(`
      INSERT INTO investments
        (company_name, status, invest_date, invested, unrealized_value, net_value, source, asset_class)
      VALUES
        ('Unclassified One', 'Live', '2024-01-01', 1000, 1200, 1200, 'manual', 'direct'),
        ('Already Classified', 'Live', '2024-01-02', 2000, 2200, 2200, 'manual', 'direct'),
        ('Unclassified Two', 'Live', '2024-01-03', 3000, 3300, 3300, 'manual', 'direct')
      RETURNING id
    `);
    const ids = investments.map(row => Number(row.id));
    await assignPrimaryThesis(ids[1], activeId);

    const bulk = await plan('thesis.assign_primary_bulk', {
      investmentIds: ids,
      thesisId: legacyId,
      onlyIfUnassigned: true,
    }, 'assign-unclassified');
    const bulkApplied = await authorize(bulk);
    assert.equal(bulkApplied.status, 'applied');
    assert.deepEqual(
      (await primaryThesisAssignments(ids)).map(item => item.thesisId),
      [legacyId, activeId, legacyId],
    );

    const inactive = await plan('thesis.set_active', {
      thesisId: legacyId,
      active: false,
      effectiveDate: '2026-08-24',
      reason: 'Historical portfolio only',
    }, 'make-legacy-inactive');
    const inactiveApplied = await authorize(inactive);
    assert.equal(inactiveApplied.status, 'applied');
    assert.deepEqual((await listTheses()).map(row => row.name), ['Physical Intelligence']);
    const allTheses = await listTheses({ includeInactive: true });
    assert.equal(allTheses.find(row => row.id === legacyId).inactive_reason, 'Historical portfolio only');
    assert.ok((await thesisPerformance()).some(row => row.thesis === 'Legacy / No recorded thesis'));

    await undoCommandReceipt(inactiveApplied.receipt.id, { actorId: 'test-user', actorCapabilities });
    assert.ok((await listTheses()).some(row => row.id === legacyId));

    await undoCommandReceipt(bulkApplied.receipt.id, { actorId: 'test-user', actorCapabilities });
    assert.deepEqual(
      (await primaryThesisAssignments(ids)).map(item => item.thesisId),
      [null, activeId, null],
    );

    const overwrite = await plan('thesis.assign_primary_bulk', {
      investmentIds: [ids[1]],
      thesisId: legacyId,
      onlyIfUnassigned: false,
    }, 'overwrite-one');
    const confirmation = await authorize(overwrite);
    assert.equal(confirmation.status, 'confirmation_required');
    const overwritten = await authorize(overwrite, 'inline_confirmation');
    assert.equal(overwritten.status, 'applied');
    assert.equal((await primaryThesisAssignments([ids[1]]))[0].thesisId, legacyId);

    await assignPrimaryThesis(ids[1], activeId);
    await assert.rejects(
      undoCommandReceipt(overwritten.receipt.id, { actorId: 'test-user', actorCapabilities }),
      error => error.code === 'COMMAND_UNDO_STALE',
    );
    assert.equal((await primaryThesisAssignments([ids[1]]))[0].thesisId, activeId);
  });
  console.log('Thesis commands: lifecycle, Legacy bulk assignment, confirmation, receipts, and stale Undo passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
