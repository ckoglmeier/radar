import { query } from '../db/index.js';
import { calculateIRR } from '../utils/irr.js';
import { gpSummary } from '../reports/gp.js';
import { performanceWindows, computeWindowMetrics, cashFlowsInRange } from '../reports/performance.js';
import { portfolioSummary } from '../reports/portfolio.js';
import { stageBreakdown, thesisPerformance } from '../reports/thesis.js';
import {
  METRIC_FORMULAS,
  QUERY_SEMANTICS,
  descriptiveCoverage,
  historicalCoverage,
  validateMetricQuery,
} from './contract.js';

const RETURN_METRICS = new Set(['tvpi', 'dpi', 'irr']);
const FLOW_TYPES = new Set(['investment', 'distribution', 'refund']);
const IRR_FLOW_TYPES = new Set([...FLOW_TYPES, 'adjustment']);

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  return String(value).slice(0, 10);
}

function numeric(value, fallback = 0) {
  return value == null ? fallback : Number(value);
}

function values(value) {
  return Array.isArray(value) ? value : [value];
}

function matches(value, filter) {
  if (filter == null) return true;
  const actual = String(value ?? '').toLowerCase();
  return values(filter).some(candidate => actual === candidate.toLowerCase());
}

function groupKey(groupBy, group) {
  return groupBy.map(dimension => `${dimension}:${group[dimension]}`).join('|');
}

function compareGroups(groupBy, left, right) {
  for (const dimension of groupBy) {
    const a = left.group[dimension];
    const b = right.group[dimension];
    if (dimension === 'vintage') {
      const diff = Number(a) - Number(b);
      if (diff !== 0) return diff;
    } else {
      const diff = String(a).localeCompare(String(b));
      if (diff !== 0) return diff;
    }
  }
  return 0;
}

async function loadMetricData(asOf) {
  const [positionRows, thesisRows, flowRows, valuationRows] = await Promise.all([
    query(`
      SELECT
        i.id,
        i.company_name,
        COALESCE(i.status_override, i.status) AS status,
        i.invest_date,
        i.invested,
        COALESCE(i.lead, 'Direct / Unknown') AS gp,
        COALESCE(i.stage_bucket, 'unknown') AS stage,
        COALESCE(i.market, 'Unknown') AS market,
        COALESCE(i.computed_net_invested, i.invested) AS net_invested,
        COALESCE(i.computed_realized, latest.realized_value, i.realized_value, 0) AS realized,
        CASE
          WHEN i.unrealized_value IS NULL AND i.net_value IS NULL AND latest.net_value IS NULL
            THEN i.invested
          ELSE COALESCE(
            i.computed_total_value,
            latest.net_value,
            i.net_value,
            COALESCE(i.unrealized_value, 0) + COALESCE(i.realized_value, 0)
          )
        END AS current_value,
        COALESCE(latest.unrealized_value, i.unrealized_value, i.invested) AS unrealized_value,
        CASE
          WHEN i.computed_total_value IS NOT NULL THEN 'computed'
          WHEN latest.net_value IS NOT NULL THEN 'snapshot'
          WHEN i.net_value IS NOT NULL OR i.unrealized_value IS NOT NULL
            OR i.realized_value IS NOT NULL OR i.multiple IS NOT NULL THEN 'reported'
          ELSE 'cost_basis'
        END AS mark_source
      FROM investments i
      LEFT JOIN LATERAL (
        SELECT v.net_value, v.unrealized_value, v.realized_value
        FROM valuations v
        WHERE v.investment_id = i.id AND v.snapshot_date <= $1
        ORDER BY v.snapshot_date DESC
        LIMIT 1
      ) latest ON true
      WHERE i.asset_class = 'direct'
      ORDER BY i.id
    `, [asOf]),
    query(`
      SELECT it.investment_id, t.name, COALESCE(it.weight, 100) AS weight
      FROM investment_theses it
      JOIN theses t ON t.id = it.thesis_id
      WHERE t.active = TRUE
      ORDER BY it.investment_id, t.name
    `),
    query(`
      SELECT cf.id, cf.investment_id, cf.flow_date, cf.type, cf.amount
      FROM cash_flows cf
      JOIN investments i ON i.id = cf.investment_id
      WHERE i.asset_class = 'direct'
        AND cf.type IN ('investment', 'distribution', 'refund', 'adjustment')
      ORDER BY cf.flow_date, cf.id
    `),
    query(`
      SELECT v.investment_id, v.snapshot_date, v.net_value
      FROM valuations v
      JOIN investments i ON i.id = v.investment_id
      WHERE i.asset_class = 'direct' AND v.snapshot_date <= $1
      ORDER BY v.investment_id, v.snapshot_date
    `, [asOf]),
  ]);

  const thesesByInvestment = new Map();
  for (const row of thesisRows) {
    const id = Number(row.investment_id);
    if (!thesesByInvestment.has(id)) thesesByInvestment.set(id, []);
    thesesByInvestment.get(id).push({ name: row.name, weight: numeric(row.weight, 100) / 100 });
  }

  const flowsByInvestment = new Map();
  for (const row of flowRows) {
    const id = Number(row.investment_id);
    const flow = {
      id: Number(row.id),
      investment_id: id,
      date: dateOnly(row.flow_date),
      type: row.type,
      amount: numeric(row.amount),
    };
    if (!flowsByInvestment.has(id)) flowsByInvestment.set(id, []);
    flowsByInvestment.get(id).push(flow);
  }

  const valuationsByInvestment = new Map();
  for (const row of valuationRows) {
    const id = Number(row.investment_id);
    const valuation = {
      date: dateOnly(row.snapshot_date),
      net_value: numeric(row.net_value),
    };
    if (!valuationsByInvestment.has(id)) valuationsByInvestment.set(id, []);
    valuationsByInvestment.get(id).push(valuation);
  }

  const positions = positionRows.map(row => {
    const id = Number(row.id);
    return {
      id,
      company_name: row.company_name,
      status: row.status,
      invest_date: dateOnly(row.invest_date),
      invested: numeric(row.invested),
      net_invested: numeric(row.net_invested),
      realized: numeric(row.realized),
      current_value: numeric(row.current_value),
      unrealized_value: numeric(row.unrealized_value),
      gp: row.gp,
      vintage: dateOnly(row.invest_date)?.slice(0, 4) ?? 'Unknown',
      stage: row.stage,
      market: row.market,
      mark_source: row.mark_source,
      marked: row.mark_source !== 'cost_basis',
      theses: thesesByInvestment.get(id) ?? [],
      cash_flows: flowsByInvestment.get(id) ?? [],
      valuations: valuationsByInvestment.get(id) ?? [],
    };
  });

  return { positions };
}

