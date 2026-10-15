import { query, writeCapabilities } from '../db/index.js';
import {
  EarnedEquityError,
  addOfferRevision,
  createGroup,
  createOpportunity,
  getGroupRow,
  getOpportunityRow,
  headRevisionId,
  latestDecision,
  recordAnalysisSnapshot,
  recordDecision,
  purgeEarnedEquityOpportunity,
  updateGroup,
  updateOpportunity,
  validateDecisionPayload,
  validateGroupPayload,
  validateOfferRevisionPayload,
  validateOpportunityPayload,
  validateSnapshotInput,
  checkDecisionShape,
} from '../models/earned-equity-opportunities.js';
import { CommandError } from './errors.js';

// Previews carry identifiers, states and counts only. Compensation terms,
// scenario inputs and rationale text never appear in previews or errors.

const objectResult = { type: 'object', additionalProperties: true };
const text = { type: 'string', minLength: 1 };
const payloadObject = { type: 'object', additionalProperties: true };
const nullableUuid = { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] };
const nullableText = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const nullableObject = { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] };

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

async function available() {
  const capabilities = await writeCapabilities();
  return capabilities.proposalApply === 'transactional' && capabilities.serializedWrites;
}

function base(definition) {
  return {
    version: 1, tier: 'A', domainAtomicity: 'multi_statement',
    proposeCapabilities: ['portfolio:propose'],
    applyCapabilities: ['portfolio:apply:additive'],
    availability: available, resultSchema: objectResult, plannerExposure: false,
    interactionPolicy: 'execute_inline', undoPolicy: 'unavailable',
    ...definition,
  };
}

function wrap(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof EarnedEquityError) throw new CommandError(`EARNED_EQUITY_${error.code.toUpperCase()}`, error.message, error.details);
    throw error;
  }
}

async function apply(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof EarnedEquityError) throw new CommandError(`EARNED_EQUITY_${error.code.toUpperCase()}`, error.message, error.details);
    throw error;
  }
}

const groupTarget = (id, label = id) => ({ type: 'earned_equity_group', id, label });
const opportunityTarget = (id, label = id) => ({ type: 'earned_equity_opportunity', id, label });

async function existingGroup(target) {
  const group = await getGroupRow(target.id);
  if (!group) throw new CommandError('TARGET_NOT_FOUND', `Decision group not found: ${target.id}`);
  return group;
}

async function existingOpportunity(target) {
  const row = await getOpportunityRow(target.id);
  if (!row) throw new CommandError('TARGET_NOT_FOUND', `Opportunity not found: ${target.id}`);
  return row;
}

