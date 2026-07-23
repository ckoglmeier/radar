// Pure data fetchers for deal evaluations. Thin wrappers over the model layer.

import { listEvaluations, getEvaluationByCompany } from '../models/evaluations.js';
import { query } from '../db/index.js';
import { calculateIRR } from '../utils/irr.js';
import { runAnalytics } from '../utils/analytics.js';
import { getActiveThesisNames } from '../lenses/loader.js';
import { normalize as normalizeCompanyName } from '../utils/company-names.js';

export async function evalList() {
  return listEvaluations();
}

export async function evalDetail(search) {
  return getEvaluationByCompany(search);
}

function suggestionBasis(evaluation, candidate) {
  const evalName = normalizeCompanyName(evaluation.company_name);
  const candidateName = normalizeCompanyName(candidate.company_name);
  if (!candidateName) return null;
  if (evalName && evalName === candidateName) return 'normalized-name';
  if (evalName && (evalName.includes(candidateName) || candidateName.includes(evalName))) {
    return 'similar-name';
  }
  const path = normalizeCompanyName(evaluation.file_path);
  if (path && path.includes(candidateName)) return 'file-path';
  return null;
}

function suggestedMatch(evaluation, candidates) {
  const matches = candidates
    .map(candidate => ({ candidate, basis: suggestionBasis(evaluation, candidate) }))
    .filter(match => match.basis);
  if (matches.length === 0) return { match: null, count: 0 };

  const priority = ['normalized-name', 'similar-name', 'file-path'];
  for (const basis of priority) {
    const ranked = matches.filter(match => match.basis === basis);
    if (ranked.length === 1) {
      const { candidate } = ranked[0];
      return {
        match: {
          type: candidate.type,
          id: candidate.id,
          company_name: candidate.company_name,
          deal_slug: candidate.deal_slug || null,
          basis,
          confirmed: false,
        },
        count: matches.length,
      };
    }
    if (ranked.length > 1) return { match: null, count: matches.length };
  }
  return { match: null, count: matches.length };
}

/**
 * Chronological evidence ledger for the Pipeline workspace.
 *
 * Authoritative destinations come only from persisted foreign keys. The
 * optional suggested_match is deliberately separate and never changes
 * link_type or linked_id.
 */
export async function evaluationLedger() {
  const [evaluations, invites, investments] = await Promise.all([
    query(`
      SELECT
        de.id,
        de.investment_id,
        de.pipeline_invite_id,
        de.eval_date,
        de.file_path,
        de.company_name,
        de.thesis_fit_score,
        de.viability_score,
        de.total_score,
        de.verdict,
        de.invested,
        de.council_bull_score,
        de.council_bear_score,
        de.council_calibrator_score,
        de.council_spread,
        de.council_consensus,
        de.council_divergence,
        de.council_cfo_verdict,
        de.eval_mode,
        de.council_policy,
        de.council_policy_version,
        de.council_instruction_hash,
        de.council_lens_hash,
        de.council_calibration_hash,
        de.council_input_hash,
        de.council_artifact_hash,
        de.council_session_id,
        de.council_model_policy,
        de.council_score_adjusted,
        de.council_run_key,
        de.created_at,
        LEFT(de.raw_content, 900) AS source_excerpt,
        pi.company_name AS pipeline_company_name,
        pi.deal_slug AS pipeline_deal_slug,
        i.company_name AS investment_company_name
      FROM deal_evaluations de
      LEFT JOIN pipeline_invites pi ON pi.id = de.pipeline_invite_id
      LEFT JOIN investments i ON i.id = de.investment_id
      ORDER BY de.eval_date DESC NULLS LAST, de.created_at ASC, de.id ASC
    `),
    query(`SELECT id, company_name, deal_slug FROM pipeline_invites`),
    query(`SELECT id, company_name FROM investments`),
  ]);

  const candidates = [
    ...invites.map(row => ({ ...row, type: 'pipeline_invite' })),
    ...investments.map(row => ({ ...row, type: 'investment' })),
  ];

  return evaluations.map(row => {
    let linkType = 'unlinked';
    let linkedId = null;
    let linkedCompanyName = null;
    let linkedDealSlug = null;
    if (row.pipeline_invite_id != null) {
      linkType = 'pipeline_invite';
      linkedId = row.pipeline_invite_id;
      linkedCompanyName = row.pipeline_company_name;
      linkedDealSlug = row.pipeline_deal_slug;
    } else if (row.investment_id != null) {
      linkType = 'investment';
      linkedId = row.investment_id;
      linkedCompanyName = row.investment_company_name;
    }

    const suggestion = linkType === 'unlinked'
      ? suggestedMatch(row, candidates)
      : { match: null, count: 0 };

    return {
      ...row,
      display_company_name:
        row.company_name || row.pipeline_company_name || row.investment_company_name || null,
      link_type: linkType,
      linked_id: linkedId,
      linked_company_name: linkedCompanyName,
      linked_deal_slug: linkedDealSlug,
      suggested_match: suggestion.match,
      suggested_match_count: suggestion.count,
    };
  });
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
