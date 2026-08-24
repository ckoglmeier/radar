import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { authorizeCommandProposal, planCommandProposal } from './service.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-pipeline-commands-'));
const databaseUrl = `file:${join(scratch, 'db')}`;
const actorCapabilities = ['portfolio:apply:metadata'];

async function run(name, input, key, authorizationKind = 'explicit_imperative') {
  const planned = await planCommandProposal([{ name, input }], {
    originSurface: 'ask_radar', actorType: 'user', actorId: 'test',
    intentText: key, idempotencyKey: `pipeline-command:${key}`,
  });
  return authorizeCommandProposal(planned.proposal.id, planned.proposal.command_set_hash, {
    authorizationKind, actorId: 'test', actorCapabilities,
  });
}

function decisionInput(inviteId, evaluationId, companyName, decision, fields = {}) {
  return {
    inviteId, dealEvaluationId: evaluationId, companyName, decision,
    chosenSize: null, thesisId: null, whatWasKnown: null, whatWasBelieved: null,
    keyRisks: null, bearView: null, confidence: 3, sizingBasis: null,
    lead: null, round: 'Seed', market: 'Software', valuationUsd: null, carryPct: null,
    ...fields,
  };
}

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();
    const [thesis] = await query(`SELECT id FROM theses WHERE active = TRUE ORDER BY id LIMIT 1`);
    const invites = await query(`
      INSERT INTO pipeline_invites (deal_slug, company_name, status, source)
      VALUES ('pass-co', 'Pass Co', 'invite', 'test'),
             ('invest-co', 'Invest Co', 'invite', 'test'),
             ('clear-co', 'Clear Co', 'invite', 'test')
      RETURNING id, company_name
    `);
    const evaluations = [];
    for (const invite of invites.slice(0, 2)) {
      evaluations.push((await query(`
        INSERT INTO deal_evaluations (pipeline_invite_id, eval_date, total_score, verdict)
        VALUES ($1, '2026-08-24', 35, 'Likely pass') RETURNING id
      `, [invite.id]))[0]);
    }

    const passInput = decisionInput(Number(invites[0].id), Number(evaluations[0].id), 'Pass Co', 'pass');
    assert.equal((await run('pipeline.seal_decision', passInput, 'seal-pass')).status, 'confirmation_required');
    assert.equal((await run('pipeline.seal_decision', passInput, 'seal-pass', 'inline_confirmation')).status, 'applied');
    assert.equal((await query('SELECT status FROM pipeline_invites WHERE id = $1', [invites[0].id]))[0].status, 'passed');

    assert.equal((await run('pipeline.reopen_decision', {
      inviteId: Number(invites[0].id),
    }, 'reopen-pass')).status, 'confirmation_required');
    assert.equal((await run('pipeline.reopen_decision', {
      inviteId: Number(invites[0].id),
    }, 'reopen-pass', 'inline_confirmation')).status, 'applied');

    const investInput = decisionInput(Number(invites[1].id), Number(evaluations[1].id), 'Invest Co', 'invest', {
      chosenSize: 10000, thesisId: Number(thesis.id),
    });
    assert.equal((await run('pipeline.seal_decision', investInput, 'seal-invest', 'inline_confirmation')).status, 'applied');
    const committed = (await query('SELECT status, investment_id FROM pipeline_invites WHERE id = $1', [invites[1].id]))[0];
    assert.equal(committed.status, 'committed');
    assert.equal((await run('pipeline.mark_executed', {
      inviteId: Number(invites[1].id), executionDate: '2026-08-24', actualAmount: 9500,
    }, 'execute-investment')).status, 'applied');
    assert.equal((await query('SELECT status, invested FROM investments WHERE id = $1', [committed.investment_id]))[0].status, 'Live');

    assert.equal((await run('pipeline.clear', {
      inviteId: Number(invites[2].id),
    }, 'clear-invite')).status, 'confirmation_required');
    assert.equal((await run('pipeline.clear', {
      inviteId: Number(invites[2].id),
    }, 'clear-invite', 'inline_confirmation')).status, 'applied');
    assert.equal((await query('SELECT status FROM pipeline_invites WHERE id = $1', [invites[2].id]))[0].status, 'archived');
  });
  console.log('Pipeline commands: seal pass/invest, reopen, execute, and clear passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
