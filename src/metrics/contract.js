// Deterministic metric-query contract shared by Radar's reports, app, and
// future read-only metric tools. This module contains no database access.

export const METRIC_NAMES = Object.freeze([
  'tvpi',
  'dpi',
  'irr',
  'period_return',
  'deployed',
  'distributions',
]);

export const GROUP_DIMENSIONS = Object.freeze([
  'gp',
  'vintage',
  'thesis',
  'stage',
  'market',
]);

export const METRIC_FORMULAS = Object.freeze({
  tvpi: 'Current total value / net invested capital',
  dpi: 'Realized distributions / net invested capital',
  irr: 'Annualized XIRR of investment cash flows plus current unrealized value',
  period_return: 'Modified Dietz: (ending value - opening value - net contributions) / (opening value + 0.5 x net contributions)',
  deployed: 'Absolute value of linked investment cash outflows in the selected flow window',
  distributions: 'Linked distributions and refunds received in the selected flow window',
});

export const QUERY_SEMANTICS = Object.freeze({
  window: 'Selects cash flows occurring in the window. It does not select an investment cohort.',
  cohort: 'filters.invested_since and filters.invested_until select investments by initial investment date.',
  status: 'filters.status is evaluated against current status; historical status reconstruction is unavailable.',
  top_holding: 'Largest current best_total_value at the result as-of date.',
  historical_return_guard: 'A historical return is unavailable when any position with an in-window mark lacks an opening valuation on or before the window start.',
});

const FILTER_KEYS = new Set([
  'thesis',
  'market',
  'gp',
  'status',
  'invested_since',
  'invested_until',
]);

const QUERY_KEYS = new Set(['metric', 'groupBy', 'filters', 'window', 'excludeIds']);
const WINDOW_KEYS = new Set(['since', 'until']);

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`unknown ${label} field: ${key}`);
  }
}

function normalizeDate(value, label) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${label} must use YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${label} is not a valid calendar date`);
  }
  return value;
}

function normalizeFilterValue(value, label) {
  if (value == null || value === '') return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new TypeError(`${label} must be a non-empty string or string array`);
  }
  const normalized = [...new Set(values.map(item => item.trim()))];
  return Array.isArray(value) ? normalized : normalized[0];
}

function assertDateOrder(since, until, label) {
  if (since && until && since > until) {
    throw new TypeError(`${label}.since must be on or before ${label}.until`);
  }
}

export function validateMetricQuery(input) {
  assertPlainObject(input, 'metric query');
  assertKnownKeys(input, QUERY_KEYS, 'metric query');

  if (!METRIC_NAMES.includes(input.metric)) {
    throw new TypeError(`metric must be one of: ${METRIC_NAMES.join(', ')}`);
  }

  const groupBy = input.groupBy ?? [];
  if (!Array.isArray(groupBy)) throw new TypeError('groupBy must be an array');
  if (groupBy.some(dimension => !GROUP_DIMENSIONS.includes(dimension))) {
    throw new TypeError(`groupBy values must be one of: ${GROUP_DIMENSIONS.join(', ')}`);
  }
  if (new Set(groupBy).size !== groupBy.length) {
    throw new TypeError('groupBy values must be unique');
  }

  const filters = input.filters ?? {};
  assertPlainObject(filters, 'filters');
  assertKnownKeys(filters, FILTER_KEYS, 'filter');
  const normalizedFilters = {};
  for (const key of ['thesis', 'market', 'gp', 'status']) {
    const value = normalizeFilterValue(filters[key], `filters.${key}`);
    if (value !== undefined) normalizedFilters[key] = value;
  }
  const investedSince = normalizeDate(filters.invested_since, 'filters.invested_since');
  const investedUntil = normalizeDate(filters.invested_until, 'filters.invested_until');
  if (investedSince) normalizedFilters.invested_since = investedSince;
  if (investedUntil) normalizedFilters.invested_until = investedUntil;
  assertDateOrder(investedSince, investedUntil, 'filters.invested');

  const window = input.window ?? {};
  assertPlainObject(window, 'window');
  assertKnownKeys(window, WINDOW_KEYS, 'window');
  const since = normalizeDate(window.since, 'window.since');
  const until = normalizeDate(window.until, 'window.until');
  assertDateOrder(since, until, 'window');
  if (input.metric === 'period_return' && (!since || !until)) {
    throw new TypeError('period_return requires window.since and window.until');
  }

  const excludeIds = input.excludeIds ?? [];
  if (!Array.isArray(excludeIds) || excludeIds.some(id => !Number.isInteger(Number(id)) || Number(id) <= 0)) {
    throw new TypeError('excludeIds must be an array of positive investment IDs');
  }

  return {
    metric: input.metric,
    groupBy: [...groupBy],
    filters: normalizedFilters,
    window: { ...(since ? { since } : {}), ...(until ? { until } : {}) },
    excludeIds: [...new Set(excludeIds.map(Number))],
  };
}

export function historicalCoverage(positions, missingPositions) {
  const missing = missingPositions.map(position => ({
    id: Number(position.id),
    company_name: position.company_name,
  }));
  return {
    state: missing.length > 0 ? 'unavailable' : 'available',
    positions: positions.length,
    missing_opening_positions: missing,
  };
}

export function descriptiveCoverage(positions) {
  const marked = positions.filter(position => position.marked);
  const totalValue = positions.reduce((sum, position) => sum + Number(position.current_value || 0), 0);
  const markedValue = marked.reduce((sum, position) => sum + Number(position.current_value || 0), 0);
  return {
    state: 'descriptive',
    positions: positions.length,
    marked: marked.length,
    value_share_marked: totalValue > 0 ? markedValue / totalValue : null,
    unmarked_positions: positions
      .filter(position => !position.marked)
      .map(position => ({ id: Number(position.id), company_name: position.company_name })),
  };
}
