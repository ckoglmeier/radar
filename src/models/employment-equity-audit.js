import { createHash } from 'node:crypto';
import { query } from '../db/index.js';
import { normalize } from '../utils/company-names.js';

const DOCUMENT_HINT = /\b(grant|equity plan|stock plan|rule 701|701|409a|tender|exercise|83\(b\)|tax election|cap.?table|k-?1|profits? interest|ppu)\b/i;
const EMPLOYMENT_HINT = /\b(employ|grant|option|rsu|ppu|profits? interest)\b/i;

export const KNOWN_EMPLOYMENT_ISSUERS = Object.freeze([
  {
    key: 'artwork_archive',
    display_name: 'Artwork Archive',
    aliases: ['Artwork Archive'],
    legal_form: 'llc',
    jurisdiction: null,
    confirmed_instrument_family: 'ppu',
    required_confirmations: [
      'Exact legal issuer name and exact expansion of PPU from source documents',
      'Each grant identifier, date, unit class, and granted/vested/forfeited balance',
      'Hurdle, participation waterfall, repurchase, and forfeiture terms',
      'Cash outlay, tax basis, compensation basis, distributions, and source marks',
      'Confidentiality and processing policy for each source document',
    ],
  },
  {
    key: 'guild_education',
    display_name: 'Guild Education',
    aliases: ['Guild Education', 'Guild Education, Inc.'],
    legal_form: 'c_corporation',
    jurisdiction: 'Delaware',
    confirmed_instrument_family: null,
    required_confirmations: [
      'Exact legal issuer name and every instrument type (common, ISO, NSO, RSU, or other)',
      'Each grant identifier, grant date, units, vesting state, strike, and expiration',
      'Every exercise or settlement lot with its own date, price, FMV, and remaining units',
      'Cash outlay, tax basis, compensation basis, tender activity, and source marks',
      'Confidentiality and processing policy for each Rule 701, plan, grant, and tax document',
    ],
  },
]);

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

function issuerForName(name) {
  const candidate = normalize(name);
  if (!candidate) return null;
  return KNOWN_EMPLOYMENT_ISSUERS.find(issuer =>
    issuer.aliases.some(alias => normalize(alias) === candidate)
  ) || null;
}

function analyticsSnapshot(positions, excludedIds = new Set()) {
  const rows = positions.filter(position =>
    position.asset_class === 'direct' && !excludedIds.has(Number(position.id))
  );
  return {
    position_count: rows.length,
    total_invested: rows.reduce((sum, row) => sum + Number(row.invested || 0), 0),
    total_net_value: rows.reduce((sum, row) => sum + Number(row.net_value || 0), 0),
  };
}

function resolveMerged(position, positionsById, consolidationBySource) {
  const path = [Number(position.id)];
  let current = position;
  while (current?.asset_class === 'merged') {
    const targetId = consolidationBySource.get(Number(current.id));
    if (!targetId) return { status: 'conflict', reason: 'missing_consolidation', path };
    if (path.includes(targetId)) {
      return { status: 'conflict', reason: 'consolidation_cycle', path: [...path, targetId] };
    }
    current = positionsById.get(targetId);
    path.push(targetId);
    if (!current) return { status: 'conflict', reason: 'missing_target', path };
  }
  return { status: 'resolved', target: current, path };
}

function recordsForPosition(position, records) {
  const investmentId = Number(position.id);
  return {
    valuations: records.valuations.filter(row => Number(row.investment_id) === investmentId),
    cash_flows: records.flows.filter(row => Number(row.investment_id) === investmentId),
    documents: records.documents.filter(row =>
      row.entity_type === 'investment' && Number(row.entity_id) === investmentId
    ),
    theses: records.theses.filter(row => Number(row.investment_id) === investmentId),
    evaluations: records.evaluations.filter(row => Number(row.investment_id) === investmentId),
    decisions: records.decisions.filter(row => Number(row.investment_id) === investmentId),
  };
}

