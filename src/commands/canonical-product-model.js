import { query, writeCapabilities } from '../db/index.js';
import {
  backfillCanonicalEntitySubtypes,
  createEntityRedirect,
  createReviewedEntity,
  linkPositionIdentity,
} from '../models/canonical-identity.js';
import {
  recordVehiclePortfolioDisclosure,
  resolveVehicleExposureClaim,
} from '../models/vehicle-disclosures.js';
import { CommandError } from './errors.js';

const objectResult = { type: 'object', additionalProperties: true };
const nullableText = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const nullableDate = { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] };
const nullableMoney = { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] };

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

async function available() {
  const capabilities = await writeCapabilities();
  return capabilities.proposalApply === 'transactional' && capabilities.serializedWrites;
}

function base(definition) {
  return {
    version: 1,
    tier: 'A',
    domainAtomicity: 'multi_statement',
    proposeCapabilities: ['portfolio:propose'],
    applyCapabilities: ['portfolio:apply:metadata'],
    availability: available,
    resultSchema: objectResult,
    plannerExposure: true,
    interactionPolicy: 'execute_inline',
    undoPolicy: 'unavailable',
    ...definition,
  };
}

function preview(summary, target, before, after, warnings = []) {
  return { summary, target, before: [before], after: [after], derivedEffects: [], warnings, requiredReason: false };
}

async function entityTarget(entityId) {
  const [row] = await query(`SELECT * FROM portfolio_entities WHERE id = $1`, [entityId]);
  if (!row) throw new CommandError('TARGET_NOT_FOUND', `Entity not found: ${entityId}`);
  return { type: 'entity', id: row.id, label: row.display_name || row.legal_name };
}

