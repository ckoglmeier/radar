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
import { ensureOpportunityIssuer, inspectLinkTarget, linkConfirmedGrant, validateLinkInput } from '../models/earned-equity-grant-links.js';
import {
  OFFER_ENTITY_TYPE, OFFER_STAGING_TYPE, OfferDocumentError, analyzeOfferDocument, attachOfferDocumentFromPending, confirmDocumentReview, getDocumentReview,
  listDocumentReviews, recordDocumentReview, rejectDocumentReview, setOfferDocumentModelConsent,
} from '../models/earned-equity-documents.js';
import {
  EarnedEquityReviewError, beginCompanyReview, beginOfferReview, findCompanyReviewByRunKey, findOfferReviewByRunKey,
} from '../models/earned-equity-reviews.js';
import { normalize } from '../utils/company-names.js';
import { CommandError } from './errors.js';

// Previews carry identifiers, states and counts only. Compensation terms,
// scenario inputs and rationale text never appear in previews or errors.

const objectResult = { type: 'object', additionalProperties: true };
const text = { type: 'string', minLength: 1 };
const payloadObject = { type: 'object', additionalProperties: true };
const nullableUuid = { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] };
const nullableText = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const sha256Text = { type: 'string', pattern: '^[0-9a-f]{64}$' };
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

const isDomainError = error => error instanceof EarnedEquityError || error instanceof OfferDocumentError || error instanceof EarnedEquityReviewError;

function wrap(fn) {
  try {
    return fn();
  } catch (error) {
    if (isDomainError(error)) throw new CommandError(`EARNED_EQUITY_${error.code.toUpperCase()}`, error.message, error.details);
    throw error;
  }
}

