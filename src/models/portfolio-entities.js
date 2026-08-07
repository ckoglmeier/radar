import { createHash } from 'node:crypto';
import { isPgliteActive, query } from '../db/index.js';
import { normalize } from '../utils/company-names.js';

const MANIFEST_VERSION = 1;
const ENTITY_TYPES = new Set(['operating_company', 'fund_vehicle', 'other']);
const DECISIONS = new Set(['create_and_link', 'link_existing', 'leave_unlinked']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function stableUuid(value) {
  const hex = hash(value).slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ['8', '9', 'a', 'b'][parseInt(hex[16], 16) % 4];
  return [
    hex.slice(0, 8).join(''),
    hex.slice(8, 12).join(''),
    hex.slice(12, 16).join(''),
    hex.slice(16, 20).join(''),
    hex.slice(20).join(''),
  ].join('-');
}

function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b)));
}

function positionSource(position) {
  return {
    id: Number(position.id),
    position_key: position.position_key,
    company_name: position.company_name,
    asset_class: position.asset_class,
    invest_date: position.invest_date,
    investment_entity: position.investment_entity,
    investment_type: position.investment_type,
    instrument: position.instrument,
    round: position.round,
    fund_name: position.fund_name,
    source: position.source,
  };
}

function sourcePayload({ positions, aliases, consolidations }) {
  return {
    positions: positions
      .map(positionSource)
      .sort((a, b) => a.position_key.localeCompare(b.position_key)),
    aliases: aliases
      .map(alias => ({
        id: Number(alias.id),
        alias: alias.alias,
        alias_normalized: alias.alias_normalized,
        canonical_company_name: alias.canonical_company_name,
        canonical_normalized: alias.canonical_normalized,
        provenance_source: alias.provenance_source,
        provenance_note: alias.provenance_note,
        confirmed_by: alias.confirmed_by,
      }))
      .sort((a, b) => a.id - b.id),
    consolidations: consolidations
      .map(row => ({
        source_investment_id: Number(row.source_investment_id),
        target_investment_id: Number(row.target_investment_id),
      }))
      .sort((a, b) => a.source_investment_id - b.source_investment_id),
  };
}

function resolveMergedPosition(position, positionsById, consolidationBySource) {
  const path = [Number(position.id)];
  let current = position;
  while (current.asset_class === 'merged') {
    const targetId = consolidationBySource.get(Number(current.id));
    if (!targetId) {
      return { status: 'conflict', reason: 'missing_consolidation', path };
    }
    if (path.includes(targetId)) {
      return { status: 'conflict', reason: 'consolidation_cycle', path: [...path, targetId] };
    }
    const target = positionsById.get(targetId);
    if (!target) {
      return { status: 'conflict', reason: 'missing_target', path: [...path, targetId] };
    }
    path.push(targetId);
    current = target;
  }
  return {
    status: 'resolved',
    source_investment_id: Number(position.id),
    target_investment_id: Number(current.id),
    target_position_key: current.position_key,
    path,
  };
}

function candidateProposal(candidate) {
  return {
    candidate_id: candidate.candidate_id,
    entity_key: candidate.entity_key,
    entity_type: candidate.entity_type,
    legal_name: candidate.legal_name,
    normalized_name: candidate.normalized_name,
    position_keys: candidate.position_keys,
    position_evidence: candidate.position_evidence,
    alias_ids: candidate.alias_ids,
    alias_evidence: candidate.alias_evidence,
    proposed_action: candidate.proposed_action,
    proposed_entity_id: candidate.proposed_entity_id,
  };
}

function manifestPlan(manifest) {
  return {
    candidates: manifest.candidates.map(candidateProposal),
    existing_links: manifest.existing_links,
    merged_resolutions: manifest.merged_resolutions,
    conflicts: manifest.conflicts,
  };
}

async function loadIdentitySource() {
  const [positions, aliases, consolidations, entities] = await Promise.all([
    query(`
      SELECT id, position_key, portfolio_entity_id, company_name, asset_class,
             invest_date, investment_entity, investment_type, instrument,
             round, fund_name, source
        FROM investments
       ORDER BY id
    `),
    query(`
      SELECT id, alias, alias_normalized, canonical_company_name,
             canonical_normalized, provenance_source, provenance_note,
             confirmed_by, portfolio_entity_id
        FROM company_aliases
       ORDER BY id
    `),
    query(`
      SELECT source_investment_id, target_investment_id
        FROM investment_consolidations
       ORDER BY source_investment_id
    `),
    query(`
      SELECT id, entity_key, legal_name, normalized_name, entity_type
        FROM portfolio_entities
       ORDER BY id
    `),
  ]);
  return { positions, aliases, consolidations, entities };
}