export const canonicalProductModelCommandDefinitions = [
  base({
    name: 'identity.prepare', title: 'Prepare canonical identities',
    description: 'Add deterministic Company and Fund subtype records without guessing holder or issuer identity.',
    risk: 'metadata_change', plannerExposure: false,
    inputSchema: schema({}),
    resolve: () => ({ type: 'workspace_identity', id: 'local', label: 'Workspace identity model' }),
    inspect: async () => (await query(`
      SELECT
        (SELECT COUNT(*)::int FROM portfolio_entities) AS entities,
        (SELECT COUNT(*)::int FROM companies) AS companies,
        (SELECT COUNT(*)::int FROM investing_entities) AS investing_entities
    `))[0],
    preview: ({ target, current }) => preview('Prepare deterministic canonical identity subtypes.', target, current, { operation: 'deterministic_backfill' }),
    preconditions: ({ current }) => current,
    apply: () => backfillCanonicalEntitySubtypes({ reviewedBy: 'local_user' }),
    affectedResources: ({ target }) => [target],
  }),
  base({
    name: 'identity.create', title: 'Create canonical Entity',
    description: 'Create one reviewed Company or Investing Entity with a stable source identity.',
    risk: 'metadata_change',
    editableInputKeys: ['legalName', 'displayName', 'legalForm', 'jurisdiction', 'website', 'description'],
    inputSchema: schema({
      legalName: { type: 'string', minLength: 1 },
      displayName: nullableText,
      entityType: { type: 'string', enum: ['operating_company', 'fund_vehicle', 'other'] },
      entityClass: { type: 'string', enum: ['person', 'organization', 'vehicle', 'other'] },
      company: { type: 'boolean' },
      investingEntityKind: { anyOf: [{ type: 'string', enum: ['individual', 'household', 'llc', 'trust', 'spv', 'fund_vehicle', 'other'] }, { type: 'null' }] },
      sourceNamespace: { type: 'string', minLength: 1 },
      sourceId: { type: 'string', minLength: 1 },
      sourceHash: { type: 'string', minLength: 1 },
      idempotencyKey: { type: 'string', minLength: 1 },
      legalForm: nullableText,
      jurisdiction: nullableText,
      website: nullableText,
      description: nullableText,
    }, ['legalName', 'entityType', 'entityClass', 'company', 'sourceNamespace', 'sourceId', 'sourceHash', 'idempotencyKey']),
    resolve: input => ({ type: 'entity_source', id: `${input.sourceNamespace}:${input.sourceId}`, label: input.legalName }),
    inspect: async (_target, input) => (await query(`SELECT entity_id FROM entity_aliases WHERE source_namespace = $1 AND source_id = $2`, [input.sourceNamespace, input.sourceId]))[0] || null,
    preview: ({ target, input, current }) => preview(`Create reviewed Entity ${input.legalName}.`, target, current, { entity_type: input.entityType, investing_entity_kind: input.investingEntityKind }),
    preconditions: ({ current }) => current,
    apply: ({ input }) => createReviewedEntity({ ...input, reviewedBy: 'local_user' }),
    affectedResources: ({ result }) => [{ type: 'entity', id: result.entity.id, label: result.entity.display_name || result.entity.legal_name }],
  }),
  base({
    name: 'identity.link_position', title: 'Confirm Position identity',
    description: 'Confirm the canonical holder, immediate legal issuer, and Direct or vehicle route for one Position.',
    risk: 'metadata_change',
    editableInputKeys: ['holderEntityId', 'issuerEntityId', 'routeClassification'],
    inputSchema: schema({
      investmentId: { type: 'integer', minimum: 1 },
      holderEntityId: { type: 'string', format: 'uuid' },
      issuerEntityId: { type: 'string', format: 'uuid' },
      routeClassification: { type: 'string', enum: ['direct_issuer', 'vehicle_interest'] },
      sourceHash: { type: 'string', minLength: 1 },
      idempotencyKey: { type: 'string', minLength: 1 },
    }, ['investmentId', 'holderEntityId', 'issuerEntityId', 'routeClassification', 'sourceHash', 'idempotencyKey']),
    resolve: async input => {
      const [row] = await query(`SELECT id, company_name FROM investments WHERE id = $1 AND asset_class <> 'merged'`, [input.investmentId]);
      if (!row) throw new CommandError('TARGET_NOT_FOUND', `Position not found: ${input.investmentId}`);
      return { type: 'position', id: Number(row.id), label: row.company_name };
    },
    inspect: async target => (await query(`SELECT holder_entity_id, issuer_entity_id, identity_review_status, route_classification FROM investments WHERE id = $1`, [target.id]))[0],
    preview: ({ target, input, current }) => preview(`Confirm the holder and immediate issuer for ${target.label}.`, target, current, input),
    preconditions: ({ current }) => current,
    apply: ({ target, input }) => linkPositionIdentity(target.id, { ...input, reviewedBy: 'local_user' }),
    affectedResources: ({ target }) => [target],
  }),
  base({
    name: 'identity.redirect', title: 'Redirect duplicate Entity',
    description: 'Preserve a duplicate Entity ID while redirecting canonical reads to the reviewed identity.',
    risk: 'reconciliation', applyCapabilities: ['portfolio:apply:reconciliation'],
    editableInputKeys: ['canonicalEntityId', 'reason'],
    inputSchema: schema({
      supersededEntityId: { type: 'string', format: 'uuid' },
      canonicalEntityId: { type: 'string', format: 'uuid' },
      reason: { type: 'string', minLength: 1 },
      sourceHash: { type: 'string', minLength: 1 },
      idempotencyKey: { type: 'string', minLength: 1 },
    }, ['supersededEntityId', 'canonicalEntityId', 'reason', 'sourceHash', 'idempotencyKey']),
    resolve: input => entityTarget(input.supersededEntityId),
    inspect: async target => ({
      entity: (await query(`SELECT identity_status FROM portfolio_entities WHERE id = $1`, [target.id]))[0],
      redirect: (await query(`SELECT * FROM entity_redirects WHERE superseded_entity_id = $1`, [target.id]))[0] || null,
    }),
    preview: ({ target, input, current }) => preview(`Redirect duplicate ${target.label} without deleting history.`, target, current, { canonical_entity_id: input.canonicalEntityId, reason: input.reason }),
    preconditions: ({ current }) => current,
    apply: ({ input }) => createEntityRedirect({ ...input, reviewedBy: 'local_user' }),
    affectedResources: ({ target, input }) => [target, { type: 'entity', id: input.canonicalEntityId, label: 'Canonical Entity' }],
  }),
  base({
    name: 'identity.resolve_exposure', title: 'Resolve reported Fund holding',
    description: 'Link one raw Fund or SPV holding claim to a reviewed canonical Company.',
    risk: 'metadata_change',
    editableInputKeys: ['targetEntityId'],
    inputSchema: schema({
      claimId: { type: 'string', format: 'uuid' },
      targetEntityId: { type: 'string', format: 'uuid' },
      sourceHash: { type: 'string', minLength: 1 },
      idempotencyKey: { type: 'string', minLength: 1 },
    }, ['claimId', 'targetEntityId', 'sourceHash', 'idempotencyKey']),
    resolve: async input => {
      const [row] = await query(`SELECT id, raw_target_name FROM vehicle_exposure_claims WHERE id = $1`, [input.claimId]);
      if (!row) throw new CommandError('TARGET_NOT_FOUND', `Exposure claim not found: ${input.claimId}`);
      return { type: 'vehicle_exposure', id: row.id, label: row.raw_target_name };
    },
    inspect: async target => (await query(`SELECT target_entity_id, resolution_status, updated_at FROM vehicle_exposure_claims WHERE id = $1`, [target.id]))[0],
    preview: ({ target, input, current }) => preview(`Link reported holding ${target.label} to a canonical Company.`, target, current, { target_entity_id: input.targetEntityId, resolution_status: 'confirmed' }),
    preconditions: ({ current }) => current,
    apply: ({ target, input }) => resolveVehicleExposureClaim(target.id, { ...input, resolutionStatus: 'confirmed', reviewedBy: 'local_user' }),
    affectedResources: ({ target, input }) => [target, { type: 'entity', id: input.targetEntityId, label: 'Canonical Company' }],
  }),
  base({
    name: 'fund.record_disclosure', title: 'Record Fund portfolio disclosure',
    description: 'Record a sourced Fund or SPV disclosure and its raw Company names without changing Position economics.',
    risk: 'additive_reporting_fact', applyCapabilities: ['portfolio:apply:additive'],
    editableInputKeys: ['asOfDate', 'receivedDate', 'disclosurePresence', 'holdingsCompleteness', 'reportedTotalPortfolioValue', 'claims'],
    inputSchema: schema({
      vehicleEntityId: { type: 'string', format: 'uuid' },
      sourceReceiptNamespace: { type: 'string', minLength: 1 },
      sourceReceiptId: { type: 'string', minLength: 1 },
      boundaryKind: { type: 'string', minLength: 1 },
      boundaryLocator: { type: 'string', minLength: 1 },
      sourceHash: { type: 'string', minLength: 1 },
      asOfDate: nullableDate,
      receivedDate: { type: 'string', format: 'date' },
      disclosurePresence: { type: 'string', enum: ['not_provided', 'explicitly_none', 'provided'] },
      holdingsCompleteness: { anyOf: [{ type: 'string', enum: ['partial', 'complete', 'unknown'] }, { type: 'null' }] },
      extractionStatus: { type: 'string', enum: ['not_attempted', 'succeeded', 'failed', 'needs_review'] },
      reportedHoldingCount: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
      reportedTotalPortfolioValue: nullableMoney,
      reportedValueCurrency: nullableText,
      reportedValueUnitScale: nullableText,
      reportedValueBasis: nullableText,
      reportedValueEffectiveDate: nullableDate,
      claims: { type: 'array', items: schema({
        sourceClaimId: { type: 'string', minLength: 1 },
        rawTargetName: { type: 'string', minLength: 1 },
        holdingStatus: { type: 'string', enum: ['active', 'realized', 'unknown'] },
        sourceCitation: nullableText,
        confidence: { type: 'string', enum: ['confirmed', 'reported', 'calculated', 'estimated', 'unknown'] },
      }, ['sourceClaimId', 'rawTargetName', 'holdingStatus', 'confidence']) },
    }, ['vehicleEntityId', 'sourceReceiptNamespace', 'sourceReceiptId', 'boundaryKind', 'boundaryLocator', 'sourceHash', 'receivedDate', 'disclosurePresence', 'extractionStatus', 'claims']),
    resolve: input => entityTarget(input.vehicleEntityId),
    inspect: async target => ({ snapshot_count: Number((await query(`SELECT COUNT(*)::int AS count FROM vehicle_portfolio_snapshots WHERE vehicle_entity_id = $1`, [target.id]))[0]?.count || 0) }),
    preview: ({ target, input, current }) => preview(`Record a portfolio disclosure for ${target.label}.`, target, current, { disclosure_presence: input.disclosurePresence, reported_holding_count: input.reportedHoldingCount }, ['Informational only; does not change Fund NAV or portfolio totals.']),
    preconditions: ({ current }) => current,
    apply: ({ input }) => recordVehiclePortfolioDisclosure({
      ...input,
      confidentiality: 'confidential_company',
      processingPolicy: 'local_only',
      syncPolicy: 'encrypted_backup_allowed',
      reviewedBy: 'local_user',
    }),
    affectedResources: ({ target, result }) => [target, { type: 'vehicle_portfolio_snapshot', id: result.snapshot.id, label: target.label }],
  }),
];
