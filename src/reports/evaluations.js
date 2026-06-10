// Pure data fetchers for deal evaluations. Thin wrappers over the model layer.

import { listEvaluations, getEvaluationByCompany } from '../models/evaluations.js';
import { query } from '../db/index.js';
import { calculateIRR } from '../utils/irr.js';
import { runAnalytics } from '../utils/analytics.js';
import { getActiveThesisNames } from '../lenses/loader.js';

export async function evalList() {
  return listEvaluations();
}

export async function evalDetail(search) {
  return getEvaluationByCompany(search);
}

export async function evalDiscover(opts = {}) {
  const { since, until } = opts;

  // Build date filter
  const conditions = [];
  const params = [];
  if (since) { params.push(since); conditions.push(`i.invest_date >= $${params.length}`); }
  if (until) { params.push(until); conditions.push(`i.invest_date <= $${params.length}`); }
  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // Fetch investments with outcomes + all attributes
  const rows = await query(`
    SELECT
      i.id,
      i.company_name AS company,
      ie.best_multiple AS multiple,
      i.status,
      i.invest_date,
      COALESCE(i.stage_bucket, 'unknown') AS stage,
      i.market,
      i.lead,
      i.round,
      i.instrument,
      ie.eff_unrealized_value AS unrealized_value
    FROM investments i
    LEFT JOIN investments_effective ie ON ie.id = i.id
    ${whereClause}
    ORDER BY i.invest_date DESC
  `, params);

  // Fetch thesis tags for all investments
  const thesisRows = await query(`
    SELECT it.investment_id, t.name
    FROM investment_theses it
    JOIN theses t ON t.id = it.thesis_id
  `);
  const thesesByInvestment = {};
  for (const tr of thesisRows) {
    if (!thesesByInvestment[tr.investment_id]) thesesByInvestment[tr.investment_id] = [];
    thesesByInvestment[tr.investment_id].push(tr.name);
  }

  // Compute per-investment IRR
  const investmentIds = rows.map(r => r.id);
  let cfByInvestment = {};
  if (investmentIds.length > 0) {
    const cfRows = await query(`
      SELECT investment_id, flow_date AS date, amount
      FROM cash_flows
      WHERE investment_id = ANY($1)
      ORDER BY flow_date
    `, [investmentIds]);
    for (const cf of cfRows) {
      const id = cf.investment_id;
      if (!cfByInvestment[id]) cfByInvestment[id] = [];
      cfByInvestment[id].push({ date: cf.date, amount: Number(cf.amount) });
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const investments = rows.map(r => {
    let irr = null;
    const flows = [...(cfByInvestment[r.id] || [])];
    const unrealized = Number(r.unrealized_value || 0);
    if (unrealized > 0) flows.push({ date: today, amount: unrealized });
    irr = flows.length >= 2 ? calculateIRR(flows) : null;

    return {
      company: r.company || 'Unknown',
      multiple: r.multiple != null ? Number(r.multiple) : null,
      irr,
      status: r.status || 'unknown',
      invest_date: r.invest_date ? r.invest_date.toISOString?.().slice(0, 10) || String(r.invest_date).slice(0, 10) : null,
      stage: r.stage,
      market: r.market || null,
      lead: r.lead || null,
      round: r.round || null,
      instrument: r.instrument || null,
      theses: thesesByInvestment[r.id] || [],
    };
  });

  return runAnalytics('thesis_validation', 'discover', {
    investments,
    active_theses: getActiveThesisNames(),
  });
}

export async function evalValidate(opts = {}) {
  const { since, until, mode } = opts;

  // Build date filter
  const conditions = ['de.total_score IS NOT NULL'];
  const params = [];
  if (since) { params.push(since); conditions.push(`i.invest_date >= $${params.length}`); }
  if (until) { params.push(until); conditions.push(`i.invest_date <= $${params.length}`); }
  if (mode && mode !== 'standard') { params.push(mode); conditions.push(`de.eval_mode = $${params.length}`); }
  const whereClause = 'WHERE ' + conditions.join(' AND ');

  // Fetch evaluations with investment outcomes
  const rows = await query(`
    SELECT
      de.total_score AS score,
      de.verdict,
      de.invested,
      de.council_bull_score,
      de.council_bear_score,
      de.council_calibrator_score,
      de.council_spread,
      de.council_consensus,
      de.council_divergence,
      de.council_cfo_verdict,
      COALESCE(i.company_name, pi.company_name) AS company,
      i.status,
      i.invest_date,
      ie.best_multiple AS multiple,
      COALESCE(ie.best_total_value, i.invested) AS net_value,
      i.invested AS invested_amount,
      ie.eff_unrealized_value AS unrealized_value,
      i.id AS investment_id,
      COALESCE(i.stage_bucket, 'unknown') AS stage
    FROM deal_evaluations de
    LEFT JOIN investments i ON de.investment_id = i.id
    LEFT JOIN investments_effective ie ON ie.id = i.id
    LEFT JOIN pipeline_invites pi ON de.pipeline_invite_id = pi.id
    ${whereClause}
    ORDER BY de.total_score DESC
  `, params);

  // Compute per-investment IRR for linked deals
  const investmentIds = rows.filter(r => r.investment_id).map(r => r.investment_id);
  let cfByInvestment = {};
  if (investmentIds.length > 0) {
    const cfRows = await query(`
      SELECT investment_id, flow_date AS date, amount
      FROM cash_flows
      WHERE investment_id = ANY($1)
      ORDER BY flow_date
    `, [investmentIds]);
    for (const cf of cfRows) {
      const id = cf.investment_id;
      if (!cfByInvestment[id]) cfByInvestment[id] = [];
      cfByInvestment[id].push({ date: cf.date, amount: Number(cf.amount) });
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const deals = rows.map(r => {
    let irr = null;
    if (r.investment_id) {
      const flows = [...(cfByInvestment[r.investment_id] || [])];
      const unrealized = Number(r.unrealized_value || 0);
      if (unrealized > 0) flows.push({ date: today, amount: unrealized });
      irr = flows.length >= 2 ? calculateIRR(flows) : null;
    }

    return {
      company: r.company || 'Unknown',
      score: r.score != null ? Number(r.score) : null,
      multiple: r.multiple != null ? Number(r.multiple) : null,
      irr,
      status: r.status || 'not invested',
      invest_date: r.invest_date ? r.invest_date.toISOString?.().slice(0, 10) || String(r.invest_date).slice(0, 10) : null,
      stage: r.stage,
      verdict: r.verdict,
      invested: Boolean(r.invested),
      council_bull: r.council_bull_score != null ? Number(r.council_bull_score) : null,
      council_bear: r.council_bear_score != null ? Number(r.council_bear_score) : null,
      council_calibrator: r.council_calibrator_score != null ? Number(r.council_calibrator_score) : null,
      council_spread: r.council_spread != null ? Number(r.council_spread) : null,
      council_consensus: r.council_consensus != null ? Number(r.council_consensus) : null,
      council_divergence: r.council_divergence || null,
      council_cfo_verdict: r.council_cfo_verdict || null,
    };
  });

  // Ship to Python analytics sidecar
  const result = runAnalytics('thesis_validation', 'validate', { deals });
  result.deals = deals; // attach raw data for the printer
  return result;
}

/**
 * Pipeline reconciliation: find pipeline passes that scored 39+ in deal_evaluations.
 * These are deals that were passed at the pipeline stage but the grading skill
 * thinks deserve a second look.
 */
export async function evalReconcile({ threshold = 39 } = {}) {
  const rows = await query(`
    SELECT
      pi.id AS invite_id,
      pi.company_name,
      pi.status AS pipeline_status,
      pi.round,
      pi.valuation_usd,
      pi.lead AS lead_gp,
      pi.email_received_at,
      de.total_score,
      de.verdict,
      de.council_bull_score,
      de.council_bear_score,
      de.council_calibrator_score,
      de.council_cfo_verdict,
      de.eval_date
    FROM pipeline_invites pi
    JOIN deal_evaluations de ON de.pipeline_invite_id = pi.id
    WHERE pi.status = 'passed'
      AND de.total_score >= $1
    ORDER BY de.total_score DESC
  `, [threshold]);

  // Also find high-scoring evals with no pipeline link — match by fuzzy file_path slug
  // deal_evaluations has no company_name; company comes from file_path slug
  const unlinked = await query(`
    SELECT
      pi.company_name,
      de.total_score,
      de.verdict,
      de.council_cfo_verdict,
      de.eval_date,
      de.file_path,
      pi.id AS invite_id,
      pi.status AS pipeline_status,
      pi.round,
      pi.lead AS lead_gp
    FROM deal_evaluations de
    JOIN pipeline_invites pi
      ON LOWER(REPLACE(pi.company_name, ' ', '-')) LIKE
         '%' || LOWER(REGEXP_REPLACE(
           REGEXP_REPLACE(de.file_path, '^.*/\\d{4}-\\d{2}-\\d{2}-', ''),
           '(-review)?\\.md$', ''
         )) || '%'
    WHERE pi.status = 'passed'
      AND de.total_score >= $1
      AND de.pipeline_invite_id IS NULL
    ORDER BY de.total_score DESC
  `, [threshold]);

  return {
    threshold,
    linked: rows,
    unlinked,
    total: rows.length + unlinked.length,
  };
}
