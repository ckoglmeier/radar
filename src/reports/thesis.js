// Pure data fetchers for thesis reports.
import { query } from '../db/index.js';
import { calculateIRR } from '../utils/irr.js';
import { STAGE_ORDER, BARBELL_GROUPS, stageLabel, stageToBarbellGroup } from '../utils/stage.js';
import { positionReturnMetrics } from './portfolio.js';

function normalizedThesisName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function thesisPerformance(opts = {}) {
  const { since, until } = opts;
  const conditions = ['TRUE'];
  const params = [];
  if (since) { params.push(since); conditions.push(`i.invest_date >= $${params.length}`); }
  if (until) { params.push(until); conditions.push(`i.invest_date <= $${params.length}`); }
  const whereClause = 'WHERE ' + conditions.join(' AND ');

  const rows = await query(`
    SELECT
      t.id AS thesis_id,
      t.lens_thesis_id,
      t.name AS thesis,
      t.active,
      t.inactive_at,
      COUNT(DISTINCT i.id) AS deal_count,
      SUM(i.invested * it.weight / 100.0) AS total_invested,
      SUM(i.net_value * it.weight / 100.0) AS total_net_value,
      SUM(COALESCE(i.net_value, i.invested) * it.weight / 100.0) /
        NULLIF(SUM(i.invested * it.weight / 100.0), 0) AS tvpi,
      AVG(i.multiple) FILTER (WHERE i.multiple IS NOT NULL) AS avg_multiple,
      MAX(i.multiple) AS best_multiple,
      MIN(i.invest_date) AS first_deal,
      MAX(i.invest_date) AS last_deal,
      COUNT(*) FILTER (WHERE i.status = 'Live') AS live,
      COUNT(*) FILTER (WHERE i.status = 'Realized') AS realized
    FROM theses t
    LEFT JOIN investment_theses it ON it.thesis_id = t.id
    LEFT JOIN investments i ON i.id = it.investment_id AND i.asset_class = 'direct'
    ${whereClause}
    GROUP BY t.id, t.lens_thesis_id, t.name, t.active, t.inactive_at
    ORDER BY total_invested DESC NULLS LAST
  `, params);

  // Compute IRR per thesis cluster using cash_flows
  const irrDateFilter = [];
  if (since) irrDateFilter.push(`i.invest_date >= $${irrDateFilter.length + 1}`);
  if (until) irrDateFilter.push(`i.invest_date <= $${irrDateFilter.length + 1}`);
  const irrParams = [];
  if (since) irrParams.push(since);
  if (until) irrParams.push(until);
  const irrWhere = irrDateFilter.length > 0 ? 'AND ' + irrDateFilter.join(' AND ') : '';

  const cfRows = await query(`
    SELECT it.thesis_id, cf.flow_date AS date, cf.amount
    FROM cash_flows cf
    JOIN investments i ON i.id = cf.investment_id
    JOIN investment_theses it ON it.investment_id = cf.investment_id
    JOIN theses t ON t.id = it.thesis_id
    WHERE i.asset_class = 'direct' ${irrWhere}
    ORDER BY cf.flow_date
  `, irrParams);
  const cfByThesis = {};
  for (const cf of cfRows) {
    if (!cfByThesis[cf.thesis_id]) cfByThesis[cf.thesis_id] = [];
    cfByThesis[cf.thesis_id].push({ date: cf.date, amount: Number(cf.amount) });
  }

  // Get unrealized by thesis for terminal value
  const unrRows = await query(`
    -- Terminal value for IRR: fall back to invested (at cost) for locked positions.
    -- Crowdfunding write-offs are encoded in the data layer (unrealized_value = 0).
    SELECT it.thesis_id, SUM(COALESCE(i.unrealized_value, i.invested)) AS unrealized
    FROM investment_theses it
    JOIN investments i ON i.id = it.investment_id
    JOIN theses t ON t.id = it.thesis_id
    WHERE i.asset_class = 'direct' ${irrWhere}
    GROUP BY it.thesis_id
  `, irrParams);
  const unrByThesis = {};
  for (const r of unrRows) unrByThesis[r.thesis_id] = Number(r.unrealized || 0);

  const today = new Date().toISOString().slice(0, 10);
  const thesisIdRows = await query(`SELECT id, name FROM theses`);
  const idByName = {};
  for (const t of thesisIdRows) idByName[t.name] = t.id;

  for (const r of rows) {
    const tid = idByName[r.thesis];
    const flows = [...(cfByThesis[tid] || [])];
    const unrealized = unrByThesis[tid] || 0;
    if (unrealized > 0) flows.push({ date: today, amount: unrealized });
    r.irr = flows.length >= 2 ? calculateIRR(flows) : null;
  }

  return rows;
}

