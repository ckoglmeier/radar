import { createHash, randomUUID } from 'node:crypto';
import { query, withAtomicWrite } from '../db/index.js';
import { normalize } from '../utils/company-names.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPES = new Set(['operating_company', 'fund_vehicle', 'other']);
const ENTITY_CLASSES = new Set(['person', 'organization', 'vehicle', 'other']);
const INVESTING_KINDS = new Set(['individual', 'household', 'llc', 'trust', 'spv', 'fund_vehicle', 'other']);
const ROUTES = new Set(['direct_issuer', 'vehicle_interest']);

function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function assertUuid(value, label) {
  if (!UUID_PATTERN.test(String(value || ''))) throw new TypeError(`${label} must be a UUID`);
  return String(value);
}

function stableValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

async function reviewReceipt({
  subjectType,
  subjectId,
  action,
  decision,
  sourceHash,
  idempotencyKey,
  reviewedBy,
}) {
  const key = requiredText(idempotencyKey, 'Idempotency key');
  const expected = {
    subject_type: requiredText(subjectType, 'Subject type'),
    subject_id: requiredText(subjectId, 'Subject ID'),
    action: requiredText(action, 'Action'),
    decision: stableValue(decision || {}),
    source_hash: requiredText(sourceHash, 'Source hash'),
    reviewed_by: requiredText(reviewedBy, 'Reviewer'),
  };
  const [existing] = await query(`
    SELECT * FROM identity_review_receipts WHERE idempotency_key = $1
  `, [key]);
  if (existing) {
    const actual = {
      subject_type: existing.subject_type,
      subject_id: existing.subject_id,
      action: existing.action,
      decision: existing.decision,
      source_hash: existing.source_hash,
      reviewed_by: existing.reviewed_by,
    };
    if (hash(actual) !== hash(expected)) {
      throw new Error('identity review idempotency key conflicts with another decision');
    }
    return { receipt: existing, idempotent_replay: true };
  }
  const [receipt] = await query(`
    INSERT INTO identity_review_receipts
      (subject_type, subject_id, action, decision, source_hash,
       idempotency_key, reviewed_by)
    VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
    RETURNING *
  `, [
    expected.subject_type,
    expected.subject_id,
    expected.action,
    JSON.stringify(expected.decision),
    expected.source_hash,
    key,
    expected.reviewed_by,
  ]);
  return { receipt, idempotent_replay: false };
}

export { reviewReceipt as createIdentityReviewReceipt };

async function entity(entityId, { lock = false } = {}) {
  assertUuid(entityId, 'Entity ID');
  const [row] = await query(`
    SELECT * FROM portfolio_entities WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}
  `, [entityId]);
  if (!row) throw new Error(`entity not found: ${entityId}`);
  return row;
}

async function ensureSubtypeRows(entityId, { company = false, investingEntityKind = null } = {}) {
  const current = await entity(entityId, { lock: true });
  if (company) {
    if (current.entity_type !== 'operating_company') {
      throw new Error('Company subtype requires an operating_company entity');
    }
    await query(`
      INSERT INTO companies (entity_id, metadata_reviewed_at)
      VALUES ($1, NOW())
      ON CONFLICT (entity_id) DO UPDATE
        SET metadata_reviewed_at = NOW(), updated_at = NOW()
    `, [entityId]);
  }
  if (investingEntityKind != null) {
    const kind = requiredText(investingEntityKind, 'Investing Entity kind');
    if (!INVESTING_KINDS.has(kind)) throw new TypeError(`invalid Investing Entity kind: ${kind}`);
    if (kind === 'fund_vehicle' && current.entity_type !== 'fund_vehicle') {
      throw new Error('fund_vehicle subtype requires a fund_vehicle Entity');
    }
    await query(`
      INSERT INTO investing_entities (entity_id, investing_entity_kind)
      VALUES ($1, $2)
      ON CONFLICT (entity_id) DO UPDATE
        SET investing_entity_kind = EXCLUDED.investing_entity_kind,
            updated_at = NOW()
    `, [entityId, kind]);
  }
  return entityId;
}

