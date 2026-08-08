import { createHash } from 'node:crypto';
import { query } from '../db/index.js';
import { normalize } from '../utils/company-names.js';
import { calculateIRR } from '../utils/irr.js';

const FUND_NAME_HINT = /\b(fund|capital|access)\b/i;
const FIELD_PATTERNS = {
  name: /^(fund|fund name|name|company|entity)$/i,
  commitment: /commit/i,
  vintage_year: /vintage/i,
  manager: /manager|general partner|^gp$/i,
  strategy: /strategy/i,
  fund_status: /^status$|fund status/i,
  description: /description|notes?/i,
  commitment_date: /commit.*date|date.*commit/i,
};

function stableValue(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function parseMoney(value) {
  if (value == null || String(value).trim() === '') return { value: null };
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0
      ? { value }
      : { error: 'must be a non-negative USD amount' };
  }
  const raw = String(value).trim();
  if (/[€£¥]|\b(?:EUR|GBP|JPY|CAD|AUD)\b/i.test(raw)) {
    return { error: 'non-USD currency is not supported' };
  }
  const match = raw.match(/^\$?\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\s*([km])?$/i);
  if (!match) return { error: 'could not parse money value' };
  const amount = Number(match[1].replaceAll(',', ''));
  const multiplier = match[2]?.toLowerCase() === 'k' ? 1_000
    : match[2]?.toLowerCase() === 'm' ? 1_000_000
    : 1;
  return { value: amount * multiplier };
}

function parseVintage(value) {
  if (value == null || String(value).trim() === '') return { value: null };
  const year = Number(String(value).trim());
  const maxYear = new Date().getFullYear() + 2;
  return Number.isInteger(year) && year >= 1900 && year <= maxYear
    ? { value: year }
    : { error: `must be a year from 1900 through ${maxYear}` };
}

function parseDate(value) {
  if (value == null || String(value).trim() === '') return { value: null };
  const raw = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    return { error: 'must be an ISO date (YYYY-MM-DD)' };
  }
  return { value: raw };
}

function parseStatus(value) {
  if (value == null || String(value).trim() === '') return { value: null };
  const normalized = String(value).trim().toLowerCase().replaceAll(' ', '_');
  const aliases = { live: 'active', written_off: 'written_off', writtenoff: 'written_off' };
  const status = aliases[normalized] || normalized;
  return ['active', 'harvesting', 'realized', 'written_off'].includes(status)
    ? { value: status }
    : { error: 'must be active, harvesting, realized, or written_off' };
}

function roomFieldMap(room) {
  const mapped = {};
  for (const column of Array.isArray(room.cols) ? room.cols : []) {
    const key = String(column?.key || '').trim();
    const label = String(column?.label || key).trim();
    if (!key) continue;
    for (const [field, pattern] of Object.entries(FIELD_PATTERNS)) {
      if (!mapped[field] && (pattern.test(key) || pattern.test(label))) mapped[field] = key;
    }
  }
  return mapped;
}

function parseHolding(room, holding, linkedInvestment) {
  const cells = holding.cells && typeof holding.cells === 'object' ? holding.cells : {};
  const fields = roomFieldMap(room);
  for (const key of Object.keys(cells)) {
    for (const [field, pattern] of Object.entries(FIELD_PATTERNS)) {
      if (!fields[field] && pattern.test(key)) fields[field] = key;
    }
  }

  const raw = Object.fromEntries(
    Object.entries(fields).map(([field, key]) => [field, cells[key] ?? null]),
  );
  const errors = [];
  const parsed = {};
  for (const [field, parser] of [
    ['commitment', parseMoney],
    ['vintage_year', parseVintage],
    ['fund_status', parseStatus],
    ['commitment_date', parseDate],
  ]) {
    const result = parser(raw[field]);
    parsed[field] = result.value ?? null;
    if (result.error) errors.push({ field, raw_value: raw[field], error: result.error });
  }
  for (const field of ['manager', 'strategy', 'description']) {
    parsed[field] = raw[field] == null || String(raw[field]).trim() === ''
      ? null
      : String(raw[field]).trim();
  }
  const nameValue = raw.name == null ? null : String(raw.name).trim();
  return {
    name: nameValue || linkedInvestment?.company_name || null,
    parsed,
    parse_errors: errors,
    preserved_cells: stableValue(cells),
  };
}