function filterPositions(positions, metricQuery) {
  const excluded = new Set(metricQuery.excludeIds);
  const { filters } = metricQuery;
  return positions.filter(position => {
    if (excluded.has(position.id)) return false;
    if (!matches(position.market, filters.market)) return false;
    if (!matches(position.gp, filters.gp)) return false;
    if (!matches(position.status, filters.status)) return false;
    if (filters.invested_since && (!position.invest_date || position.invest_date < filters.invested_since)) return false;
    if (filters.invested_until && (!position.invest_date || position.invest_date > filters.invested_until)) return false;
    if (filters.thesis) {
      const thesisNames = position.theses.map(thesis => thesis.name);
      if (!values(filters.thesis).some(thesis => thesisNames.includes(thesis))) return false;
    }
    return true;
  });
}

function memberships(position, groupBy) {
  if (!groupBy.includes('thesis')) {
    return [{
      group: Object.fromEntries(groupBy.map(dimension => [dimension, position[dimension]])),
      weight: 1,
    }];
  }

  const thesisMemberships = position.theses.length > 0
    ? position.theses
    : [{ name: 'Unassigned', weight: 1 }];
  return thesisMemberships.map(thesis => ({
    group: Object.fromEntries(groupBy.map(dimension => [
      dimension,
      dimension === 'thesis' ? thesis.name : position[dimension],
    ])),
    weight: thesis.weight,
  }));
}

function buildGroups(positions, groupBy) {
  const groups = new Map();
  if (positions.length === 0 && groupBy.length === 0) {
    groups.set('', { group: {}, members: [] });
  }
  for (const position of positions) {
    for (const membership of memberships(position, groupBy)) {
      const key = groupKey(groupBy, membership.group);
      if (!groups.has(key)) groups.set(key, { group: membership.group, members: [] });
      groups.get(key).members.push({ position, weight: membership.weight });
    }
  }
  return [...groups.values()];
}

function publicPosition(position, weight) {
  return {
    id: position.id,
    company_name: position.company_name,
    status: position.status,
    invest_date: position.invest_date,
    current_value: position.current_value * weight,
    net_invested: position.net_invested * weight,
    realized: position.realized * weight,
    marked: position.marked,
    mark_source: position.mark_source,
    weight,
  };
}

function publicFlow(flow, position, weight) {
  return {
    id: flow.id,
    investment_id: position.id,
    company_name: position.company_name,
    date: flow.date,
    type: flow.type,
    amount: flow.amount * weight,
  };
}

function flowsForGroup(members, metricQuery, allowedTypes) {
  const since = metricQuery.window.since;
  const until = metricQuery.window.until;
  return members.flatMap(({ position, weight }) => position.cash_flows
    .filter(flow => allowedTypes.has(flow.type))
    .filter(flow => !since || flow.date >= since)
    .filter(flow => !until || flow.date <= until)
    .map(flow => publicFlow(flow, position, weight)));
}