async function resolveThesisReference(reference) {
  const id = Number(typeof reference === 'object' ? reference?.id : reference);
  if (Number.isInteger(id) && id > 0) {
    const [thesis] = await query('SELECT * FROM theses WHERE id = $1', [id]);
    return thesis ? { state: 'resolved', thesis } : { state: 'missing', matches: [] };
  }

  const slug = typeof reference === 'object' ? String(reference?.slug || '').trim() : '';
  if (slug) {
    const [thesis] = await query('SELECT * FROM theses WHERE lens_thesis_id = $1', [slug]);
    return thesis ? { state: 'resolved', thesis } : { state: 'missing', matches: [] };
  }

  const name = typeof reference === 'object' ? reference?.name : reference;
  const expected = normalizedThesisName(name);
  if (!expected) return { state: 'missing', matches: [] };
  const theses = await query('SELECT * FROM theses ORDER BY id');
  const matches = theses.filter(thesis => normalizedThesisName(thesis.name) === expected);
  if (matches.length === 1) return { state: 'resolved', thesis: matches[0] };
  return { state: matches.length > 1 ? 'ambiguous' : 'missing', matches };
}

/**
 * Canonical thesis read model shared by product surfaces and analytical agents.
 * Membership is always read from investment_theses by stable thesis ID.
 */
export async function thesisDetail(reference, options = {}) {
  const resolution = await resolveThesisReference(reference);
  if (resolution.state === 'missing') return null;
  if (resolution.state === 'ambiguous') {
    return {
      schema_version: 1,
      kind: 'ambiguous_thesis',
      matches: resolution.matches.map(thesis => ({
        id: Number(thesis.id), slug: thesis.lens_thesis_id || null, name: thesis.name,
        active: Boolean(thesis.active),
      })),
    };
  }

  const thesis = resolution.thesis;
  const [report, performanceRows, assignments] = await Promise.all([
    positionReturnMetrics({
      asOf: options.asOf,
      filters: { assetType: 'direct', thesisId: Number(thesis.id) },
      limit: options.limit,
    }),
    thesisPerformance({ since: options.since, until: options.until }),
    query(`
      SELECT investment_id, is_primary, weight, confidence, tagged_by
        FROM investment_theses
       WHERE thesis_id = $1
       ORDER BY investment_id
    `, [thesis.id]),
  ]);
  const performance = performanceRows.find(row => Number(row.thesis_id) === Number(thesis.id)) || null;
  const assignmentByInvestment = new Map(assignments.map(row => [Number(row.investment_id), row]));
  const positions = report.positions.map(position => {
    const assignment = assignmentByInvestment.get(Number(position.position_id));
    const weight = numberOrNull(assignment?.weight) ?? 100;
    return {
      ...position,
      attribution: {
        weight_percent: weight,
        is_primary: Boolean(assignment?.is_primary),
        confidence: assignment?.confidence || null,
        tagged_by: assignment?.tagged_by || null,
      },
      attributed_invested_capital: position.invested_capital == null
        ? null : Number(position.invested_capital) * weight / 100,
      attributed_net_value: position.current_net_value == null
        ? null : Number(position.current_net_value) * weight / 100,
    };
  });

  return {
    schema_version: 1,
    kind: 'thesis_detail',
    as_of: report.as_of,
    sort: report.sort,
    thesis: {
      id: Number(thesis.id),
      slug: thesis.lens_thesis_id || null,
      name: thesis.name,
      active: Boolean(thesis.active),
      inactive_at: thesis.inactive_at ? String(thesis.inactive_at).slice(0, 10) : null,
      inactive_reason: thesis.inactive_reason || null,
      belief: thesis.belief || null,
      proves_true: thesis.proves_true || null,
      proves_false: thesis.proves_false || null,
      open_question: thesis.open_question || null,
      conviction_now: numberOrNull(thesis.conviction_now),
      conviction_entry: numberOrNull(thesis.conviction_entry),
      qualifications: thesis.qualifications || [],
      exclusions: thesis.exclusions || [],
      conviction_signal: thesis.conviction_signal || null,
    },
    summary: performance ? {
      position_count: Number(performance.deal_count || 0),
      invested_basis: numberOrNull(performance.total_invested),
      net_value: numberOrNull(performance.total_net_value),
      tvpi: numberOrNull(performance.tvpi),
      irr: numberOrNull(performance.irr),
      live_count: Number(performance.live || 0),
      realized_count: Number(performance.realized || 0),
    } : {
      position_count: 0, invested_basis: null, net_value: null, tvpi: null,
      irr: null, live_count: 0, realized_count: 0,
    },
    positions,
  };
}