function familyKey(name) {
  return normalize(name)
    .split(/\s+/)
    .filter(token => !['fund', 'capital', 'ventures', 'partners', 'access'].includes(token))
    .filter(token => !/^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x|\d{4})$/.test(token))
    .join(' ');
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()];
}

function resolveMerged(position, positionsById, consolidationBySource) {
  const path = [Number(position.id)];
  let current = position;
  while (current?.asset_class === 'merged') {
    const targetId = consolidationBySource.get(Number(current.id));
    if (!targetId) return { status: 'conflict', reason: 'missing_consolidation', path };
    if (path.includes(targetId)) return { status: 'conflict', reason: 'consolidation_cycle', path: [...path, targetId] };
    current = positionsById.get(targetId);
    path.push(targetId);
    if (!current) return { status: 'conflict', reason: 'missing_target', path };
  }
  return { status: 'resolved', target: current, path };
}

function analyticsSnapshot(positions, flows, excludedIds = new Set()) {
  const included = positions.filter(row =>
    row.asset_class === 'direct' && !excludedIds.has(Number(row.id))
  );
  const ids = new Set(included.map(row => Number(row.id)));
  const terminal = included.reduce((sum, row) => sum + Number(row.unrealized_value ?? row.invested ?? 0), 0);
  const irrFlows = flows
    .filter(row => ids.has(Number(row.investment_id)))
    .filter(row => ['investment', 'distribution', 'refund', 'adjustment'].includes(row.type))
    .map(row => ({ date: row.flow_date, amount: Number(row.amount) }));
  if (terminal > 0) {
    irrFlows.push({ date: new Date().toISOString().slice(0, 10), amount: terminal });
  }
  const year = new Date().getFullYear();
  return {
    position_count: included.length,
    total_invested: included.reduce((sum, row) => sum + Number(row.invested || 0), 0),
    total_unrealized: terminal,
    total_realized: included.reduce((sum, row) => sum + Number(row.realized_value || 0), 0),
    total_net_value: included.reduce((sum, row) => sum + Number(row.net_value || 0), 0),
    ytd_deployed: flows
      .filter(row => ids.has(Number(row.investment_id)))
      .filter(row => row.type === 'investment' && new Date(row.flow_date).getFullYear() === year)
      .reduce((sum, row) => sum + Math.abs(Number(row.amount || 0)), 0),
    irr: calculateIRR(irrFlows),
  };
}