function latestValuation(position, date) {
  let latest = null;
  for (const valuation of position.valuations) {
    if (valuation.date <= date) latest = valuation;
    else break;
  }
  return latest;
}

function periodReturnRow(group, metricQuery) {
  const { since, until } = metricQuery.window;
  const eligible = group.members.filter(({ position }) => position.invest_date && position.invest_date <= until);
  const positions = eligible.map(({ position, weight }) => publicPosition(position, weight));
  const missing = [];
  let startValue = 0;
  let endValue = 0;

  for (const { position, weight } of eligible) {
    const opening = latestValuation(position, since);
    const closing = latestValuation(position, until);
    const existedAtStart = position.invest_date <= since;
    const hasInWindowMark = position.valuations.some(valuation => valuation.date > since && valuation.date <= until);
    if (existedAtStart && hasInWindowMark && !opening) missing.push(position);
    if (existedAtStart) startValue += numeric(opening?.net_value, position.invested) * weight;
    endValue += numeric(closing?.net_value, position.invested) * weight;
  }

  const cashFlows = flowsForGroup(eligible, metricQuery, FLOW_TYPES);
  const distributions = cashFlows
    .filter(flow => flow.amount > 0)
    .reduce((sum, flow) => sum + flow.amount, 0);
  const deployed = cashFlows
    .filter(flow => flow.amount < 0)
    .reduce((sum, flow) => sum + Math.abs(flow.amount), 0);
  const computed = computeWindowMetrics(startValue, endValue, distributions, deployed);
  const coverage = historicalCoverage(positions, missing);

  return {
    group: group.group,
    value: coverage.state === 'available' ? computed.value_change_pct : null,
    coverage,
    underlying: { positions, cash_flows: cashFlows },
    details: {
      start_value: startValue,
      end_value: endValue,
      distributions,
      deployed,
      gain: coverage.state === 'available' ? computed.gain : null,
    },
  };
}

function sinceInceptionRow(group, metricQuery, asOf) {
  const positions = group.members.map(({ position, weight }) => publicPosition(position, weight));
  const cashFlows = flowsForGroup(group.members, metricQuery, IRR_FLOW_TYPES);
  const invested = positions.reduce((sum, position) => sum + position.net_invested, 0);
  const currentValue = positions.reduce((sum, position) => sum + position.current_value, 0);
  const realized = positions.reduce((sum, position) => sum + position.realized, 0);
  let value = null;

  if (metricQuery.metric === 'tvpi') value = invested > 0 ? currentValue / invested : null;
  if (metricQuery.metric === 'dpi') value = invested > 0 ? realized / invested : null;
  if (metricQuery.metric === 'irr') {
    const irrFlows = cashFlows.map(flow => ({ date: flow.date, amount: flow.amount }));
    const terminal = group.members.reduce(
      (sum, member) => sum + member.position.unrealized_value * member.weight,
      0,
    );
    if (terminal > 0) irrFlows.push({ date: asOf, amount: terminal });
    value = irrFlows.length >= 2 ? calculateIRR(irrFlows) : null;
  }

  return {
    group: group.group,
    value,
    coverage: descriptiveCoverage(positions),
    underlying: { positions, cash_flows: cashFlows },
    details: {
      positions: positions.length,
      invested,
      current_value: currentValue,
      realized,
    },
  };
}

function flowRow(group, metricQuery) {
  const positions = group.members.map(({ position, weight }) => publicPosition(position, weight));
  const cashFlows = flowsForGroup(group.members, metricQuery, FLOW_TYPES);
  const wantDeployed = metricQuery.metric === 'deployed';
  const value = cashFlows.reduce((sum, flow) => {
    if (wantDeployed && flow.amount < 0) return sum + Math.abs(flow.amount);
    if (!wantDeployed && flow.amount > 0) return sum + flow.amount;
    return sum;
  }, 0);
  return {
    group: group.group,
    value,
    coverage: {
      state: 'available',
      positions: positions.length,
      linked_flows: cashFlows.length,
    },
    underlying: { positions, cash_flows: cashFlows },
  };
}

function adapterEligible(metricQuery) {
  return Object.keys(metricQuery.filters).length === 0
    && metricQuery.excludeIds.length === 0
    && Object.keys(metricQuery.window).length === 0;
}

