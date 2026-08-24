import { query } from '../db/index.js';
import { createDecisionDraft, sealDecision } from './decisions.js';
import { tagInvestment, upsertInvestment } from './investments.js';
import { linkInviteToInvestment, setInviteStatus } from './pipeline.js';

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function sealedDecision(inviteId, dealEvaluationId) {
  return (await query(`
    SELECT * FROM decision_records
     WHERE sealed = TRUE
       AND (pipeline_invite_id = $1 OR ($2::int IS NOT NULL AND deal_evaluation_id = $2))
     ORDER BY sealed_at DESC NULLS LAST, id DESC LIMIT 1
  `, [inviteId, dealEvaluationId]))[0] || null;
}

async function finalizePipelineState(inviteId, investmentId, decision) {
  if (decision === 'invest') {
    if (!investmentId) throw new Error('Cannot commit invest decision without an investment id');
    await linkInviteToInvestment(inviteId, investmentId);
    await setInviteStatus(inviteId, 'committed', 'sealed invest decision in Radar');
  } else {
    await setInviteStatus(inviteId, 'passed', 'sealed pass decision in Radar');
  }
}

export async function sealPipelineDecision(fields) {
  const {
    inviteId, dealEvaluationId, companyName, decision,
    chosenSize, thesisId,
  } = fields;
  if (!['invest', 'pass'].includes(decision)) throw new Error('Decision must be invest or pass');
  if (decision === 'invest' && (!(chosenSize > 0) || !thesisId)) {
    throw new Error('An invest decision requires a positive chosen size and thesis');
  }
  const existing = await sealedDecision(inviteId, dealEvaluationId);
  if (existing) {
    await finalizePipelineState(inviteId, existing.investment_id, existing.decision);
    return { alreadySealed: true, decisionRecord: existing, investmentId: existing.investment_id };
  }

  let investmentId = null;
  if (decision === 'invest') {
    const investment = await upsertInvestment({
      company_name: companyName,
      status: 'Closing',
      invest_date: today(),
      invested: chosenSize,
      unrealized_value: chosenSize,
      realized_value: 0,
      net_value: chosenSize,
      multiple: 1,
      investment_entity: null,
      lead: fields.lead,
      investment_type: null,
      round: fields.round,
      stage_bucket: null,
      market: fields.market,
      fund_name: null,
      allocation: null,
      instrument: null,
      round_size: null,
      valuation_cap_type: null,
      valuation_cap: fields.valuationUsd,
      discount: null,
      carry: fields.carryPct,
      share_class: null,
      source: 'pipeline_decision',
    });
    investmentId = investment.id;
    await tagInvestment(investmentId, thesisId, {
      isPrimary: true, confidence: 'manual', taggedBy: 'decision_record', weight: 100,
    });
  }
  const draft = await createDecisionDraft({
    investment_id: investmentId,
    pipeline_invite_id: inviteId,
    deal_evaluation_id: dealEvaluationId,
    decision,
    what_was_known: fields.whatWasKnown,
    what_was_believed: fields.whatWasBelieved,
    key_risks: fields.keyRisks,
    bear_view: fields.bearView,
    confidence: fields.confidence,
    chosen_size: chosenSize,
  });
  const sealed = await sealDecision(draft.id, { sizing_basis: fields.sizingBasis });
  await finalizePipelineState(inviteId, investmentId, decision);
  return { alreadySealed: false, decisionRecord: sealed, investmentId };
}

export async function clearPipelineInvite(inviteId) {
  const [invite] = await query(`SELECT id, company_name, status FROM pipeline_invites WHERE id = $1`, [inviteId]);
  if (!invite) throw new Error('Pipeline deal not found');
  if (!['invite', 'committed'].includes(invite.status)) throw new Error('Only active pipeline deals can be cleared');
  await query(`
    UPDATE council_runs
       SET status = 'cancelled', stage = 'cancelled',
           error_message = 'Pipeline deal cleared by user',
           completed_at = NOW(), updated_at = NOW()
     WHERE pipeline_invite_id = $1 AND status = 'running'
  `, [inviteId]);
  await setInviteStatus(inviteId, 'archived', 'Cleared from active pipeline by user');
  return {
    id: Number(invite.id), companyName: invite.company_name,
    previousStatus: invite.status, status: 'archived',
  };
}

export async function reopenPassedPipelineDecision(inviteId) {
  const rows = await query(`
    WITH current_invite AS (
      SELECT id, status FROM pipeline_invites WHERE id = $1
    ), current_decision AS (
      SELECT id, decision FROM decision_records
       WHERE pipeline_invite_id = $1 AND sealed = TRUE
       ORDER BY sealed_at DESC NULLS LAST, id DESC LIMIT 1
    ), reopened AS (
      UPDATE decision_records AS decision
         SET sealed = FALSE, updated_at = NOW()
        FROM current_decision
       WHERE decision.id = current_decision.id AND current_decision.decision = 'pass'
      RETURNING decision.id
    ), updated_invite AS (
      UPDATE pipeline_invites AS invite
         SET status = 'invite', updated_at = NOW()
        FROM current_invite
       WHERE invite.id = current_invite.id AND EXISTS (SELECT 1 FROM reopened)
      RETURNING invite.id, current_invite.status AS old_status
    ), logged AS (
      INSERT INTO pipeline_events (invite_id, event_type, old_value, new_value, notes)
      SELECT id, 'status_change', old_status, 'invite',
             'Reopened prior pass for deal sizing; original decision record and sealed timestamp retained'
        FROM updated_invite RETURNING id
    )
    SELECT updated_invite.id AS invite_id, reopened.id AS decision_record_id
      FROM updated_invite CROSS JOIN reopened
  `, [inviteId]);
  if (rows.length !== 1) throw new Error('Only a sealed pass decision can be reopened for sizing');
  return rows[0];
}

export async function markPipelineInvestmentExecuted({ inviteId, executionDate, actualAmount }) {
  const rows = await query(`
    WITH target_invite AS (
      SELECT id, investment_id, status FROM pipeline_invites
       WHERE id = $1 AND status = 'committed' AND investment_id IS NOT NULL
    ), updated_investment AS (
      UPDATE investments AS investment
         SET status = 'Live', invest_date = $2::date, invested = $3,
             unrealized_value = $3, realized_value = 0, net_value = $3,
             multiple = 1, updated_at = NOW()
        FROM target_invite
       WHERE investment.id = target_invite.investment_id AND investment.status = 'Closing'
      RETURNING investment.id, investment.company_name
    ), updated_invite AS (
      UPDATE pipeline_invites AS invite SET status = 'invested', updated_at = NOW()
        FROM target_invite, updated_investment WHERE invite.id = target_invite.id
      RETURNING invite.id, target_invite.status AS old_status
    ), logged AS (
      INSERT INTO pipeline_events (invite_id, event_type, old_value, new_value, notes)
      SELECT id, 'status_change', old_status, 'invested', $4 FROM updated_invite RETURNING id
    )
    SELECT updated_invite.id AS invite_id, updated_investment.id AS investment_id,
           updated_investment.company_name, $2::date AS execution_date,
           $3::numeric AS actual_amount
      FROM updated_invite CROSS JOIN updated_investment
  `, [inviteId, executionDate, actualAmount, `Investment executed on ${executionDate} for $${actualAmount.toFixed(2)}`]);
  if (!rows[0]) throw new Error('Only a committed deal with a Closing portfolio position can be marked executed');
  return rows[0];
}
