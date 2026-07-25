#!/usr/bin/env node

import { query } from '../db/index.js';
import {
  answerFounderFollowup,
  founderFollowupsForInvite,
  markFounderFollowupsApplied,
  pendingFounderFollowups,
} from './council-followups.js';
import { evaluationHistoryForInvite } from './evaluations.js';

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function eq(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`${message ? `${message}: ` : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function fixture() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const invite = await query(
    `INSERT INTO pipeline_invites (company_name, deal_slug, status)
     VALUES ($1, $2, 'invite')
     RETURNING id`,
    [`Founder Follow-up ${suffix}`, `founder-followup-${suffix}`],
  );
  const evaluation = await query(
    `INSERT INTO deal_evaluations
       (pipeline_invite_id, company_name, eval_date, total_score, verdict, raw_content)
     VALUES ($1, $2, CURRENT_DATE, 30, 'Worth exploring', $3)
     RETURNING id`,
    [
      invite[0].id,
      `Founder Follow-up ${suffix}`,
      `# Deal Log: Founder Follow-up ${suffix}

## Key Questions
- What is current net revenue retention?
- How many customers renewed in the last quarter?

## Total: 30/50`,
    ],
  );
  return { inviteId: invite[0].id, evaluationId: evaluation[0].id };
}

console.log('\n  Council founder follow-up persistence tests\n');

test('backfills legacy questions, stores a founder answer, applies it, and reopens an edited answer', async () => {
  const { inviteId, evaluationId } = await fixture();
  const initial = await founderFollowupsForInvite(inviteId);
  eq(initial.length, 2);
  eq(initial[0].status, 'open');
  eq(initial[0].priority, 'helpful');

  const answered = await answerFounderFollowup({
    questionId: initial[0].id,
    answer: 'Net revenue retention is 142% across 19 customers.',
  });
  eq(answered.status, 'answered');
  eq(answered.answer_source, 'founder');

  const pending = await pendingFounderFollowups(inviteId);
  eq(pending.length, 1);
  eq(pending[0].id, initial[0].id);

  const amendment = await query(
    `INSERT INTO deal_evaluations
       (pipeline_invite_id, company_name, eval_date, total_score, verdict,
        raw_content, council_parent_evaluation_id, council_run_type)
     VALUES ($1, 'Founder Follow-up Amendment', CURRENT_DATE, 33, 'Worth exploring',
             '# Deal Log: Founder Follow-up Amendment', $2, 'followup')
     RETURNING id`,
    [inviteId, evaluationId],
  );
  const history = await evaluationHistoryForInvite(inviteId);
  eq(history[0].id, amendment[0].id, 'explicit founder amendment becomes current');
  await markFounderFollowupsApplied([initial[0].id], amendment[0].id);
  const applied = await founderFollowupsForInvite(inviteId);
  const appliedQuestion = applied.find(question => question.id === initial[0].id);
  eq(appliedQuestion.status, 'applied');
  eq(Number(appliedQuestion.applied_total_score), 33);

  const edited = await answerFounderFollowup({
    questionId: initial[0].id,
    answer: 'Updated founder response with a verified cohort export.',
  });
  eq(edited.status, 'answered');
  eq(edited.applied_evaluation_id, null);
  eq((await pendingFounderFollowups(inviteId)).length, 1);

  await query('DELETE FROM deal_evaluations WHERE pipeline_invite_id = $1', [inviteId]);
  await query('DELETE FROM pipeline_invites WHERE id = $1', [inviteId]);
});

for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (error) { console.log(`  ✗ ${name}: ${error.message}`); failed++; }
}
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