export async function createReviewedEntity(fields = {}) {
  const legalName = requiredText(fields.legalName, 'Legal name');
  const entityType = fields.entityType || (fields.company ? 'operating_company' : 'other');
  const entityClass = fields.entityClass || (fields.investingEntityKind === 'individual' ? 'person'
    : ['fund_vehicle', 'spv'].includes(fields.investingEntityKind) ? 'vehicle'
      : 'organization');
  if (!ENTITY_TYPES.has(entityType)) throw new TypeError(`invalid Entity type: ${entityType}`);
  if (!ENTITY_CLASSES.has(entityClass)) throw new TypeError(`invalid Entity class: ${entityClass}`);
  const sourceNamespace = requiredText(fields.sourceNamespace || 'radar_manual', 'Source namespace');
  const sourceId = requiredText(fields.sourceId || randomUUID(), 'Source ID');
  const idempotencyKey = requiredText(fields.idempotencyKey || `${sourceNamespace}:${sourceId}`, 'Idempotency key');
  const sourceHash = requiredText(fields.sourceHash || hash({ legalName, entityType, entityClass }), 'Source hash');
  const reviewedBy = requiredText(fields.reviewedBy || 'local_user', 'Reviewer');

  return withAtomicWrite(async () => {
    const [existingAlias] = await query(`
      SELECT ea.entity_id
        FROM entity_aliases ea
       WHERE ea.source_namespace = $1 AND ea.source_id = $2
    `, [sourceNamespace, sourceId]);
    if (existingAlias) {
      const current = await entity(existingAlias.entity_id);
      if (current.normalized_name !== normalize(legalName)) {
        throw new Error('namespaced source identity conflicts with another Entity');
      }
      return { entity: current, idempotent_replay: true };
    }

    const entityId = fields.entityId ? assertUuid(fields.entityId, 'Entity ID') : randomUUID();
    const [created] = await query(`
      INSERT INTO portfolio_entities
        (id, entity_key, legal_name, display_name, normalized_name, entity_type,
         entity_class, identity_status, legal_form, jurisdiction, website, description)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'confirmed',$8,$9,$10,$11)
      RETURNING *
    `, [
      entityId,
      fields.entityKey ? assertUuid(fields.entityKey, 'Entity key') : randomUUID(),
      legalName,
      fields.displayName ? requiredText(fields.displayName, 'Display name') : legalName,
      normalize(legalName),
      entityType,
      entityClass,
      fields.legalForm || null,
      fields.jurisdiction || null,
      fields.website || null,
      fields.description || null,
    ]);
    await ensureSubtypeRows(created.id, {
      company: Boolean(fields.company),
      investingEntityKind: fields.investingEntityKind || null,
    });
    await query(`
      INSERT INTO entity_aliases
        (entity_id, alias, alias_normalized, source_namespace, source_id,
         review_state, reviewed_by, reviewed_at)
      VALUES ($1,$2,$3,$4,$5,'accepted',$6,NOW())
    `, [created.id, legalName, normalize(legalName), sourceNamespace, sourceId, reviewedBy]);
    await reviewReceipt({
      subjectType: 'entity',
      subjectId: created.id,
      action: 'create_reviewed_entity',
      decision: { entityType, entityClass, company: Boolean(fields.company), investingEntityKind: fields.investingEntityKind || null },
      sourceHash,
      idempotencyKey,
      reviewedBy,
    });
    return { entity: created, idempotent_replay: false };
  });
}

export async function confirmEntitySubtypes(entityId, fields = {}) {
  assertUuid(entityId, 'Entity ID');
  const reviewedBy = requiredText(fields.reviewedBy || 'local_user', 'Reviewer');
  const sourceHash = requiredText(fields.sourceHash, 'Source hash');
  return withAtomicWrite(async () => {
    const current = await entity(entityId, { lock: true });
    await ensureSubtypeRows(entityId, {
      company: Boolean(fields.company),
      investingEntityKind: fields.investingEntityKind || null,
    });
    await query(`
      UPDATE portfolio_entities
         SET display_name = COALESCE(display_name, legal_name),
             entity_class = COALESCE($2, entity_class),
             identity_status = 'confirmed',
             updated_at = NOW()
       WHERE id = $1
    `, [entityId, fields.entityClass || null]);
    const receipt = await reviewReceipt({
      subjectType: 'entity',
      subjectId: entityId,
      action: 'confirm_subtypes',
      decision: {
        company: Boolean(fields.company),
        investingEntityKind: fields.investingEntityKind || null,
        entityClass: fields.entityClass || null,
      },
      sourceHash,
      idempotencyKey: fields.idempotencyKey,
      reviewedBy,
    });
    return { entity: { ...current, identity_status: 'confirmed' }, ...receipt };
  });
}