export const earnedEquityCommandDefinitions = [
  base({
    name: 'earned_equity.create_group', title: 'Create Earned Equity decision group',
    description: 'Create a decision group for comparing prospective employment or advisory offers.',
    risk: 'metadata_change', applyCapabilities: ['portfolio:apply:metadata'],
    editableInputKeys: ['payload'],
    inputSchema: schema({ payload: payloadObject }, ['payload']),
    resolve: input => groupTarget(String(input.payload.id || '')),
    inspect: async target => ({ existing: (await getGroupRow(target.id)) ? true : false }),
    preview: ({ target, input, current }) => {
      wrap(() => validateGroupPayload(input.payload));
      if (current.existing) throw new CommandError('TARGET_ALREADY_EXISTS', `Decision group already exists: ${target.id}`);
      return { summary: `Create ${input.payload.mode} decision group ${target.id}.`, target, before: [],
        after: [{ field: 'mode', value: input.payload.mode }, { field: 'status', value: input.payload.status }],
        derivedEffects: [], warnings: [], requiredReason: false };
    },
    preconditions: ({ current }) => current,
    apply: ({ input }) => apply(async () => ({ group: await createGroup(input.payload) })),
    affectedResources: ({ target }) => [target],
  }),
  base({
    name: 'earned_equity.update_group', title: 'Update Earned Equity decision group',
    description: 'Replace a decision group configuration, guarded by its expected revision.',
    risk: 'metadata_change', applyCapabilities: ['portfolio:apply:metadata'],
    editableInputKeys: ['payload'],
    inputSchema: schema({ groupId: text, expectedRevision: { type: 'integer', minimum: 1 }, payload: payloadObject },
      ['groupId', 'expectedRevision', 'payload']),
    resolve: input => groupTarget(input.groupId),
    inspect: async target => ({ revision: (await existingGroup(target)).revision }),
    preview: ({ target, input, current }) => {
      wrap(() => validateGroupPayload(input.payload));
      if (input.payload.id !== target.id) throw new CommandError('EARNED_EQUITY_INVALID_PAYLOAD', 'Decision group id cannot change.');
      if (current.revision !== input.expectedRevision) {
        throw new CommandError('EARNED_EQUITY_STALE_REVISION', `Decision group is at revision ${current.revision}, not ${input.expectedRevision}.`);
      }
      return { summary: `Update decision group ${target.id}.`, target,
        before: [{ field: 'revision', value: current.revision }], after: [{ field: 'revision', value: current.revision + 1 }, { field: 'status', value: input.payload.status }],
        derivedEffects: [], warnings: [], requiredReason: false };
    },
    preconditions: ({ current }) => current,
    apply: ({ target, input }) => apply(async () => ({ group: await updateGroup(target.id, input.expectedRevision, input.payload) })),
    affectedResources: ({ target }) => [target],
  }),
  base({
    name: 'earned_equity.create_opportunity', title: 'Create Earned Equity opportunity',
    description: 'Add a prospective opportunity to a decision group. Personal terms are never written to company records.',
    risk: 'metadata_change', applyCapabilities: ['portfolio:apply:metadata'],
    editableInputKeys: ['payload'],
    inputSchema: schema({ payload: payloadObject, portfolioEntityId: nullableUuid }, ['payload']),
    resolve: input => opportunityTarget(String(input.payload.id || '')),
    inspect: async (target, input) => ({
      existing: (await getOpportunityRow(target.id)) ? true : false,
      group: (await getGroupRow(String(input.payload.groupId || '')))?.revision ?? null,
    }),
    preview: ({ target, input, current }) => {
      wrap(() => validateOpportunityPayload(input.payload, input.portfolioEntityId));
      if (current.existing) throw new CommandError('TARGET_ALREADY_EXISTS', `Opportunity already exists: ${target.id}`);
      if (current.group === null) throw new CommandError('TARGET_NOT_FOUND', `Decision group not found: ${input.payload.groupId}`);
      return { summary: `Add ${input.payload.relationship} opportunity ${target.id} to group ${input.payload.groupId}.`, target, before: [],
        after: [{ field: 'relationship', value: input.payload.relationship }, { field: 'lifecycle', value: input.payload.lifecycle }],
        derivedEffects: [], warnings: [], requiredReason: false };
    },
    preconditions: ({ current }) => current,
    apply: ({ input }) => apply(async () => ({ opportunity: await createOpportunity(input.payload, input.portfolioEntityId) })),
    affectedResources: ({ target }) => [target],
  }),
  base({
    name: 'earned_equity.update_opportunity', title: 'Update Earned Equity opportunity',
    description: 'Update an opportunity lifecycle or metadata.',
    risk: 'metadata_change', applyCapabilities: ['portfolio:apply:metadata'],
    editableInputKeys: ['payload'],
    inputSchema: schema({ opportunityId: text, expectedRevision: { type: 'integer', minimum: 1 }, payload: payloadObject, portfolioEntityId: nullableUuid }, ['opportunityId', 'expectedRevision', 'payload']),
    resolve: input => opportunityTarget(input.opportunityId),
    inspect: async target => {
      const row = await existingOpportunity(target);
      return { lifecycle: row.lifecycle, revision: row.revision };
    },
    preview: ({ target, input, current }) => {
      wrap(() => validateOpportunityPayload(input.payload, input.portfolioEntityId));
      if (input.payload.id !== target.id) throw new CommandError('EARNED_EQUITY_INVALID_PAYLOAD', 'Opportunity id cannot change.');
      if (current.revision !== input.expectedRevision) {
        throw new CommandError('EARNED_EQUITY_STALE_REVISION', `Opportunity is at revision ${current.revision}, not ${input.expectedRevision}.`);
      }
      return { summary: `Update opportunity ${target.id}.`, target,
        before: [{ field: 'lifecycle', value: current.lifecycle }, { field: 'revision', value: current.revision }],
        after: [{ field: 'lifecycle', value: input.payload.lifecycle }, { field: 'revision', value: current.revision + 1 }],
        derivedEffects: [], warnings: [], requiredReason: false };
    },
    preconditions: ({ current }) => current,
    apply: ({ target, input }) => apply(async () => ({ opportunity: await updateOpportunity(target.id, input.expectedRevision, input.payload, input.portfolioEntityId) })),
    affectedResources: ({ target }) => [target],
  }),
  base({
    name: 'earned_equity.add_offer_revision', title: 'Add Earned Equity offer revision',
    description: 'Append an offer revision that supersedes the opportunity\'s current head revision.',
    risk: 'additive_reporting_fact',
    editableInputKeys: ['payload'],
    inputSchema: schema({ payload: payloadObject }, ['payload']),
    resolve: input => opportunityTarget(String(input.payload.opportunityId || '')),
    inspect: async target => {
      await existingOpportunity(target);
      return { headRevisionId: await headRevisionId(target.id) };
    },
    preview: ({ target, input, current }) => {
      wrap(() => validateOfferRevisionPayload(input.payload));
      if ((input.payload.supersedesRevisionId ?? null) !== current.headRevisionId) {
        throw new CommandError('EARNED_EQUITY_STALE_REVISION', 'The offer changed since it was reviewed; supersede the current head revision.');
      }
      return { summary: `Add ${input.payload.status} offer revision ${input.payload.id} for ${target.id}.`, target,
        before: [{ field: 'head_revision', value: current.headRevisionId }],
        after: [{ field: 'head_revision', value: input.payload.id }, { field: 'as_of_date', value: input.payload.asOfDate },
          { field: 'grant_components', value: input.payload.grants.length }],
        derivedEffects: [{ field: 'earlier_snapshots_stale', value: current.headRevisionId !== null }], warnings: [], requiredReason: false };
    },
    preconditions: ({ current }) => current,
    apply: ({ input }) => apply(async () => ({ revision: await addOfferRevision(input.payload) })),
    affectedResources: ({ target }) => [target],
  }),
  base({
    name: 'earned_equity.record_analysis_snapshot', title: 'Record Earned Equity analysis snapshot',
    description: 'Store a calculated analysis snapshot for an offer revision. Idempotent on the input hash.',
    risk: 'additive_reporting_fact',
    editableInputKeys: [],
    inputSchema: schema({
      offerRevisionId: text, scenarioSet: payloadObject, result: payloadObject, calculatorVersion: text,
      inputHash: { type: 'string', pattern: '^[0-9a-f]{64}$' }, companyAssessmentRef: nullableText, benchmark: nullableObject,
    }, ['offerRevisionId', 'scenarioSet', 'result', 'calculatorVersion', 'inputHash']),
    resolve: async input => {
      const [row] = await query('SELECT id, opportunity_id FROM earned_equity_offer_revisions WHERE id = $1', [input.offerRevisionId]);
      if (!row) throw new CommandError('TARGET_NOT_FOUND', `Offer revision not found: ${input.offerRevisionId}`);
      return { type: 'earned_equity_offer_revision', id: row.id, label: row.id };
    },
    inspect: async (target, input) => ({
      existing: (await query('SELECT id FROM earned_equity_analysis_snapshots WHERE offer_revision_id = $1 AND input_hash = $2',
        [target.id, input.inputHash]))[0]?.id ?? null,
    }),
    preview: ({ target, input, current }) => {
      wrap(() => validateSnapshotInput(input));
      return { summary: `Record analysis snapshot for ${target.id}.`, target, before: [],
        after: [{ field: 'calculator_version', value: input.calculatorVersion }, { field: 'scenario_count', value: input.scenarioSet.scenarios.length }],
        derivedEffects: [], warnings: current.existing ? ['A snapshot with this input hash already exists; nothing new will be stored.'] : [], requiredReason: false };
    },
    preconditions: ({ current }) => current,
    apply: ({ input }) => apply(() => recordAnalysisSnapshot(input)),
    affectedResources: ({ target }) => [target],
  }),
  base({
    name: 'earned_equity.record_decision', title: 'Record Earned Equity decision',
    description: 'Record a decision for a group. This never creates holdings or grants.',
    risk: 'additive_reporting_fact',
    editableInputKeys: ['payload'],
    inputSchema: schema({ payload: payloadObject }, ['payload']),
    resolve: input => groupTarget(String(input.payload.groupId || '')),
    inspect: async target => {
      await existingGroup(target);
      return { latestDecisionId: (await latestDecision(target.id))?.id ?? null };
    },
    preview: ({ target, input, current }) => {
      wrap(() => { validateDecisionPayload(input.payload); checkDecisionShape(input.payload); });
      return { summary: `Record ${input.payload.outcome} decision ${input.payload.id} for ${target.id}.`, target,
        before: [{ field: 'latest_decision', value: current.latestDecisionId }],
        after: [{ field: 'outcome', value: input.payload.outcome }, { field: 'selected_revisions', value: input.payload.selectedOfferRevisionIds.length }],
        derivedEffects: [], warnings: [], requiredReason: false };
    },
    preconditions: ({ current }) => current,
    apply: ({ input }) => apply(async () => ({ decision: await recordDecision(input.payload) })),
    affectedResources: ({ target }) => [target],
  }),
  base({
    name: 'earned_equity.purge_opportunity', title: 'Delete Earned Equity opportunity',
    description: 'Permanently delete an opportunity with its offer revisions, snapshots and any decision that references them.',
    risk: 'destructive', interactionPolicy: 'confirm_inline', applyCapabilities: ['portfolio:apply:destructive'],
    editableInputKeys: [],
    inputSchema: schema({ opportunityId: text }, ['opportunityId']),
    resolve: input => opportunityTarget(input.opportunityId),
    inspect: async target => {
      await existingOpportunity(target);
      const [counts] = await query(`
        SELECT (SELECT COUNT(*)::int FROM earned_equity_offer_revisions WHERE opportunity_id = $1) AS revisions,
               (SELECT COUNT(*)::int FROM earned_equity_analysis_snapshots s JOIN earned_equity_offer_revisions r ON r.id = s.offer_revision_id WHERE r.opportunity_id = $1) AS snapshots
      `, [target.id]);
      return counts;
    },
    preview: ({ target, current }) => ({ summary: `Permanently delete ${target.label} and its history.`, target,
      before: [{ field: 'offer_revisions', value: current.revisions }, { field: 'snapshots', value: current.snapshots }], after: [],
      derivedEffects: [], warnings: ['This cannot be undone. Decisions that select or compare these records are deleted too.'], requiredReason: false }),
    preconditions: ({ current }) => current,
    inspectAfter: async () => ({ deleted: true }),
    apply: ({ target }) => apply(async () => ({ purged: await purgeEarnedEquityOpportunity(target.id) })),
    affectedResources: ({ target }) => [target],
  }),
];