export async function buildFundsAudit() {
  const [positions, entities, rooms, holdings, consolidations, valuations, flows, documents] = await Promise.all([
    query(`
      SELECT id, position_key, portfolio_entity_id, company_name, asset_class,
             status, invest_date, invested, unrealized_value, realized_value,
             net_value, investment_entity, fund_name, instrument, source
        FROM investments ORDER BY id
    `),
    query(`
      SELECT id, entity_key, legal_name, normalized_name, entity_type
        FROM portfolio_entities ORDER BY id
    `),
    query(`SELECT id, name, cols, created_at, updated_at FROM rooms ORDER BY id`),
    query(`SELECT id, room_id, investment_id, cells, created_at, updated_at FROM room_holdings ORDER BY id`),
    query(`SELECT source_investment_id, target_investment_id FROM investment_consolidations ORDER BY source_investment_id`),
    query(`SELECT * FROM valuations ORDER BY investment_id, snapshot_date, id`),
    query(`
      SELECT id, investment_id, flow_date, type, subtype, amount,
             description, company_raw, spv_raw, source, contra_account,
             reconciliation_status, reconciliation_note, reconciled_at
        FROM cash_flows ORDER BY id
    `),
    query(`
      SELECT id, entity_type, entity_id, filename, mime, sha256, source,
             size_bytes, created_at
        FROM documents ORDER BY id
    `),
  ]);

  const positionsById = new Map(positions.map(row => [Number(row.id), row]));
  const entitiesById = new Map(entities.map(row => [row.id, row]));
  const consolidationBySource = new Map(consolidations.map(row => [
    Number(row.source_investment_id), Number(row.target_investment_id),
  ]));
  const fundRooms = rooms.filter(room => /fund/i.test(room.name));
  const fundRoomIds = new Set(fundRooms.map(room => Number(room.id)));
  const fundHoldings = holdings.filter(row => fundRoomIds.has(Number(row.room_id)));
  const roomById = new Map(fundRooms.map(room => [Number(room.id), room]));
  const conflicts = [];
  const merged_resolutions = [];
  const candidates = [];

  for (const holding of fundHoldings) {
    let linked = holding.investment_id ? positionsById.get(Number(holding.investment_id)) : null;
    if (linked?.asset_class === 'merged') {
      const resolution = resolveMerged(linked, positionsById, consolidationBySource);
      if (resolution.status === 'conflict') {
        conflicts.push({ type: 'merged_room_link', room_holding_id: Number(holding.id), ...resolution });
        continue;
      }
      merged_resolutions.push({
        source_investment_id: Number(linked.id),
        target_investment_id: Number(resolution.target.id),
        room_holding_id: Number(holding.id),
        path: resolution.path,
      });
      linked = resolution.target;
    }

    const parsed = parseHolding(roomById.get(Number(holding.room_id)), holding, linked);
    let matches = [];
    if (!linked && parsed.name) {
      const normalized = normalize(parsed.name);
      matches = positions.filter(row =>
        row.asset_class !== 'merged' && normalize(row.company_name) === normalized
      );
      if (matches.length === 1) linked = matches[0];
      if (matches.length > 1) {
        conflicts.push({
          type: 'ambiguous_room_holding',
          room_holding_id: Number(holding.id),
          name: parsed.name,
          investment_ids: matches.map(row => Number(row.id)),
        });
      }
    }

    const proposedAction = linked?.asset_class === 'fund' ? 'migrate'
      : linked?.asset_class === 'direct' ? 'reclassify_direct'
      : linked ? 'unsupported_link'
      : matches.length > 1 ? 'resolve_ambiguity'
      : 'create_fund';
    if (proposedAction === 'unsupported_link') {
      conflicts.push({
        type: 'unsupported_room_link_asset_class',
        room_holding_id: Number(holding.id),
        investment_id: Number(linked.id),
        asset_class: linked.asset_class,
      });
    }
    const candidate = {
      room_id: Number(holding.room_id),
      room_name: roomById.get(Number(holding.room_id)).name,
      room_holding_id: Number(holding.id),
      source_hash: hash(stableValue(holding)),
      name: parsed.name,
      current_investment_id: linked ? Number(linked.id) : null,
      current_position_key: linked?.position_key || null,
      current_asset_class: linked?.asset_class || null,
      current_portfolio_entity_id: linked?.portfolio_entity_id || null,
      parsed: parsed.parsed,
      parse_errors: parsed.parse_errors,
      preserved_cells: parsed.preserved_cells,
      proposed_action: proposedAction,
      decision: null,
    };
    candidates.push(candidate);
  }

  const fundInvestments = positions.filter(row => row.asset_class === 'fund').map(position => ({
    ...stableValue(position),
    portfolio_entity: position.portfolio_entity_id
      ? stableValue(entitiesById.get(position.portfolio_entity_id) || null)
      : null,
    entity_proposal: position.portfolio_entity_id ? null : {
      entity_type: 'fund_vehicle',
      legal_name: position.company_name,
      normalized_name: normalize(position.company_name),
      ownership_entity: position.investment_entity,
      must_remain_distinct: true,
    },
    valuations: stableValue(valuations.filter(row => Number(row.investment_id) === Number(position.id))),
    cash_flows: stableValue(flows.filter(row => Number(row.investment_id) === Number(position.id))),
    documents: stableValue(documents.filter(row =>
      row.entity_type === 'investment' && Number(row.entity_id) === Number(position.id)
    )),
  }));

  const fundShapedDirect = positions.filter(row =>
    row.asset_class === 'direct' && FUND_NAME_HINT.test(row.company_name)
  ).map(position => ({
    ...stableValue(position),
    review_only: true,
    if_reclassified: analyticsSnapshot(positions, flows, new Set([Number(position.id)])),
  }));
  const baseline = analyticsSnapshot(positions, flows);
  for (const candidate of candidates) {
    if (candidate.proposed_action === 'reclassify_direct') {
      candidate.direct_analytics_if_reclassified = analyticsSnapshot(
        positions,
        flows,
        new Set([candidate.current_investment_id]),
      );
    }
    candidate.candidate_hash = hash({ ...candidate, decision: undefined });
  }

  for (const position of positions.filter(row => row.asset_class === 'fund' && row.portfolio_entity_id)) {
    const entity = entitiesById.get(position.portfolio_entity_id);
    if (!entity || entity.entity_type !== 'fund_vehicle') {
      conflicts.push({
        type: 'invalid_fund_entity_link',
        investment_id: Number(position.id),
        portfolio_entity_id: position.portfolio_entity_id,
        entity_type: entity?.entity_type || null,
      });
    }
  }
  for (const linkedGroup of groupBy(
    positions.filter(row => row.asset_class === 'fund' && row.portfolio_entity_id),
    row => row.portfolio_entity_id,
  )) {
    const normalizedNames = [...new Set(linkedGroup.map(row => normalize(row.company_name)))];
    if (normalizedNames.length > 1) {
      conflicts.push({
        type: 'distinct_fund_names_share_entity',
        portfolio_entity_id: linkedGroup[0].portfolio_entity_id,
        investments: linkedGroup.map(row => ({
          id: Number(row.id),
          position_key: row.position_key,
          company_name: row.company_name,
        })),
      });
    }
  }

  const nameRecords = [
    ...fundInvestments.map(row => ({ source: 'investment', id: Number(row.id), name: row.company_name })),
    ...candidates.filter(row => row.name).map(row => ({ source: 'room_holding', id: row.room_holding_id, name: row.name })),
  ];
  const normalizedGroups = groupBy(nameRecords, row => normalize(row.name))
    .filter(group => group.length > 1)
    .map(group => ({ normalized_name: normalize(group[0].name), records: group }));
  const familyGroups = groupBy(nameRecords, row => familyKey(row.name))
    .filter(group => group.length > 1 && familyKey(group[0].name))
    .map(group => ({ family_hint: familyKey(group[0].name), records: group, never_auto_merge: true }));

  const linkedCounts = groupBy(
    fundHoldings.filter(row => row.investment_id).map(row => Number(row.investment_id)),
    id => id,
  );
  const duplicateHoldingLinks = linkedCounts
    .filter(ids => ids.length > 1)
    .map(ids => ({ investment_id: Number(ids[0]), holding_count: ids.length }));

  function candidateFundInvestments(flow) {
    const names = [flow.company_raw, flow.spv_raw].filter(Boolean).map(normalize);
    return fundInvestments
      .filter(position => names.includes(normalize(position.company_name)))
      .map(position => ({
        id: Number(position.id),
        position_key: position.position_key,
        company_name: position.company_name,
        asset_class: position.asset_class,
        matched_on: normalize(flow.spv_raw) === normalize(position.company_name) ? 'spv_raw' : 'company_raw',
      }));
  }

  const routedFundFlows = flows
    .filter(row => row.reconciliation_status === 'fund')
    .map(flow => ({
      ...stableValue(flow),
      source_account: flow.contra_account || null,
      candidate_investments: candidateFundInvestments(flow),
    }));
  const fundLinkedFlowCandidates = flows
    .filter(flow => !flow.investment_id && candidateFundInvestments(flow).length > 0)
    .map(flow => ({
      ...stableValue(flow),
      source_account: flow.contra_account || null,
      candidate_investments: candidateFundInvestments(flow),
      needs_disposition_review: flow.reconciliation_status !== 'fund',
    }));

  const allNames = [...nameRecords, ...fundShapedDirect.map(row => ({ source: 'direct_hint', id: Number(row.id), name: row.company_name }))];
  const expectations = [
    ['Incisive Ventures', /incisive ventures/i],
    ['Future of Food', /future of food/i],
    ['Range II', /range(?: fund)? ii/i],
    ['S+H Capital', /s\s*\+?\s*h capital/i],
  ].map(([name, pattern]) => ({
    name,
    matches: allNames.filter(row => pattern.test(row.name)),
    status: allNames.some(row => pattern.test(row.name)) ? 'found' : 'not_found',
  }));

  const source = stableValue({ positions, entities, fundRooms, fundHoldings, consolidations, valuations, flows, documents });
  const report = {
    audit_version: 1,
    source_hash: hash(source),
    counts: {
      fund_investments: fundInvestments.length,
      fund_rooms: fundRooms.length,
      fund_room_holdings: fundHoldings.length,
      unlinked_room_holdings: candidates.filter(row => !row.current_investment_id).length,
      fund_shaped_direct: fundShapedDirect.length,
      routed_fund_flows: routedFundFlows.length,
      fund_linked_flow_candidates: fundLinkedFlowCandidates.length,
      fund_linked_flows_needing_review: fundLinkedFlowCandidates.filter(row => row.needs_disposition_review).length,
      unmatched_routed_fund_flows: routedFundFlows.filter(row => row.candidate_investments.length === 0).length,
      parse_errors: candidates.reduce((sum, row) => sum + row.parse_errors.length, 0),
      conflicts: conflicts.length,
    },
    direct_analytics_baseline: baseline,
    fund_investments: fundInvestments,
    fund_rooms: stableValue(fundRooms),
    holding_candidates: candidates,
    duplicate_holding_links: duplicateHoldingLinks,
    normalized_name_duplicates: normalizedGroups,
    similar_fund_families: familyGroups,
    fund_shaped_direct_candidates: fundShapedDirect,
    routed_fund_flows: routedFundFlows,
    fund_linked_flow_candidates: fundLinkedFlowCandidates,
    merged_resolutions,
    expectations,
    conflicts,
  };
  report.audit_hash = hash({ ...report, audit_hash: undefined });
  return report;
}

export function formatFundsAuditSummary(report) {
  const lines = [
    'Funds migration audit',
    `Fund investments: ${report.counts.fund_investments}`,
    `Funds rooms / holdings: ${report.counts.fund_rooms} / ${report.counts.fund_room_holdings}`,
    `Unlinked holdings: ${report.counts.unlinked_room_holdings}`,
    `Fund-shaped Direct review candidates: ${report.counts.fund_shaped_direct}`,
    `Fund-routed cash flows: ${report.counts.routed_fund_flows}`,
    `Fund-linked flows needing disposition review: ${report.counts.fund_linked_flows_needing_review}`,
    `Fund-routed flows with no position match: ${report.counts.unmatched_routed_fund_flows}`,
    `Parse errors / blocking conflicts: ${report.counts.parse_errors} / ${report.counts.conflicts}`,
    '',
    'Known-case check:',
    ...report.expectations.map(item => `- ${item.name}: ${item.status} (${item.matches.length})`),
  ];
  if (report.similar_fund_families.length > 0) {
    lines.push('', 'Similar fund-family names (review only; never auto-merged):');
    for (const group of report.similar_fund_families) {
      lines.push(`- ${group.records.map(row => row.name).join(' | ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