export async function thesisList() {
  const rows = await query(`
    SELECT t.*, COUNT(i.id) AS investment_count
    FROM theses t
    LEFT JOIN investment_theses it ON it.thesis_id = t.id
    LEFT JOIN investments i ON i.id = it.investment_id AND i.asset_class = 'direct'
    GROUP BY t.id
    ORDER BY investment_count DESC
  `);
  return rows;
}

export async function untaggedInvestments() {
  const rows = await query(`
    SELECT i.id, i.company_name, i.invest_date, i.invested, i.market, i.round, i.status
    FROM investments i
    LEFT JOIN investment_theses it ON it.investment_id = i.id
    WHERE it.investment_id IS NULL AND i.asset_class = 'direct'
    ORDER BY i.invest_date DESC, i.company_name
  `);
  return rows;
}

export async function stageBreakdown() {
  const rows = await query(`
    SELECT
      COALESCE(stage_bucket, 'unknown') AS stage_bucket,
      COUNT(*) AS deal_count,
      SUM(COALESCE(computed_net_invested, invested)) AS net_invested,
      AVG(COALESCE(computed_net_invested, invested)) AS avg_check,
      SUM(COALESCE(computed_realized, realized_value, 0)) AS realized,
      SUM(COALESCE(computed_total_value, COALESCE(unrealized_value,0) + COALESCE(realized_value,0))) AS total_value,
      ROUND(
        SUM(COALESCE(computed_realized, realized_value, 0)) /
        NULLIF(SUM(COALESCE(computed_net_invested, invested)), 0), 3
      ) AS dpi,
      ROUND(
        SUM(COALESCE(computed_total_value, COALESCE(unrealized_value,0) + COALESCE(realized_value,0))) /
        NULLIF(SUM(COALESCE(computed_net_invested, invested)), 0), 3
      ) AS tvpi
    FROM investments
    WHERE asset_class = 'direct'
    GROUP BY COALESCE(stage_bucket, 'unknown')
    ORDER BY ARRAY_POSITION(
      ARRAY['pre-seed','seed','seed-ext','series-a','series-b','series-c','growth','fund','unknown'],
      COALESCE(stage_bucket, 'unknown')
    )
  `);

  // Barbell roll-up: aggregate Early / Mid / Late
  const barbellMap = {};
  for (const row of rows) {
    const group = stageToBarbellGroup(row.stage_bucket);
    if (!barbellMap[group]) {
      barbellMap[group] = { group, deal_count: 0, net_invested: 0, realized: 0, total_value: 0 };
    }
    const b = barbellMap[group];
    b.deal_count   += Number(row.deal_count);
    b.net_invested += Number(row.net_invested || 0);
    b.realized     += Number(row.realized || 0);
    b.total_value  += Number(row.total_value || 0);
  }
  const barbell = ['Early', 'Mid', 'Late', 'Growth', 'Unknown']
    .filter(g => barbellMap[g])
    .map(g => {
      const b = barbellMap[g];
      return {
        ...b,
        dpi:  b.net_invested > 0 ? Math.round(b.realized / b.net_invested * 1000) / 1000 : null,
        tvpi: b.net_invested > 0 ? Math.round(b.total_value / b.net_invested * 1000) / 1000 : null,
      };
    });

  return { byStage: rows, barbell };
}

export async function eraAnalysis() {
  const rows = await query(`
    SELECT
      CASE
        WHEN invest_date < '2023-01-01' THEN 'Exploration (2021-2022)'
        ELSE 'Conviction (2023+)'
      END AS era,
      COUNT(*) AS deal_count,
      SUM(invested) AS total_invested,
      AVG(invested) AS avg_check,
      SUM(net_value) AS total_net_value,
      SUM(COALESCE(net_value, invested)) /
        NULLIF(SUM(invested), 0) AS tvpi,
      AVG(multiple) FILTER (WHERE multiple IS NOT NULL) AS avg_multiple
    FROM investments
    WHERE asset_class = 'direct'
    GROUP BY CASE WHEN invest_date < '2023-01-01' THEN 'Exploration (2021-2022)' ELSE 'Conviction (2023+)' END
    ORDER BY era
  `);
  return rows;
}
