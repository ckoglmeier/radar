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

async function pipelineInvite(inviteId) {
  const [invite] = await query(`
    SELECT id, company_name, status, investment_id, min_investment_usd
      FROM pipeline_invites WHERE id = $1
  `, [inviteId]);
  if (!invite) throw new Error('Pipeline deal not found');
  return invite;
}

function withDealMinimum(sizingBasis, minimum) {
  if (!(minimum > 0)) return sizingBasis;
  return { ...(sizingBasis || {}), deal_minimum_usd: minimum };
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
  const invite = await pipelineInvite(inviteId);
  const dealMinimum = Number(invite.min_investment_usd || 0);
  if (decision === 'invest' && dealMinimum > 0 && Number(chosenSize) < dealMinimum) {
    throw new Error(
      `Chosen size ($${Number(chosenSize).toLocaleString('en-US')}) is below this deal's `
      + `$${dealMinimum.toLocaleString('en-US')} minimum. Pass or enter at least the minimum.`,
    );
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
  const sealed = await sealDecision(draft.id, {
    sizing_basis: withDealMinimum(fields.sizingBasis, dealMinimum),
  });
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

async function assertDisposableClosingInvestment(investmentId) {
  const [investment] = await query(`
    SELECT id, status, source FROM investments WHERE id = $1
  `, [investmentId]);
  if (!investment || investment.status !== 'Closing' || investment.source !== 'pipeline_decision') {
    throw new Error('Executed investments cannot be reconsidered from the pipeline');
  }

  const references = await query(`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (column_name = 'investment_id' OR column_name LIKE '%\\_investment\\_id' ESCAPE '\\')
     ORDER BY table_name, column_name
  `);
  const disposableLinks = new Set([
    'decision_records.investment_id',
    'pipeline_invites.investment_id',
    'investment_theses.investment_id',
    'investment_source_identities.investment_id',
  ]);
  for (const ref of references) {
    if (disposableLinks.has(`${ref.table_name}.${ref.column_name}`)) continue;
    const table = `"${String(ref.table_name).replaceAll('"', '""')}"`;
    const column = `"${String(ref.column_name).replaceAll('"', '""')}"`;
    const [usage] = await query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE ${column} = $1`, [investmentId]);
    if (Number(usage?.count || 0) > 0) {
      throw new Error('This investment has activity or economic records and cannot be reconsidered from the pipeline');
    }
  }
}

export async function reopenPipelineDecision(inviteId) {
  const invite = await pipelineInvite(inviteId);
  const [decision] = await query(`
    SELECT * FROM decision_records
     WHERE pipeline_invite_id = $1 AND sealed = TRUE
     ORDER BY sealed_at DESC NULLS LAST, id DESC LIMIT 1
  `, [inviteId]);
  if (!decision) throw new Error('No sealed pipeline decision is available to reconsider');

  let removedInvestmentId = null;
  if (decision.decision === 'pass') {
    if (invite.status !== 'passed' || invite.investment_id) {
      throw new Error('Only a current pass decision can be reconsidered');
    }
  } else if (decision.decision === 'invest') {
    if (invite.status !== 'committed' || !invite.investment_id) {
      throw new Error('Only an unexecuted committed decision can be reconsidered');
    }
    if (Number(decision.investment_id) !== Number(invite.investment_id)) {
      throw new Error('The committed position does not match the recorded decision');
    }
    await assertDisposableClosingInvestment(invite.investment_id);
    removedInvestmentId = Number(invite.investment_id);
  } else {
    throw new Error('Unsupported pipeline decision');
  }

  await query('UPDATE decision_records SET sealed = FALSE, updated_at = NOW() WHERE id = $1', [decision.id]);
  await query(`
    UPDATE pipeline_invites
       SET status = 'invite', investment_id = NULL, updated_at = NOW()
     WHERE id = $1
  `, [inviteId]);
  if (removedInvestmentId) {
    await query('DELETE FROM investments WHERE id = $1', [removedInvestmentId]);
  }
  await query(`
    INSERT INTO pipeline_events (invite_id, event_type, old_value, new_value, notes)
    VALUES ($1, 'status_change', $2, 'invite', $3)
  `, [
    inviteId,
    invite.status,
    removedInvestmentId
      ? 'Reconsidered unexecuted commitment; removed the generated Closing placeholder and retained the prior decision record'
      : 'Reconsidered prior pass; retained the original decision record and sealed timestamp',
  ]);
  return {
    invite_id: Number(inviteId),
    decision_record_id: Number(decision.id),
    previous_decision: decision.decision,
    removed_investment_id: removedInvestmentId,
  };
}

export const reopenPassedPipelineDecision = reopenPipelineDecision;

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