async function apply(fn) {
  try {
    return await fn();
  } catch (error) {
    if (isDomainError(error)) throw new CommandError(`EARNED_EQUITY_${error.code.toUpperCase()}`, error.message, error.details);
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
    inputSchema: schema({ payload: payloadObject, confirmsDocumentReviewIds: { type: 'array', items: text, maxItems: 20 } }, ['payload']),
    resolve: input => opportunityTarget(String(input.payload.opportunityId || '')),
    inspect: async (target, input) => {
      await existingOpportunity(target);
      const ids = input.confirmsDocumentReviewIds || [];
      const reviews = ids.length ? await query('SELECT id, opportunity_id, status FROM earned_equity_document_reviews WHERE id = ANY($1::text[])', [ids]) : [];
      return { headRevisionId: await headRevisionId(target.id), reviews: reviews.map(row => ({ id: row.id, opportunityId: row.opportunity_id, status: row.status })) };
    },
    preview: ({ target, input, current }) => {
      wrap(() => validateOfferRevisionPayload(input.payload));
      if ((input.payload.supersedesRevisionId ?? null) !== current.headRevisionId) {
        throw new CommandError('EARNED_EQUITY_STALE_REVISION', 'The offer changed since it was reviewed; supersede the current head revision.');
      }
      const confirms = input.confirmsDocumentReviewIds || [];
      if (new Set(confirms).size !== confirms.length) throw new CommandError('EARNED_EQUITY_INVALID_INPUT', 'A document review is listed twice.');
      for (const id of confirms) {
        const review = current.reviews.find(row => row.id === id);
        if (!review) throw new CommandError('TARGET_NOT_FOUND', 'A document review to confirm was not found.');
        if (review.opportunityId !== target.id) throw new CommandError('EARNED_EQUITY_INVALID_INPUT', 'A document review belongs to a different opportunity.');
        if (review.status !== 'proposed') throw new CommandError('EARNED_EQUITY_INVALID_TRANSITION', `A ${review.status} document review cannot be confirmed.`);
      }
      return { summary: `Add ${input.payload.status} offer revision ${input.payload.id} for ${target.id}.`, target,
        before: [{ field: 'head_revision', value: current.headRevisionId }],
        after: [{ field: 'head_revision', value: input.payload.id }, { field: 'as_of_date', value: input.payload.asOfDate },
          { field: 'grant_components', value: input.payload.grants.length },
          ...(confirms.length ? [{ field: 'document_reviews_confirmed', value: confirms.length }] : [])],
        derivedEffects: [{ field: 'earlier_snapshots_stale', value: current.headRevisionId !== null }], warnings: [], requiredReason: false };
    },
    preconditions: ({ current }) => current,
    // Revision and review confirmations share one atomic apply: any violation writes nothing.
    apply: ({ input }) => apply(async () => {
      const confirms = input.confirmsDocumentReviewIds || [];
      if (new Set(confirms).size !== confirms.length) throw new EarnedEquityError('invalid_payload', 'A document review is listed twice.');
      const revision = await addOfferRevision(input.payload);
      const confirmed = [];
      for (const id of confirms) {
        const review = await getDocumentReview(id);
        if (!review || review.opportunityId !== input.payload.opportunityId) throw new OfferDocumentError('invalid_input', 'A document review does not belong to this opportunity.');
        confirmed.push((await confirmDocumentReview({ id, offerRevisionId: revision.id })).id);
      }
      return { revision, confirmedReviewIds: confirmed };
    }),
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
    name: 'earned_equity.link_confirmed_grant', title: 'Create Earned Equity holding from confirmed grant',
    description: 'After the user confirms a board-approved ISO or NSO grant, create the Earned Equity position (or add the grant to an existing one). Acceptance alone never creates holdings; vested units are exactly what the user confirms.',
    // Classified like employment.create_position (metadata_change) but always confirmed: it creates a real holding.
    risk: 'metadata_change', interactionPolicy: 'confirm_inline', applyCapabilities: ['portfolio:apply:metadata'],
    editableInputKeys: [],
    inputSchema: schema({
      decisionId: text, offerRevisionId: text, componentId: text,
      existingInvestmentId: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
      legalName: nullableText, confirmed: payloadObject,
    }, ['decisionId', 'offerRevisionId', 'componentId', 'confirmed']),
    resolve: async input => {
      const [row] = await query('SELECT id FROM earned_equity_offer_revisions WHERE id = $1', [input.offerRevisionId]);
      if (!row) throw new CommandError('TARGET_NOT_FOUND', `Offer revision not found: ${input.offerRevisionId}`);
      return { type: 'earned_equity_offer_revision', id: row.id, label: `${row.id} / ${input.componentId}` };
    },
    inspect: (target, input) => inspectLinkTarget({ ...input, offerRevisionId: target.id, existingInvestmentId: input.existingInvestmentId ?? null }),
    preview: ({ target, input, current }) => {
      const confirmed = wrap(() => validateLinkInput(input));
      if (current.existingLinkId) {
        return { summary: `Grant ${input.componentId} is already linked to position ${current.existingInvestmentId}; nothing new will be created.`, target,
          before: [{ field: 'linked_position', value: current.existingInvestmentId }], after: [],
          derivedEffects: [], warnings: ['This confirmation was already applied.'], requiredReason: false };
      }
      if (!current.componentExists) throw new CommandError('EARNED_EQUITY_NOT_FOUND', `Grant component not found in the offer revision: ${input.componentId}`);
      if (current.latestDecisionId !== input.decisionId) throw new CommandError('EARNED_EQUITY_DECISION_SUPERSEDED', 'This is not the latest decision for the group.');
      if (!current.decisionSelectsRevision) throw new CommandError('EARNED_EQUITY_DECISION_NOT_SELECTED', 'The latest decision does not select this offer revision.');
      const adding = input.existingInvestmentId != null;
      return { summary: adding
          ? `Add a confirmed ${confirmed.instrumentType.toUpperCase()} grant to Earned Equity position ${input.existingInvestmentId}.`
          : `Create an Earned Equity position with a confirmed ${confirmed.instrumentType.toUpperCase()} grant.`, target,
        before: [], after: [
          { field: 'holding', value: adding ? 'grant added to existing position' : 'new position' },
          { field: 'instrument', value: confirmed.instrumentType },
          { field: 'units_granted', value: confirmed.unitsGranted },
          { field: 'units_vested_confirmed', value: confirmed.unitsVestedConfirmed },
          { field: 'balance_as_of', value: confirmed.balanceAsOfDate },
        ],
        derivedEffects: current.hasIssuer || adding ? [] : [{ field: 'company_created_and_linked', value: true }],
        warnings: ['Vested units are recorded exactly as confirmed; Radar does not calculate vesting.'], requiredReason: false };
    },
    preconditions: ({ current }) => current,
    apply: ({ input }) => apply(() => linkConfirmedGrant(input)),
    affectedResources: ({ target, result }) => [target, ...(result?.link ? [{ type: 'employment_equity_position', id: result.link.investmentId, label: String(result.link.investmentId) }] : [])],
  }),
  base({
    name: 'earned_equity.attach_offer_document', title: 'Attach offer document',
    description: 'Attach a locally staged document to an opportunity as personal_sensitive, local-only. The command carries the staged id only; bytes, names and text never enter the command record.',
    risk: 'sensitive_basis', applyCapabilities: ['portfolio:apply:metadata'],
    editableInputKeys: [],
    inputSchema: schema({ opportunityId: text, previewId: { type: 'string', format: 'uuid' } }, ['opportunityId', 'previewId']),
    resolve: async input => {
      if (!(await getOpportunityRow(input.opportunityId))) throw new CommandError('TARGET_NOT_FOUND', `Opportunity not found: ${input.opportunityId}`);
      return opportunityTarget(input.opportunityId);
    },
    inspect: async (target, input) => {
      const [row] = await query(`SELECT status, sha256, size_bytes, preview, expires_at FROM pending_intake WHERE id = $1 AND expires_at > NOW()`, [input.previewId]);
      if (!row || row.preview?.type !== OFFER_STAGING_TYPE) throw new CommandError('TARGET_NOT_FOUND', 'The staged upload is missing or expired.');
      const [dup] = await query(`SELECT COUNT(*)::int AS n FROM documents WHERE entity_type = $1 AND entity_id = $2::text AND sha256 = $3`,
        [OFFER_ENTITY_TYPE, target.id, row.sha256]);
      return { status: row.status, sha256: row.sha256, size_bytes: Number(row.size_bytes), expires_at: row.expires_at, duplicate: dup.n > 0 };
    },
    preview: ({ target, current }) => ({
      summary: `Attach a staged document to opportunity ${target.id}.`, target,
      before: [{ field: 'staged_size_bytes', value: current.size_bytes }],
      after: [{ field: 'confidentiality', value: 'personal_sensitive' }, { field: 'processing_policy', value: 'local_only' }],
      derivedEffects: ['The original bytes stay on this device and are excluded from the command transcript.'],
      warnings: current.duplicate && current.status !== 'committed' ? ['A document with identical content is already attached to this opportunity.'] : [], requiredReason: false,
    }),
    preconditions: ({ current }) => ({ status: current.status, sha256: current.sha256, expires_at: current.expires_at }),
    apply: ({ target, input }) => apply(async () => {
      const done = await attachOfferDocumentFromPending({ previewId: input.previewId, opportunityId: target.id });
      const d = done.document;
      return { document: { id: Number(d.id), sha256: d.sha256, sizeBytes: Number(d.size_bytes), confidentiality: d.confidentiality,
        processingPolicy: d.processing_policy, syncPolicy: d.sync_policy }, idempotentReplay: done.idempotent_replay };
    }),
    affectedResources: ({ target, result }) => [target, { type: 'earned_equity_offer_document', id: result.document.id, label: 'Offer document' }],
  }),
  base({
    name: 'earned_equity.set_document_consent', title: 'Set offer document AI consent',
    description: 'Allow or withdraw permission for an offer document\'s text to be sent to the AI provider. Allowing always needs explicit confirmation.',
    risk: 'sensitive_basis', interactionPolicy: 'confirm_inline',
    interactionPolicyForInput: input => (input.allowed ? 'confirm_inline' : 'execute_inline'),
    applyCapabilities: ['portfolio:apply:metadata'],
    editableInputKeys: [],
    inputSchema: schema({ documentId: { type: 'integer', minimum: 1 }, allowed: { type: 'boolean' } }, ['documentId', 'allowed']),
    resolve: async input => {
      const [row] = await query('SELECT id FROM documents WHERE id = $1 AND entity_type = $2', [input.documentId, OFFER_ENTITY_TYPE]);
      if (!row) throw new CommandError('TARGET_NOT_FOUND', 'Offer document not found.');
      return { type: 'earned_equity_offer_document', id: Number(row.id), label: 'Offer document' };
    },
    inspect: async target => ({ processing_policy: (await query('SELECT processing_policy FROM documents WHERE id = $1', [target.id]))[0].processing_policy }),
    preview: ({ target, input, current }) => {
      const after = input.allowed ? 'model_allowed' : 'local_only';
      return { summary: input.allowed ? 'Allow this offer document to be sent to your AI provider.' : 'Keep this offer document on this device only.', target,
        before: [{ field: 'processing_policy', value: current.processing_policy }], after: [{ field: 'processing_policy', value: after }],
        derivedEffects: [], warnings: input.allowed ? ['The document text may be sent to your AI provider for review.']
          : current.processing_policy === after ? ['No change: this document is already local-only.'] : [], requiredReason: false };
    },
    preconditions: ({ current }) => current,
    // The command framework supplies the explicit confirmation; the model still demands the flag.
    apply: ({ target, input }) => apply(async () => {
      const row = await setOfferDocumentModelConsent({ documentId: target.id, allowed: input.allowed, userConfirmed: true });
      return { document: { id: Number(row.id), processingPolicy: row.processing_policy } };
    }),
    affectedResources: ({ target }) => [target],
  }),
  base({
    name: 'earned_equity.record_document_review', title: 'Review offer document',
    description: 'Run the deterministic, on-device review of an attached offer document and record the proposal. Proposal text stays in the database and is not returned in the receipt.',
    risk: 'additive_reporting_fact',
    editableInputKeys: [],
    inputSchema: schema({ opportunityId: text, documentId: { type: 'integer', minimum: 1 } }, ['opportunityId', 'documentId']),
    resolve: async input => {
      const [row] = await query('SELECT id, entity_id FROM documents WHERE id = $1 AND entity_type = $2', [input.documentId, OFFER_ENTITY_TYPE]);
      if (!row || row.entity_id !== input.opportunityId) throw new CommandError('TARGET_NOT_FOUND', 'The document is not attached to this opportunity.');
      return { type: 'earned_equity_offer_document', id: Number(row.id), label: 'Offer document' };
    },
    inspect: async (target, input) => ({
      sha256: (await query('SELECT sha256 FROM documents WHERE id = $1', [target.id]))[0].sha256,
      proposed_reviews: (await listDocumentReviews(input.opportunityId, { documentId: target.id, status: 'proposed' })).length,
    }),
    preview: ({ target, current }) => ({
      summary: 'Review the attached offer document on this device and record a proposal for confirmation.', target,
      before: [{ field: 'open_proposals', value: current.proposed_reviews }], after: [{ field: 'review', value: 'proposed' }],
      derivedEffects: ['Nothing becomes an offer term until you confirm it.'],
      warnings: current.proposed_reviews > 0 ? ['An unconfirmed proposal from this document exists; an identical review is reused.'] : [], requiredReason: false,
    }),
    preconditions: ({ current }) => current,
    apply: ({ target, input }) => apply(async () => {
      const { proposal } = await analyzeOfferDocument({ documentId: target.id });
      const same = (await listDocumentReviews(input.opportunityId, { documentId: target.id, status: 'proposed' }))
        .find(review => review.documentSha256 === proposal.documentSha256 && review.extractionVersion === proposal.extractionVersion);
      const review = same || await recordDocumentReview({ opportunityId: input.opportunityId, documentId: target.id, proposal });
      return { review: { id: review.id, status: review.status, docClass: review.docClass }, reused: Boolean(same) };
    }),
    affectedResources: ({ target, result }) => [target, { type: 'earned_equity_document_review', id: result.review.id, label: 'Document review' }],
  }),
  base({
    name: 'earned_equity.reject_document_review', title: 'Reject offer document review',
    description: 'Mark an unconfirmed document-review proposal as rejected.',
    risk: 'metadata_change', applyCapabilities: ['portfolio:apply:metadata'],
    editableInputKeys: [],
    inputSchema: schema({ reviewId: text }, ['reviewId']),
    resolve: async input => {
      if (!(await getDocumentReview(input.reviewId))) throw new CommandError('TARGET_NOT_FOUND', 'Document review not found.');
      return { type: 'earned_equity_document_review', id: input.reviewId, label: 'Document review' };
    },
    inspect: async target => ({ status: (await getDocumentReview(target.id)).status }),
    preview: ({ target, current }) => {
      if (current.status !== 'proposed') throw new CommandError('PRECONDITION_FAILED', `A ${current.status} review cannot be rejected.`);
      return { summary: 'Reject this document review proposal.', target, before: [{ field: 'status', value: current.status }],
        after: [{ field: 'status', value: 'rejected' }], derivedEffects: [], warnings: [], requiredReason: false };
    },
    preconditions: ({ current }) => current,
    apply: ({ target }) => apply(async () => {
      const review = await rejectDocumentReview(target.id);
      return { review: { id: review.id, status: review.status } };
    }),
    affectedResources: ({ target }) => [target],
  }),
  base({
    name: 'earned_equity.start_company_review', title: 'Start Earned Equity company review',
    description: 'Claim (or reuse) a company review for an opportunity, creating or linking its company when it has none. Execution of the review is a separate worker write; the claim carries hashes only, never company text or offer terms.',
    risk: 'lifecycle', applyCapabilities: ['portfolio:apply:metadata'],
    editableInputKeys: [],
    inputSchema: schema({
      opportunityId: text, reviewKind: { type: 'string', enum: ['initial', 'refresh', 'followup'] }, parentReviewId: nullableText,
      lensId: text, lensVersion: { anyOf: [{ type: 'integer', minimum: 0 }, text] }, policyVersion: { anyOf: [{ type: 'integer', minimum: 0 }, text] },
      instructionHash: sha256Text, sourceManifestHash: sha256Text, runKey: sha256Text,
      legalName: nullableText, portfolioEntityId: nullableUuid,
    }, ['opportunityId', 'lensId', 'lensVersion', 'policyVersion', 'instructionHash', 'sourceManifestHash', 'runKey']),
    resolve: input => existingOpportunity(opportunityTarget(input.opportunityId)).then(() => opportunityTarget(input.opportunityId)),
    inspect: async (target, input) => {
      const opportunity = await getOpportunityRow(target.id);
      const existing = await findCompanyReviewByRunKey(input.runKey);
      const nameClash = !opportunity.portfolioEntityId && !input.portfolioEntityId && typeof input.legalName === 'string' && input.legalName.trim()
        ? (await query(`SELECT id FROM portfolio_entities WHERE entity_type = 'operating_company' AND normalized_name = $1`, [normalize(input.legalName.trim())]))[0]?.id ?? null : null;
      const entityId = opportunity.portfolioEntityId || input.portfolioEntityId || null;
      const active = entityId
        ? (await query(`SELECT id, run_key FROM earned_equity_company_reviews WHERE portfolio_entity_id = $1 AND status = 'running'`, [entityId]))[0] ?? null : null;
      return { entityId: opportunity.portfolioEntityId ?? null, revision: opportunity.revision, existingStatus: existing?.status ?? null,
        nameClash, otherRunning: Boolean(active && active.run_key !== input.runKey) };
    },
    preview: ({ target, input, current }) => {
      const kind = input.reviewKind || 'initial';
      if ((kind === 'followup') !== Boolean(input.parentReviewId)) throw new CommandError('EARNED_EQUITY_INVALID_INPUT', 'Only a follow-up review has a parent, and a follow-up requires one.');
      if (current.entityId && input.portfolioEntityId && input.portfolioEntityId !== current.entityId) {
        throw new CommandError('EARNED_EQUITY_ENTITY_MISMATCH', 'The opportunity is already linked to a different company.');
      }
      if (!current.entityId && !input.portfolioEntityId && !(typeof input.legalName === 'string' && input.legalName.trim())) {
        throw new CommandError('EARNED_EQUITY_LEGAL_NAME_REQUIRED', 'The opportunity has no company yet; provide its legal name or an existing company.');
      }
      if (current.nameClash) throw new CommandError('EARNED_EQUITY_ISSUER_EXISTS', 'A company with this name already exists; link the opportunity to it instead.');
      if (current.otherRunning) throw new CommandError('EARNED_EQUITY_REVIEW_IN_PROGRESS', 'Another review of this company is already running.');
      const state = current.existingStatus === 'completed' ? 'reused' : current.existingStatus === 'running' ? 'running' : 'queued';
      return { summary: `Claim a ${kind} company review for opportunity ${target.id}.`, target,
        before: [{ field: 'review', value: current.existingStatus }], after: [{ field: 'review_state', value: state }],
        derivedEffects: current.entityId ? [] : [{ field: input.portfolioEntityId ? 'company_linked' : 'company_created_and_linked', value: true }],
        warnings: state === 'reused' ? ['A completed review with the same inputs exists and is reused; nothing is rerun.'] : [], requiredReason: false };
    },
    preconditions: ({ current }) => current,
    apply: ({ target, input }) => apply(async () => {
      const [row] = await query('SELECT * FROM earned_equity_opportunities WHERE id = $1 FOR UPDATE', [target.id]);
      const resolved = await ensureOpportunityIssuer(row, { legalName: input.legalName ?? null, portfolioEntityId: input.portfolioEntityId ?? null });
      const claim = await beginCompanyReview({
        portfolioEntityId: resolved.entityId, reviewKind: input.reviewKind || 'initial', parentReviewId: input.parentReviewId || null,
        lensId: input.lensId, lensVersion: input.lensVersion, policyVersion: input.policyVersion,
        instructionHash: input.instructionHash, sourceManifestHash: input.sourceManifestHash, runKey: input.runKey,
      });
      return { state: claim.state, review: { id: claim.review.id, status: claim.review.status, stage: claim.review.stage, reviewKind: claim.review.reviewKind },
        portfolioEntityId: resolved.entityId, issuerCreated: resolved.issuerCreated, linkedExisting: resolved.linkedExisting };
    }),
    affectedResources: ({ target, result }) => [target, { type: 'earned_equity_company_review', id: result.review.id, label: 'Company review' }],
  }),
  base({
    name: 'earned_equity.request_offer_memo', title: 'Request Earned Equity offer memo',
    description: 'Claim (or reuse) the offer-review row for an offer revision. Execution of the memo is a separate worker write; the claim carries ids and a run key only.',
    risk: 'lifecycle', applyCapabilities: ['portfolio:apply:metadata'],
    editableInputKeys: [],
    inputSchema: schema({
      offerRevisionId: text, reviewKind: { type: 'string', enum: ['initial', 'followup'] }, parentReviewId: nullableText,
      companyReviewId: nullableText, snapshotId: nullableText, runKey: sha256Text,
    }, ['offerRevisionId', 'runKey']),
    resolve: async input => {
      const [row] = await query('SELECT id FROM earned_equity_offer_revisions WHERE id = $1', [input.offerRevisionId]);
      if (!row) throw new CommandError('TARGET_NOT_FOUND', `Offer revision not found: ${input.offerRevisionId}`);
      return { type: 'earned_equity_offer_revision', id: row.id, label: row.id };
    },
    inspect: async (target, input) => ({ existingStatus: (await findOfferReviewByRunKey(input.runKey))?.status ?? null }),
    preview: ({ target, input, current }) => {
      const kind = input.reviewKind || 'initial';
      if ((kind === 'followup') !== Boolean(input.parentReviewId)) throw new CommandError('EARNED_EQUITY_INVALID_INPUT', 'Only a follow-up review has a parent, and a follow-up requires one.');
      const state = current.existingStatus === 'completed' ? 'reused' : current.existingStatus === 'running' ? 'running' : 'queued';
      return { summary: `Claim a ${kind} offer memo for ${target.id}.`, target, before: [{ field: 'review', value: current.existingStatus }],
        after: [{ field: 'review_state', value: state }], derivedEffects: [],
        warnings: state === 'reused' ? ['A completed memo with the same inputs exists and is reused; nothing is rerun.'] : [], requiredReason: false };
    },
    preconditions: ({ current }) => current,
    apply: ({ target, input }) => apply(async () => {
      const claim = await beginOfferReview({
        offerRevisionId: target.id, reviewKind: input.reviewKind || 'initial', parentReviewId: input.parentReviewId || null,
        companyReviewId: input.companyReviewId || null, snapshotId: input.snapshotId || null, runKey: input.runKey,
      });
      return { state: claim.state, review: { id: claim.review.id, status: claim.review.status, reviewKind: claim.review.reviewKind } };
    }),
    affectedResources: ({ target, result }) => [target, { type: 'earned_equity_offer_review', id: result.review.id, label: 'Offer review' }],
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