export async function createEntityRedirect(fields = {}) {
  const supersededEntityId = assertUuid(fields.supersededEntityId, 'Superseded Entity ID');
  const canonicalEntityId = assertUuid(fields.canonicalEntityId, 'Canonical Entity ID');
  const reviewedBy = requiredText(fields.reviewedBy || 'local_user', 'Reviewer');
  const reason = requiredText(fields.reason, 'Redirect reason');
  const sourceHash = requiredText(fields.sourceHash, 'Source hash');
  return withAtomicWrite(async () => {
    const superseded = await entity(supersededEntityId, { lock: true });
    const canonical = await entity(canonicalEntityId, { lock: true });
    const [existing] = await query(`
      SELECT * FROM entity_redirects WHERE superseded_entity_id = $1
    `, [supersededEntityId]);
    if (existing) {
      if (existing.canonical_entity_id !== canonicalEntityId || existing.source_hash !== sourceHash) {
        throw new Error('superseded Entity already redirects elsewhere');
      }
      return { redirect: existing, idempotent_replay: true };
    }
    const receipt = await reviewReceipt({
      subjectType: 'redirect',
      subjectId: supersededEntityId,
      action: 'redirect_entity',
      decision: { canonicalEntityId, reason },
      sourceHash,
      idempotencyKey: fields.idempotencyKey,
      reviewedBy,
    });
    const [redirect] = await query(`
      INSERT INTO entity_redirects
        (superseded_entity_id, canonical_entity_id, reason, source_hash, reviewed_by)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
    `, [supersededEntityId, canonicalEntityId, reason, sourceHash, reviewedBy]);
    await query(`
      UPDATE portfolio_entities SET identity_status = 'retired', updated_at = NOW() WHERE id = $1
    `, [superseded.id]);
    await query(`
      UPDATE portfolio_entities SET identity_status = 'confirmed', updated_at = NOW() WHERE id = $1
    `, [canonical.id]);
    return { redirect, receipt: receipt.receipt, idempotent_replay: false };
  });
}

export async function resolveCanonicalEntityId(entityId) {
  assertUuid(entityId, 'Entity ID');
  const rows = await query(`
    WITH RECURSIVE resolved(entity_id, depth, path) AS (
      SELECT $1::uuid, 0, ARRAY[$1::uuid]
      UNION ALL
      SELECT er.canonical_entity_id, r.depth + 1, r.path || er.canonical_entity_id
        FROM resolved r
        JOIN entity_redirects er ON er.superseded_entity_id = r.entity_id
       WHERE r.depth < 32 AND NOT er.canonical_entity_id = ANY(r.path)
    )
    SELECT entity_id FROM resolved ORDER BY depth DESC LIMIT 1
  `, [entityId]);
  return rows[0]?.entity_id || entityId;
}