export async function buildEmploymentEquityAudit() {
  const [
    positions,
    entities,
    consolidations,
    valuations,
    flows,
    documents,
    theses,
    evaluations,
    decisions,
    rooms,
    holdings,
  ] = await Promise.all([
    query(`
      SELECT id, position_key, portfolio_entity_id, company_name, asset_class,
             status, invest_date, invested, unrealized_value, realized_value,
             net_value, investment_entity, instrument, share_class, source,
             notes
        FROM investments
       ORDER BY id
    `),
    query(`
      SELECT id, entity_key, legal_name, normalized_name, entity_type,
             legal_form, jurisdiction
        FROM portfolio_entities
       ORDER BY legal_name, id
    `),
    query(`
      SELECT source_investment_id, target_investment_id
        FROM investment_consolidations
       ORDER BY source_investment_id
    `),
    query(`SELECT * FROM valuations ORDER BY investment_id, snapshot_date, id`),
    query(`SELECT * FROM cash_flows ORDER BY investment_id, flow_date, id`),
    query(`
      SELECT id, entity_type, entity_id, filename, mime, sha256, source,
             size_bytes, confidentiality, processing_policy, sync_policy,
             created_at
        FROM documents
       ORDER BY id
    `),
    query(`
      SELECT it.investment_id, t.id AS thesis_id, t.name, it.is_primary,
             it.confidence, it.tagged_by
        FROM investment_theses it
        JOIN theses t ON t.id = it.thesis_id
       ORDER BY it.investment_id, t.id
    `),
    query(`
      SELECT id, investment_id, company_name, eval_date, total_score, verdict
        FROM deal_evaluations
       WHERE investment_id IS NOT NULL
       ORDER BY investment_id, id
    `),
    query(`
      SELECT id, investment_id, decision, sealed, sealed_at
        FROM decision_records
       WHERE investment_id IS NOT NULL
       ORDER BY investment_id, id
    `),
    query(`SELECT id, name, cols FROM rooms ORDER BY id`),
    query(`SELECT id, room_id, investment_id, cells FROM room_holdings ORDER BY id`),
  ]);

  const records = { valuations, flows, documents, theses, evaluations, decisions };
  const positionsById = new Map(positions.map(row => [Number(row.id), row]));
  const consolidationBySource = new Map(consolidations.map(row => [
    Number(row.source_investment_id), Number(row.target_investment_id),
  ]));
  const conflicts = [];
  const merged_resolutions = [];

  for (const position of positions.filter(row => row.asset_class === 'merged')) {
    const resolution = resolveMerged(position, positionsById, consolidationBySource);
    if (resolution.status === 'conflict') {
      conflicts.push({ type: 'merged_position', investment_id: Number(position.id), ...resolution });
    } else {
      merged_resolutions.push({
        source_investment_id: Number(position.id),
        target_investment_id: Number(resolution.target.id),
        path: resolution.path,
      });
    }
  }

  const roomById = new Map(rooms.map(row => [Number(row.id), row]));
  const room_candidates = holdings
    .filter(row => EMPLOYMENT_HINT.test(JSON.stringify(row.cells || {})))
    .map(row => ({
      id: Number(row.id),
      room_id: Number(row.room_id),
      room_name: roomById.get(Number(row.room_id))?.name || null,
      investment_id: row.investment_id ? Number(row.investment_id) : null,
      cells: stableValue(row.cells),
      review_only: true,
    }));

  const issuer_candidates = KNOWN_EMPLOYMENT_ISSUERS.map(issuer => {
    const matchingEntities = entities.filter(entity => issuerForName(entity.legal_name)?.key === issuer.key);
    const matchingPositions = positions.filter(position =>
      issuerForName(position.company_name)?.key === issuer.key ||
      (matchingEntities.length > 0 && matchingEntities.some(entity => entity.id === position.portfolio_entity_id))
    );
    const candidatePositions = matchingPositions.map(position => ({
      ...stableValue(position),
      evidence: stableValue(recordsForPosition(position, records)),
      proposed_asset_class: 'employment_equity',
      proposed_action: position.asset_class === 'employment_equity'
        ? 'attach_typed_records'
        : position.asset_class === 'merged'
          ? 'resolve_consolidation_first'
          : 'owner_review_required',
      decision: null,
    }));
    const proposedEntity = matchingEntities[0] || {
      legal_name: issuer.display_name,
      normalized_name: normalize(issuer.display_name),
      entity_type: 'operating_company',
      legal_form: issuer.legal_form,
      jurisdiction: issuer.jurisdiction,
    };
    return {
      issuer_key: issuer.key,
      display_name: issuer.display_name,
      status: matchingEntities.length > 0 || matchingPositions.length > 0 ? 'found' : 'absent',
      confirmed_instrument_family: issuer.confirmed_instrument_family,
      existing_entities: stableValue(matchingEntities),
      existing_positions: candidatePositions,
      proposed_entity: stableValue(proposedEntity),
      proposed_grants: [],
      proposed_lots: [],
      vesting_schedule_evidence: 'none_found',
      required_owner_confirmations: issuer.required_confirmations,
      decision: null,
    };
  });

  const candidateIds = new Set(issuer_candidates.flatMap(issuer =>
    issuer.existing_positions.map(position => Number(position.id))
  ));
  const unmatched_employment_source_candidates = positions
    .filter(position => !candidateIds.has(Number(position.id)))
    .filter(position => position.asset_class !== 'merged')
    .filter(position => EMPLOYMENT_HINT.test(`${position.source || ''} ${position.instrument || ''}`))
    .map(position => ({ ...stableValue(position), review_only: true }));
  const direct_analytics_baseline = analyticsSnapshot(positions);
  const direct_analytics_if_all_candidates_reclassified = analyticsSnapshot(positions, candidateIds);

  const positionGroups = new Map();
  for (const position of positions.filter(row => row.asset_class !== 'merged')) {
    const key = position.portfolio_entity_id || `name:${normalize(position.company_name)}`;
    if (!positionGroups.has(key)) positionGroups.set(key, []);
    positionGroups.get(key).push(position);
  }
  const multiple_position_entities = [...positionGroups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([group_key, group]) => ({ group_key, positions: stableValue(group) }));

  const document_candidates = documents
    .filter(row => DOCUMENT_HINT.test(row.filename || ''))
    .map(row => ({ ...stableValue(row), review_only: true }));
  const unknown_document_policies = documents.filter(row =>
    !row.confidentiality || !row.processing_policy || !row.sync_policy
  ).map(stableValue);

  const source = {
    positions: stableValue(positions),
    entities: stableValue(entities),
    consolidations: stableValue(consolidations),
    documents: stableValue(documents),
    rooms: stableValue(rooms),
    holdings: stableValue(holdings),
  };
  const source_hash = hash(source);
  const audit = {
    audit_version: 1,
    source_hash,
    read_only: true,
    counts: {
      positions: positions.length,
      entities: entities.length,
      issuer_candidates_found: issuer_candidates.filter(row => row.status === 'found').length,
      employment_equity_positions: positions.filter(row => row.asset_class === 'employment_equity').length,
      room_candidates: room_candidates.length,
      document_candidates: document_candidates.length,
      unknown_document_policies: unknown_document_policies.length,
      conflicts: conflicts.length,
    },
    issuer_candidates,
    unmatched_employment_source_candidates,
    multiple_position_entities,
    room_candidates,
    document_candidates,
    unknown_document_policies,
    merged_resolutions,
    conflicts,
    direct_analytics_baseline,
    direct_analytics_if_all_candidates_reclassified,
    vesting_schedule_decision: issuer_candidates.every(row => row.vesting_schedule_evidence === 'none_found')
      ? 'defer_schedule_machinery'
      : 'review_required',
  };
  audit.manifest_hash = hash({ ...audit, manifest_hash: undefined });
  return audit;
}

export function formatEmploymentEquityAuditSummary(audit) {
  return [
    'Employment Equity migration audit',
    `Known issuers found / expected: ${audit.counts.issuer_candidates_found} / ${audit.issuer_candidates.length}`,
    `Existing Employment Equity positions: ${audit.counts.employment_equity_positions}`,
    `Room / document hints: ${audit.counts.room_candidates} / ${audit.counts.document_candidates}`,
    `Unknown document policies: ${audit.counts.unknown_document_policies}`,
    `Conflicts: ${audit.counts.conflicts}`,
    `Vesting schedule decision: ${audit.vesting_schedule_decision}`,
    'No database records were changed.',
  ].join('\n');
}