async function existingReportValues(metricQuery) {
  if (!adapterEligible(metricQuery)) return null;
  const dimensions = metricQuery.groupBy;
  const metric = metricQuery.metric;

  if (dimensions.length === 0 && RETURN_METRICS.has(metric)) {
    const { summary } = await portfolioSummary();
    const invested = numeric(summary.total_invested);
    const value = metric === 'tvpi'
      ? numeric(summary.tvpi, null)
      : metric === 'dpi'
        ? (invested > 0 ? numeric(summary.total_realized) / invested : null)
        : (summary.irr == null ? null : Number(summary.irr));
    return new Map([['', {
      value,
      details: {
        positions: Number(summary.total_investments || 0),
        invested,
        current_value: metric === 'tvpi' && value != null ? value * invested : numeric(summary.total_net_value),
        realized: numeric(summary.total_realized),
      },
    }]]);
  }

  if (dimensions.length === 1 && dimensions[0] === 'vintage' && RETURN_METRICS.has(metric)) {
    const { byVintageYear } = await performanceWindows();
    return new Map(byVintageYear.map(row => [
      groupKey(dimensions, { vintage: String(row.vintage_year) }),
      {
        value: row[metric] == null ? null : Number(row[metric]),
        details: {
          positions: Number(row.deal_count || 0),
          invested: numeric(row.invested),
          current_value: numeric(row.current_value),
          realized: numeric(row.realized),
        },
      },
    ]));
  }

  if (dimensions.length === 1 && dimensions[0] === 'thesis' && (metric === 'tvpi' || metric === 'irr')) {
    const rows = await thesisPerformance();
    return new Map(rows.map(row => [
      groupKey(dimensions, { thesis: row.thesis }),
      {
        value: row[metric] == null ? null : Number(row[metric]),
        details: {
          positions: Number(row.deal_count || 0),
          invested: numeric(row.total_invested),
          current_value: numeric(row.total_net_value),
          realized: null,
        },
      },
    ]));
  }

  if (dimensions.length === 1 && dimensions[0] === 'gp' && metric === 'tvpi') {
    const { rows } = await gpSummary();
    return new Map(rows.map(row => [
      groupKey(dimensions, { gp: row.gp_name }),
      {
        value: row.tvpi == null ? null : Number(row.tvpi),
        details: {
          positions: Number(row.deal_count || 0),
          invested: numeric(row.total_invested),
          current_value: numeric(row.total_value),
          realized: null,
        },
      },
    ]));
  }

  if (dimensions.length === 1 && dimensions[0] === 'stage' && (metric === 'tvpi' || metric === 'dpi')) {
    const { byStage } = await stageBreakdown();
    return new Map(byStage.map(row => [
      groupKey(dimensions, { stage: row.stage_bucket }),
      {
        value: row[metric] == null ? null : Number(row[metric]),
        details: {
          positions: Number(row.deal_count || 0),
          invested: numeric(row.net_invested),
          current_value: numeric(row.total_value),
          realized: numeric(row.realized),
        },
      },
    ]));
  }

  return null;
}

async function applyExistingReportAdapter(metricQuery, rows) {
  const adapted = await existingReportValues(metricQuery);
  if (!adapted) return rows;
  return rows.map(row => {
    const key = groupKey(metricQuery.groupBy, row.group);
    if (!adapted.has(key)) return row;
    const existing = adapted.get(key);
    return { ...row, value: existing.value, details: existing.details };
  });
}

/**
 * Execute a validated, read-only metric query. The model layer never authors
 * SQL: all grouping, filters, coverage, and formulas are resolved here.
 */
export async function metricQuery(input) {
  const resolved = validateMetricQuery(input);
  if (RETURN_METRICS.has(resolved.metric) && Object.keys(resolved.window).length > 0) {
    throw new TypeError(`${resolved.metric} is since-inception; use filters.invested_since/invested_until for a cohort or period_return for a historical window`);
  }

  const asOf = new Date().toISOString().slice(0, 10);
  const { positions: allPositions } = await loadMetricData(asOf);
  const positions = filterPositions(allPositions, resolved);
  const groups = buildGroups(positions, resolved.groupBy);
  let rows;

  if (resolved.metric === 'period_return') {
    rows = groups.map(group => periodReturnRow(group, resolved));
  } else if (RETURN_METRICS.has(resolved.metric)) {
    rows = groups.map(group => sinceInceptionRow(group, resolved, asOf));
    rows = await applyExistingReportAdapter(resolved, rows);
  } else {
    rows = groups.map(group => flowRow(group, resolved));
    if (resolved.groupBy.length === 0 && Object.keys(resolved.filters).length === 0 && resolved.excludeIds.length === 0) {
      const since = resolved.window.since ?? '0001-01-01';
      const until = resolved.window.until ?? asOf;
      const existing = await cashFlowsInRange(since, until);
      rows[0].value = resolved.metric === 'deployed' ? existing.cash_out : existing.cash_in;
    }
  }

  rows.sort((left, right) => compareGroups(resolved.groupBy, left, right));
  return {
    kind: resolved.groupBy.length === 0 ? 'scalar' : 'grouped',
    asOf,
    metric: resolved.metric,
    formula: METRIC_FORMULAS[resolved.metric],
    filters: resolved.filters,
    window: resolved.window,
    semantics: QUERY_SEMANTICS,
    rows,
  };
}