export async function linkPositionIdentity(investmentId, fields = {}) {
  const positionId = Number(investmentId);
  if (!Number.isSafeInteger(positionId) || positionId <= 0) throw new TypeError('Position ID must be a positive integer');
  const holderEntityId = assertUuid(fields.holderEntityId, 'Holder Entity ID');
  const issuerEntityId = assertUuid(fields.issuerEntityId, 'Issuer Entity ID');
  const route = requiredText(fields.routeClassification, 'Route classification');
  if (!ROUTES.has(route)) throw new TypeError(`invalid route classification: ${route}`);
  const sourceHash = requiredText(fields.sourceHash, 'Source hash');
  const reviewedBy = requiredText(fields.reviewedBy || 'local_user', 'Reviewer');

  return withAtomicWrite(async () => {
    const [position] = await query(`SELECT * FROM investments WHERE id = $1 FOR UPDATE`, [positionId]);
    if (!position || position.asset_class === 'merged') throw new Error(`active Position not found: ${positionId}`);
    const [holder] = await query(`SELECT * FROM investing_entities WHERE entity_id = $1`, [holderEntityId]);
    if (!holder) throw new Error('holder must be a reviewed Investing Entity');
    await entity(issuerEntityId);
    const receiptResult = await reviewReceipt({
      subjectType: 'position',
      subjectId: String(positionId),
      action: 'link_position_identity',
      decision: { holderEntityId, issuerEntityId, routeClassification: route },
      sourceHash,
      idempotencyKey: fields.idempotencyKey,
      reviewedBy,
    });
    const [updated] = await query(`
      UPDATE investments
         SET holder_entity_id = $2,
             issuer_entity_id = $3,
             identity_review_status = 'accepted',
             route_classification = $4,
             identity_receipt_id = $5,
             updated_at = NOW()
       WHERE id = $1
       RETURNING *
    `, [positionId, holderEntityId, issuerEntityId, route, receiptResult.receipt.id]);
    return { position: updated, ...receiptResult };
  });
}

export async function restorePositionIdentity(investmentId, snapshot = {}) {
  const positionId = Number(investmentId);
  if (!Number.isSafeInteger(positionId) || positionId <= 0) throw new TypeError('Position ID must be a positive integer');
  const status = requiredText(snapshot.identity_review_status, 'Identity review status');
  const route = requiredText(snapshot.route_classification, 'Route classification');
  if (!['unresolved', 'accepted'].includes(status)) throw new TypeError(`invalid identity review status: ${status}`);
  if (![...ROUTES, 'unresolved'].includes(route)) throw new TypeError(`invalid route classification: ${route}`);
  const holderEntityId = snapshot.holder_entity_id == null ? null : assertUuid(snapshot.holder_entity_id, 'Holder Entity ID');
  const issuerEntityId = snapshot.issuer_entity_id == null ? null : assertUuid(snapshot.issuer_entity_id, 'Issuer Entity ID');
  const receiptId = snapshot.identity_receipt_id == null ? null : assertUuid(snapshot.identity_receipt_id, 'Identity receipt ID');
  if (status === 'accepted' && (!holderEntityId || !issuerEntityId || !receiptId || route === 'unresolved')) {
    throw new TypeError('accepted identity requires holder, issuer, route, and receipt');
  }
  if (status === 'unresolved' && route !== 'unresolved') {
    throw new TypeError('unresolved identity requires an unresolved route');
  }
  return withAtomicWrite(async () => {
    const [restored] = await query(`
      UPDATE investments
         SET holder_entity_id = $2,
             issuer_entity_id = $3,
             identity_review_status = $4,
             route_classification = $5,
             identity_receipt_id = $6,
             updated_at = NOW()
       WHERE id = $1 AND asset_class <> 'merged'
       RETURNING *
    `, [positionId, holderEntityId, issuerEntityId, status, route, receiptId]);
    if (!restored) throw new Error(`active Position not found: ${positionId}`);
    return { position: restored };
  });
}

function entityName(row) {
  return row.display_name || row.legal_name;
}

function addCandidate(index, normalizedName, entityId) {
  if (!normalizedName) return;
  if (!index.has(normalizedName)) index.set(normalizedName, new Set());
  index.get(normalizedName).add(entityId);
}

function resolvedRedirect(entityId, redirects) {
  let current = entityId;
  const seen = new Set();
  while (current && redirects.has(current) && !seen.has(current)) {
    seen.add(current);
    current = redirects.get(current);
  }
  return current;
}

