import { query as defaultQuery } from '../db/index.js';
import { betSizeReport as defaultBetSizeReport } from './bet-sizing.js';

function jsonValue(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function action(type, label) {
  return { type, label };
}

export function selectPipelineNextAction(state) {
  if (['queued', 'running'].includes(state.runStatus)) {
    return { ready: false, reason: 'council_active', nextAction: action('wait_for_council', 'Wait for Council') };
  }
  if (state.runStatus === 'failed') {
    return { ready: false, reason: 'council_failed', nextAction: action('retry_council', 'Retry Council') };
  }
  if (!state.hasEvaluation) {
    return { ready: false, reason: 'evaluation_missing', nextAction: action('run_council', 'Run Council') };
  }
  if (state.criticalEvidenceMissing) {
    return { ready: false, reason: 'critical_evidence', nextAction: action('add_evidence', 'Add evidence') };
  }
  if (state.unresolvedCriticalQuestions > 0) {
    return { ready: false, reason: 'critical_question', nextAction: action('answer_followup', 'Answer critical question') };
  }
  if (state.sizingBlocked) {
    return { ready: false, reason: 'sizing_prerequisite', nextAction: action('complete_sizing', 'Complete sizing setup') };
  }
  if (!state.sealed) {
    return { ready: true, reason: 'ready_to_decide', nextAction: action('record_decision', 'Record decision') };
  }
  if (state.inviteStatus === 'committed') {
    return { ready: true, reason: 'committed', nextAction: action('mark_executed', 'Mark executed') };
  }
  return { ready: true, reason: 'complete', nextAction: action('none', 'No action required') };
}

export async function pipelineDecisionReadiness(inviteId, deps = {}) {
  const id = Number(inviteId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Pipeline invite id must be a positive integer');
  }
  const query = deps.query || defaultQuery;
  const betSizeReport = deps.betSizeReport || defaultBetSizeReport;
  const [invites, runs, evaluations, decisions, questions] = await Promise.all([
    query('SELECT id, company_name, status FROM pipeline_invites WHERE id = $1 LIMIT 1', [id]),
    query(
      `SELECT status FROM council_runs
       WHERE pipeline_invite_id = $1
       ORDER BY started_at DESC, id DESC LIMIT 1`,
      [id],
    ),
    query(
      `SELECT id, council_transaction_assessment
       FROM deal_evaluations
       WHERE pipeline_invite_id = $1
         AND COALESCE(promotes_to_canonical, TRUE)
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [id],
    ),
    query(
      `SELECT id, sealed, decision FROM decision_records
       WHERE pipeline_invite_id = $1
       ORDER BY sealed_at DESC NULLS LAST, created_at DESC, id DESC LIMIT 1`,
      [id],
    ),
    query(
      `SELECT COUNT(*)::int AS count
       FROM council_followup_questions
       WHERE pipeline_invite_id = $1
         AND priority = 'critical'
         AND resolution_state != 'resolved'`,
      [id],
    ),
  ]);
  const invite = invites[0];
  if (!invite) throw new Error(`Pipeline invite ${id} was not found`);
  const evaluation = evaluations[0] || null;
  const assessment = jsonValue(evaluation?.council_transaction_assessment);
  const parts = assessment
    ? [assessment.company, assessment.deal_economics, assessment.access_vehicle]
    : [];
  const criticalEvidenceMissing = parts.some(part =>
    part?.label === 'insufficient' && Array.isArray(part.blocking_facts) && part.blocking_facts.length > 0);
  let sizingBlocked = false;
  if (evaluation && !criticalEvidenceMissing && Number(questions[0]?.count || 0) === 0) {
    const sizing = await betSizeReport(invite.company_name);
    sizingBlocked = Boolean(sizing?.found && !sizing.pass && (sizing.kellySkipped || sizing.kellyError));
  }
  const selected = selectPipelineNextAction({
    runStatus: runs[0]?.status || null,
    hasEvaluation: Boolean(evaluation),
    criticalEvidenceMissing,
    unresolvedCriticalQuestions: Number(questions[0]?.count || 0),
    sizingBlocked,
    sealed: Boolean(decisions[0]?.sealed),
    inviteStatus: invite.status,
  });
  return {
    ...selected,
    inviteId: id,
    evaluationId: evaluation?.id || null,
    transactionAssessment: assessment,
    unresolvedCriticalQuestions: Number(questions[0]?.count || 0),
  };
}