export async function buildPortfolioEntityManifest() {
  const source = await loadIdentitySource();
  const positionsById = new Map(source.positions.map(row => [Number(row.id), row]));
  const consolidationBySource = new Map(source.consolidations.map(row => [
    Number(row.source_investment_id),
    Number(row.target_investment_id),
  ]));
  const aliasesByNormalized = new Map(source.aliases.map(alias => [alias.alias_normalized, alias]));
  const merged_resolutions = [];
  const conflicts = [];

  for (const position of source.positions.filter(row => row.asset_class === 'merged')) {
    const resolution = resolveMergedPosition(position, positionsById, consolidationBySource);
    if (resolution.status === 'resolved') {
      merged_resolutions.push(resolution);
    } else {
      conflicts.push({
        type: 'merged_position',
        investment_id: Number(position.id),
        position_key: position.position_key,
        ...resolution,
      });
    }
  }

  const groups = new Map();
  for (const position of source.positions) {
    if (position.asset_class === 'merged') continue;
    if (!['direct', 'fund', 'employment_equity'].includes(position.asset_class)) {
      conflicts.push({
        type: 'unsupported_asset_class',
        investment_id: Number(position.id),
        position_key: position.position_key,
        asset_class: position.asset_class,
      });
      continue;
    }

    const positionNormalized = normalize(position.company_name);
    const alias = aliasesByNormalized.get(positionNormalized);
    const canonicalNormalized = alias?.canonical_normalized || positionNormalized;
    if (!canonicalNormalized) {
      conflicts.push({
        type: 'unusable_normalized_name',
        investment_id: Number(position.id),
        position_key: position.position_key,
        company_name: position.company_name,
      });
      continue;
    }
    const entityType = position.asset_class === 'fund' ? 'fund_vehicle' : 'operating_company';
    const groupKey = entityType === 'fund_vehicle'
      ? `fund_vehicle:${position.position_key}`
      : `operating_company:${canonicalNormalized}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        groupKey,
        entityType,
        canonicalNormalized,
        positions: [],
        aliases: [],
      });
    }
    const group = groups.get(groupKey);
    group.positions.push(position);
    if (alias) group.aliases.push(alias);
  }

  const candidates = [];
  const existing_links = [];
  for (const group of [...groups.values()].sort((a, b) => a.groupKey.localeCompare(b.groupKey))) {
    if (group.entityType === 'operating_company') {
      group.aliases.push(...source.aliases.filter(alias =>
        alias.canonical_normalized === group.canonicalNormalized
      ));
      group.aliases = [...new Map(group.aliases.map(alias => [Number(alias.id), alias])).values()];
    }
    const linkedEntityIds = sortedUnique([
      ...group.positions.map(row => row.portfolio_entity_id),
      ...group.aliases.map(row => row.portfolio_entity_id),
    ].filter(Boolean));
    if (linkedEntityIds.length > 1) {
      conflicts.push({
        type: 'conflicting_existing_entity_links',
        group_key: group.groupKey,
        position_keys: sortedUnique(group.positions.map(row => row.position_key)),
        entity_ids: linkedEntityIds,
      });
      continue;
    }

    const unlinked = group.positions.filter(row => !row.portfolio_entity_id);
    const unlinkedAliases = group.aliases.filter(row => !row.portfolio_entity_id);
    if (unlinked.length === 0 && unlinkedAliases.length === 0) {
      existing_links.push({
        group_key: group.groupKey,
        entity_id: linkedEntityIds[0],
        position_keys: sortedUnique(group.positions.map(row => row.position_key)),
      });
      continue;
    }

    const aliasNames = sortedUnique(group.aliases.map(alias => alias.canonical_company_name));
    const positionNames = sortedUnique(group.positions.map(row => row.company_name));
    const legalName = aliasNames[0] || positionNames[0];
    const exactEntities = group.entityType === 'fund_vehicle'
      ? []
      : source.entities.filter(entity =>
          entity.entity_type === group.entityType &&
          entity.normalized_name === group.canonicalNormalized
        );

    if (linkedEntityIds.length === 0 && exactEntities.length > 1) {
      conflicts.push({
        type: 'ambiguous_existing_entities',
        group_key: group.groupKey,
        position_keys: sortedUnique(unlinked.map(row => row.position_key)),
        entity_ids: exactEntities.map(entity => entity.id).sort(),
      });
      continue;
    }

    const proposedEntityId = linkedEntityIds[0] || exactEntities[0]?.id || null;
    const candidate = {
      candidate_id: stableUuid(`candidate:${group.groupKey}`),
      entity_key: proposedEntityId
        ? (source.entities.find(entity => entity.id === proposedEntityId)?.entity_key || null)
        : stableUuid(`entity:${group.groupKey}`),
      entity_type: group.entityType,
      legal_name: legalName,
      normalized_name: group.canonicalNormalized,
      position_keys: sortedUnique(unlinked.map(row => row.position_key)),
      position_evidence: group.positions
        .map(row => ({
          investment_id: Number(row.id),
          position_key: row.position_key,
          company_name: row.company_name,
          asset_class: row.asset_class,
          invest_date: stableValue(row.invest_date),
          investment_entity: row.investment_entity,
          source: row.source,
          current_portfolio_entity_id: row.portfolio_entity_id,
        }))
        .sort((a, b) => a.position_key.localeCompare(b.position_key)),
      alias_ids: sortedUnique(unlinkedAliases.map(alias => Number(alias.id))),
      alias_evidence: group.aliases
        .map(alias => ({
          alias_id: Number(alias.id),
          alias: alias.alias,
          canonical_company_name: alias.canonical_company_name,
          provenance_source: alias.provenance_source,
          provenance_note: alias.provenance_note,
          confirmed_by: alias.confirmed_by,
        }))
        .sort((a, b) => a.alias_id - b.alias_id),
      proposed_action: proposedEntityId ? 'link_existing' : 'create_and_link',
      proposed_entity_id: proposedEntityId,
      decision: null,
    };
    candidate.proposal_hash = hash(candidateProposal(candidate));
    candidates.push(candidate);
  }

  const payload = sourcePayload(source);
  const manifest = {
    manifest_version: MANIFEST_VERSION,
    source_hash: hash(payload),
    counts: {
      positions: source.positions.length,
      candidates: candidates.length,
      already_linked_groups: existing_links.length,
      merged_resolved: merged_resolutions.length,
      conflicts: conflicts.length,
    },
    candidates,
    existing_links,
    merged_resolutions,
    conflicts,
  };
  manifest.plan_hash = hash(manifestPlan(manifest));
  return manifest;
}

function requiredDecision(candidate) {
  const action = candidate.decision?.action;
  if (!DECISIONS.has(action)) {
    throw new Error(`candidate ${candidate.candidate_id} requires a reviewed decision`);
  }
  if (hash(candidateProposal(candidate)) !== candidate.proposal_hash) {
    throw new Error(`candidate ${candidate.candidate_id} proposal was modified after audit`);
  }
  return action;
}

function assertUuid(value, label) {
  if (!UUID_PATTERN.test(String(value || ''))) throw new Error(`${label} must be a UUID`);
}

async function createOrResolveEntity(candidate) {
  const legalName = String(candidate.decision?.legal_name || candidate.legal_name || '').trim();
  const normalizedName = normalize(legalName);
  const entityType = candidate.entity_type;
  if (!legalName || !normalizedName) throw new Error(`candidate ${candidate.candidate_id} requires a legal name`);
  if (!ENTITY_TYPES.has(entityType)) throw new Error(`candidate ${candidate.candidate_id} has an invalid entity type`);
  assertUuid(candidate.entity_key, `candidate ${candidate.candidate_id} entity_key`);

  await query(`
    INSERT INTO portfolio_entities
      (entity_key, legal_name, normalized_name, entity_type, legal_form,
       jurisdiction, website, description)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (entity_key) DO NOTHING
  `, [
    candidate.entity_key,
    legalName,
    normalizedName,
    entityType,
    candidate.decision?.legal_form || null,
    candidate.decision?.jurisdiction || null,
    candidate.decision?.website || null,
    candidate.decision?.description || null,
  ]);
  const [entity] = await query(`
    SELECT id, entity_key, normalized_name, entity_type
      FROM portfolio_entities
     WHERE entity_key = $1
  `, [candidate.entity_key]);
  if (!entity || entity.normalized_name !== normalizedName || entity.entity_type !== entityType) {
    throw new Error(`candidate ${candidate.candidate_id} conflicts with an existing entity_key`);
  }
  return entity;
}

async function resolveExistingEntity(candidate) {
  const entityId = candidate.decision?.entity_id || candidate.proposed_entity_id;
  assertUuid(entityId, `candidate ${candidate.candidate_id} entity_id`);
  const [entity] = await query(`
    SELECT id, entity_key, normalized_name, entity_type
      FROM portfolio_entities
     WHERE id = $1
  `, [entityId]);
  if (!entity) throw new Error(`candidate ${candidate.candidate_id} references a missing entity`);
  if (entity.entity_type !== candidate.entity_type) {
    throw new Error(`candidate ${candidate.candidate_id} entity type does not match`);
  }
  return entity;
}

export async function applyPortfolioEntityManifest(manifest) {
  if (!(await isPgliteActive())) {
    throw new Error('portfolio entity manifest apply requires local PGlite transaction support');
  }
  if (manifest?.manifest_version !== MANIFEST_VERSION) {
    throw new Error(`unsupported portfolio entity manifest version: ${manifest?.manifest_version ?? 'missing'}`);
  }
  if (!Array.isArray(manifest.candidates) || !Array.isArray(manifest.conflicts)) {
    throw new Error('invalid portfolio entity manifest');
  }
  if (manifest.plan_hash !== hash(manifestPlan(manifest))) {
    throw new Error('portfolio entity manifest plan was modified after audit');
  }
  if (manifest.conflicts.length > 0) {
    throw new Error(`manifest has ${manifest.conflicts.length} unresolved conflict(s)`);
  }

  const fresh = await buildPortfolioEntityManifest();
  if (fresh.source_hash !== manifest.source_hash) {
    throw new Error('portfolio entity manifest is stale; run the audit again');
  }
  const decisions = manifest.candidates.map(candidate => ({
    candidate,
    action: requiredDecision(candidate),
  }));

  const result = { entities_created: 0, positions_linked: 0, aliases_linked: 0, unchanged: 0 };
  await query('BEGIN');
  try {
    for (const { candidate, action } of decisions) {
      if (action === 'leave_unlinked') continue;
      const beforeEntities = action === 'create_and_link'
        ? await query(`SELECT id FROM portfolio_entities WHERE entity_key = $1`, [candidate.entity_key])
        : [];
      const entity = action === 'create_and_link'
        ? await createOrResolveEntity(candidate)
        : await resolveExistingEntity(candidate);
      if (action === 'create_and_link' && beforeEntities.length === 0) result.entities_created++;

      for (const positionKey of candidate.position_keys) {
        assertUuid(positionKey, `candidate ${candidate.candidate_id} position_key`);
        const [position] = await query(`
          SELECT id, asset_class, portfolio_entity_id
            FROM investments
           WHERE position_key = $1
        `, [positionKey]);
        if (!position) throw new Error(`candidate ${candidate.candidate_id} references a missing position`);
        if (position.asset_class === 'merged') {
          throw new Error(`candidate ${candidate.candidate_id} cannot link a merged position`);
        }
        if (position.portfolio_entity_id && position.portfolio_entity_id !== entity.id) {
          throw new Error(`candidate ${candidate.candidate_id} position is linked to another entity`);
        }
        if (position.portfolio_entity_id === entity.id) {
          result.unchanged++;
        } else {
          await query(`
            UPDATE investments
               SET portfolio_entity_id = $1, updated_at = NOW()
             WHERE id = $2
          `, [entity.id, position.id]);
          result.positions_linked++;
        }
      }

      for (const aliasId of candidate.alias_ids) {
        const [alias] = await query(`
          SELECT id, portfolio_entity_id FROM company_aliases WHERE id = $1
        `, [aliasId]);
        if (!alias) throw new Error(`candidate ${candidate.candidate_id} references a missing alias`);
        if (alias.portfolio_entity_id && alias.portfolio_entity_id !== entity.id) {
          throw new Error(`candidate ${candidate.candidate_id} alias is linked to another entity`);
        }
        if (!alias.portfolio_entity_id) {
          await query(`
            UPDATE company_aliases
               SET portfolio_entity_id = $1, updated_at = NOW()
             WHERE id = $2
          `, [entity.id, alias.id]);
          result.aliases_linked++;
        }
      }
    }
    await query('COMMIT');
    return result;
  } catch (error) {
    try {
      await query('ROLLBACK');
    } catch {
      // Preserve the apply error.
    }
    throw error;
  }
}

export async function listPortfolioEntities() {
  return query(`
    SELECT pe.id, pe.entity_key, pe.legal_name, pe.normalized_name,
           pe.entity_type, pe.legal_form, pe.jurisdiction, pe.website,
           pe.description, pe.created_at, pe.updated_at,
           COUNT(i.id)::int AS position_count
      FROM portfolio_entities pe
      LEFT JOIN investments i ON i.portfolio_entity_id = pe.id
     GROUP BY pe.id
     ORDER BY LOWER(pe.legal_name), pe.id
  `);
}