export async function proposeCanonicalIdentityMappings() {
  const [positions, entities, aliases, precedents, redirects] = await Promise.all([
    query(`
      SELECT i.id, i.position_key, i.company_name, i.asset_class,
             i.investment_entity, i.portfolio_entity_id
        FROM investments i
       WHERE i.asset_class <> 'merged' AND i.identity_review_status = 'unresolved'
       ORDER BY i.asset_class, LOWER(i.company_name), i.id
    `),
    canonicalIdentityCandidates(),
    query(`
      SELECT ea.entity_id, ea.alias_normalized
        FROM entity_aliases ea
       WHERE ea.review_state = 'accepted'
       ORDER BY ea.entity_id, ea.id
    `),
    query(`
      SELECT investment_entity, holder_entity_id
        FROM investments
       WHERE asset_class <> 'merged'
         AND identity_review_status = 'accepted'
         AND holder_entity_id IS NOT NULL
         AND NULLIF(TRIM(investment_entity), '') IS NOT NULL
       ORDER BY id
    `),
    query(`SELECT superseded_entity_id, canonical_entity_id FROM entity_redirects`),
  ]);

  const byId = new Map(entities.map(row => [row.id, row]));
  const redirectMap = new Map(redirects.map(row => [row.superseded_entity_id, row.canonical_entity_id]));
  const holderNames = new Map();
  const issuerNames = new Map();
  const holderPrecedent = new Map();

  for (const row of entities) {
    const normalizedNames = new Set([normalize(row.legal_name), normalize(row.display_name)].filter(Boolean));
    if (row.investing_entity_kind) {
      for (const name of normalizedNames) addCandidate(holderNames, name, row.id);
    }
    if (row.is_company || ['spv', 'fund_vehicle'].includes(row.investing_entity_kind)) {
      for (const name of normalizedNames) addCandidate(issuerNames, name, row.id);
    }
  }
  for (const alias of aliases) {
    const row = byId.get(alias.entity_id);
    if (!row) continue;
    if (row.investing_entity_kind) addCandidate(holderNames, alias.alias_normalized, row.id);
    if (row.is_company || ['spv', 'fund_vehicle'].includes(row.investing_entity_kind)) {
      addCandidate(issuerNames, alias.alias_normalized, row.id);
    }
  }
  for (const precedent of precedents) {
    addCandidate(holderPrecedent, normalize(precedent.investment_entity), precedent.holder_entity_id);
  }

  const proposals = positions.map(position => {
    const routeClassification = position.asset_class === 'fund' ? 'vehicle_interest' : 'direct_issuer';
    const holderName = normalize(position.investment_entity);
    const holderIds = new Set([
      ...(holderNames.get(holderName) || []),
      ...(holderPrecedent.get(holderName) || []),
    ]);
    const validHolderIds = [...holderIds].filter(id => byId.get(id)?.investing_entity_kind);

    const portfolioEntityId = resolvedRedirect(position.portfolio_entity_id, redirectMap);
    const portfolioEntity = byId.get(portfolioEntityId);
    const validIssuer = routeClassification === 'vehicle_interest'
      ? ['spv', 'fund_vehicle'].includes(portfolioEntity?.investing_entity_kind)
      : Boolean(portfolioEntity?.is_company);
    const namedIssuerIds = issuerNames.get(normalize(position.company_name)) || new Set();
    const issuerIds = validIssuer ? [portfolioEntityId] : [...namedIssuerIds].filter(id => {
      const row = byId.get(id);
      return routeClassification === 'vehicle_interest'
        ? ['spv', 'fund_vehicle'].includes(row?.investing_entity_kind)
        : Boolean(row?.is_company);
    });
    const uniqueIssuerIds = [...new Set(issuerIds)];
    const ready = Boolean(holderName) && validHolderIds.length === 1 && uniqueIssuerIds.length === 1;
    const missing = [];
    if (!holderName) missing.push('holder name is not recorded');
    else if (validHolderIds.length === 0) missing.push('no exact reviewed holder');
    else if (validHolderIds.length > 1) missing.push('holder name matches more than one reviewed entity');
    if (uniqueIssuerIds.length === 0) missing.push('no exact reviewed immediate issuer');
    else if (uniqueIssuerIds.length > 1) missing.push('issuer name matches more than one reviewed entity');
    const holder = validHolderIds.length === 1 ? byId.get(validHolderIds[0]) : null;
    const issuer = uniqueIssuerIds.length === 1 ? byId.get(uniqueIssuerIds[0]) : null;
    return {
      investment_id: Number(position.id),
      position_key: position.position_key,
      company_name: position.company_name,
      asset_class: position.asset_class,
      investment_entity: position.investment_entity,
      route_classification: routeClassification,
      holder_entity_id: holder?.id || null,
      holder_name: holder ? entityName(holder) : null,
      issuer_entity_id: issuer?.id || null,
      issuer_name: issuer ? entityName(issuer) : null,
      confidence: ready ? 'deterministic' : 'needs_review',
      selected_by_default: ready,
      evidence: ready ? [
        holderPrecedent.get(holderName)?.has(holder.id) ? 'same recorded holder was reviewed before' : 'exact reviewed holder name or alias',
        validIssuer ? 'existing canonical Position entity' : 'exact reviewed issuer name or alias',
      ] : [],
      missing,
      holder_candidates: validHolderIds.map(id => ({ id, name: entityName(byId.get(id)) })),
      issuer_candidates: uniqueIssuerIds.map(id => ({ id, name: entityName(byId.get(id)) })),
    };
  });
  const ready = proposals.filter(row => row.selected_by_default);
  const grouped = new Map();
  for (const proposal of ready) {
    const key = `${proposal.holder_entity_id}:${proposal.route_classification}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        holder_entity_id: proposal.holder_entity_id,
        holder_name: proposal.holder_name,
        route_classification: proposal.route_classification,
        positions: [],
      });
    }
    grouped.get(key).positions.push(proposal);
  }
  return {
    summary: {
      total: proposals.length,
      ready: ready.length,
      needs_review: proposals.length - ready.length,
      groups: grouped.size,
    },
    groups: [...grouped.values()],
    proposals,
  };
}

export async function canonicalIdentityReviewQueue() {
  const [positions, redirects, aliases, exposures] = await Promise.all([
    query(`
      SELECT i.id, i.position_key, i.company_name, i.asset_class,
             i.investment_entity, i.portfolio_entity_id, i.holder_entity_id,
             i.issuer_entity_id, i.identity_review_status, i.route_classification
        FROM investments i
       WHERE i.asset_class <> 'merged' AND i.identity_review_status = 'unresolved'
       ORDER BY i.asset_class, LOWER(i.company_name), i.id
    `),
    query(`
      SELECT er.*, old.legal_name AS superseded_name, canonical.legal_name AS canonical_name
        FROM entity_redirects er
        JOIN portfolio_entities old ON old.id = er.superseded_entity_id
        JOIN portfolio_entities canonical ON canonical.id = er.canonical_entity_id
       ORDER BY er.reviewed_at DESC
    `),
    query(`
      SELECT ea.*, pe.legal_name
        FROM entity_aliases ea JOIN portfolio_entities pe ON pe.id = ea.entity_id
       WHERE ea.review_state = 'needs_review'
       ORDER BY ea.created_at, ea.id
    `),
    query(`
      SELECT vec.id, vec.raw_target_name, vec.source_claim_id, vec.resolution_status,
             vps.vehicle_entity_id, pe.legal_name AS vehicle_name
        FROM vehicle_exposure_claims vec
        JOIN vehicle_portfolio_snapshots vps ON vps.id = vec.snapshot_id
        JOIN portfolio_entities pe ON pe.id = vps.vehicle_entity_id
       WHERE vec.resolution_status = 'unresolved'
       ORDER BY vps.received_date DESC, vec.source_claim_id
    `),
  ]);
  return { positions, redirects, aliases, exposures };
}

export async function canonicalIdentityCandidates() {
  return query(`
    SELECT pe.id, pe.legal_name, pe.display_name, pe.entity_type,
           pe.entity_class, pe.identity_status,
           (c.entity_id IS NOT NULL) AS is_company,
           ie.investing_entity_kind, ie.lifecycle_status AS investing_lifecycle_status
      FROM portfolio_entities pe
      LEFT JOIN companies c ON c.entity_id = pe.id
      LEFT JOIN investing_entities ie ON ie.entity_id = pe.id
     WHERE pe.identity_status = 'confirmed'
     ORDER BY LOWER(COALESCE(pe.display_name, pe.legal_name)), pe.id
  `);
}

export async function backfillCanonicalEntitySubtypes({ reviewedBy = 'migration_061' } = {}) {
  return withAtomicWrite(async () => {
    const entities = await query(`SELECT * FROM portfolio_entities ORDER BY id FOR UPDATE`);
    const result = { companies: 0, investing_entities: 0, fund_profiles: 0 };
    for (const current of entities) {
      const sourceHash = hash({
        entity_key: current.entity_key,
        entity_type: current.entity_type,
        legal_name: current.legal_name,
      });
      if (current.entity_type === 'operating_company') {
        const rows = await query(`
          INSERT INTO companies (entity_id, metadata_reviewed_at)
          VALUES ($1, NOW()) ON CONFLICT (entity_id) DO NOTHING RETURNING entity_id
        `, [current.id]);
        result.companies += rows.length;
        await query(`
          UPDATE portfolio_entities
             SET display_name = COALESCE(display_name, legal_name),
                 entity_class = COALESCE(entity_class, 'organization'),
                 identity_status = 'confirmed', updated_at = NOW()
           WHERE id = $1
        `, [current.id]);
      } else if (current.entity_type === 'fund_vehicle') {
        const rows = await query(`
          INSERT INTO investing_entities (entity_id, investing_entity_kind)
          VALUES ($1, 'fund_vehicle') ON CONFLICT (entity_id) DO NOTHING RETURNING entity_id
        `, [current.id]);
        result.investing_entities += rows.length;
        await query(`
          UPDATE portfolio_entities
             SET display_name = COALESCE(display_name, legal_name),
                 entity_class = COALESCE(entity_class, 'vehicle'),
                 identity_status = 'confirmed', updated_at = NOW()
           WHERE id = $1
        `, [current.id]);
        const profiles = await query(`
          SELECT fp.manager, fp.strategy, fp.vintage_year, fp.description
            FROM investments i
            JOIN fund_profiles fp ON fp.investment_id = i.id
           WHERE i.portfolio_entity_id = $1
           ORDER BY i.id
        `, [current.id]);
        const uniqueProfiles = new Map(profiles.map(row => [hash(row), row]));
        if (uniqueProfiles.size === 1) {
          const profile = [...uniqueProfiles.values()][0];
          const inserted = await query(`
            INSERT INTO fund_vehicle_profiles
              (entity_id, manager, strategy, vintage_year, description,
               review_state, source_hash, reviewed_by, reviewed_at)
            VALUES ($1,$2,$3,$4,$5,'accepted',$6,$7,NOW())
            ON CONFLICT (entity_id) DO NOTHING
            RETURNING entity_id
          `, [current.id, profile.manager, profile.strategy, profile.vintage_year,
            profile.description, hash(profiles), reviewedBy]);
          result.fund_profiles += inserted.length;
        } else if (uniqueProfiles.size > 1) {
          await query(`
            INSERT INTO fund_vehicle_profiles
              (entity_id, review_state, source_hash, reviewed_by, reviewed_at)
            VALUES ($1,'conflict',$2,$3,NOW())
            ON CONFLICT (entity_id) DO UPDATE
              SET review_state = 'conflict', source_hash = EXCLUDED.source_hash,
                  reviewed_by = EXCLUDED.reviewed_by, reviewed_at = NOW(), updated_at = NOW()
          `, [current.id, hash(profiles), reviewedBy]);
        }
      }
      await reviewReceipt({
        subjectType: 'entity',
        subjectId: current.id,
        action: 'backfill_canonical_subtype',
        decision: { entityType: current.entity_type },
        sourceHash,
        idempotencyKey: `canonical-subtype-v1:${current.entity_key}`,
        reviewedBy,
      });
    }
    return result;
  });
}

export async function canonicalEntityRecord(entityId) {
  const canonicalId = await resolveCanonicalEntityId(entityId);
  const [record] = await query(`
    SELECT pe.*,
           (c.entity_id IS NOT NULL) AS is_company,
           ie.investing_entity_kind, ie.lifecycle_status AS investing_lifecycle_status
      FROM portfolio_entities pe
      LEFT JOIN companies c ON c.entity_id = pe.id
      LEFT JOIN investing_entities ie ON ie.entity_id = pe.id
     WHERE pe.id = $1
  `, [canonicalId]);
  if (!record) return null;
  const aliases = await query(`
    SELECT alias, alias_normalized, source_namespace, source_id, review_state
      FROM entity_aliases WHERE entity_id = $1 AND review_state = 'accepted'
     ORDER BY LOWER(alias), id
  `, [canonicalId]);
  return { ...record, requested_entity_id: entityId, canonical_entity_id: canonicalId, aliases };
}
