import { query, writeCapabilities } from '../db/index.js';
import { saveAnalysisLens } from '../models/analysis-lenses.js';
import {
  buildEvaluationSnapshot,
  PersonalContextError,
  validateBusinessPreferences,
} from '../angel/personal-context.js';
import {
  attachContextRun,
  contextForDraftRevision,
  createEvaluationContext,
  createEvaluationDraft,
  createPersonalFitJob,
  currentBusinessPreferenceList,
  DEFAULT_WORKSPACE_ID,
  discardEvaluationDraft,
  getEvaluationContext,
  getEvaluationDraft,
  getPersonalFitJob,
  markEvaluationDraftSubmitted,
  retryPersonalFitJob,
  sameBusinessItems,
  saveBusinessPreferenceList,
  saveEvaluationDraft,
} from '../models/angel-evaluations.js';
import { queueCouncilRun } from '../models/council-actions.js';
import { CommandError } from './errors.js';

const objectResult = { type: 'object', additionalProperties: true };

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

async function available() {
  const capabilities = await writeCapabilities();
  return capabilities.proposalApply === 'transactional' && capabilities.serializedWrites;
}

function definition(base) {
  return {
    version: 1,
    tier: 'A',
    risk: 'metadata_change',
    domainAtomicity: 'multi_statement',
    proposeCapabilities: ['portfolio:propose'],
    applyCapabilities: ['portfolio:apply:metadata'],
    availability: available,
    resultSchema: objectResult,
    interactionPolicy: 'execute_inline',
    undoPolicy: 'unavailable',
    plannerExposure: false,
    ...base,
  };
}

// The app supplies the workspace server-side. It is never taken from a browser.
const workspaceProperty = { type: 'string', minLength: 1, maxLength: 128 };
const workspaceOf = input => input.workspaceId || DEFAULT_WORKSPACE_ID;

function personalContextProblem(error) {
  return new CommandError('PRECONDITION_FAILED', error.message, { field: error.field });
}

async function draftTarget(input) {
  const draft = await getEvaluationDraft({ workspaceId: workspaceOf(input), draftId: input.draftId });
  if (!draft) throw new CommandError('TARGET_NOT_FOUND', 'Evaluation draft not found.');
  return { type: 'angel_evaluation_draft', id: draft.id, label: draft.state?.company?.name || 'Evaluation draft' };
}

async function inspectDraft(target, input) {
  const draft = await getEvaluationDraft({ workspaceId: workspaceOf(input), draftId: target.id });
  if (!draft) throw new CommandError('TARGET_NOT_FOUND', 'Evaluation draft not found.');
  return { id: draft.id, revision: draft.revision, status: draft.status };
}

// Builds the immutable snapshot from a draft's state. Only buildEvaluationSnapshot
// produces snapshots, so every contract rule is enforced in one place.
export async function snapshotFromDraft(workspaceId, draft) {
  const state = draft.state || {};
  const company = state.company || {};
  const inviteId = Number(company.pipeline_invite_id);
  if (!Number.isSafeInteger(inviteId) || inviteId <= 0) {
    throw new CommandError('PRECONDITION_FAILED', 'Add the deal and its materials before submitting.');
  }
  const [invite] = await query('SELECT id, company_name, deal_slug FROM pipeline_invites WHERE id = $1', [inviteId]);
  if (!invite) throw new CommandError('TARGET_NOT_FOUND', `Pipeline deal not found: ${inviteId}`);
  if (!state.interests?.mode) throw new CommandError('PRECONDITION_FAILED', 'Confirm what you want to back, or choose to leave it unspecified.');
  if (!state.business?.mode) throw new CommandError('PRECONDITION_FAILED', 'Confirm how you prefer the business to work, or choose to leave it unspecified.');
  if (!state.framework?.review_mode) throw new CommandError('PRECONDITION_FAILED', 'Choose how Radar should review this deal.');
  try {
    return buildEvaluationSnapshot({
      company: {
        name: company.name || invite.company_name,
        url: company.url ?? null,
        pipeline_invite_id: inviteId,
        deal_slug: company.deal_slug || invite.deal_slug || null,
      },
      interests: { mode: state.interests.mode, items: state.interests.items || [] },
      business: { mode: state.business.mode, items: state.business.items || [], origin: state.business.origin ?? null },
      facts: state.facts,
      framework: state.framework,
    });
  } catch (error) {
    if (error instanceof PersonalContextError) throw personalContextProblem(error);
    throw error;
  }
}

async function activeRun(inviteId) {
  return (await query(`
    SELECT * FROM council_runs
     WHERE pipeline_invite_id = $1 AND status IN ('queued', 'running')
     ORDER BY started_at DESC, id DESC LIMIT 1
  `, [inviteId]))[0] || null;
}

async function submissionResult(workspaceId, context) {
  const job = await getPersonalFitJob({ workspaceId, contextId: context.id });
  const [invite] = await query('SELECT deal_slug FROM pipeline_invites WHERE id = $1', [context.pipeline_invite_id]);
  return {
    context_id: context.id,
    run_id: context.council_run_id,
    invite_id: context.pipeline_invite_id,
    slug: invite?.deal_slug || null,
    personal_fit_status: job?.status || null,
  };
}

async function submit(input) {
  const workspaceId = workspaceOf(input);
  const draft = await getEvaluationDraft({ workspaceId, draftId: input.draftId });
  if (!draft) throw new CommandError('TARGET_NOT_FOUND', 'Evaluation draft not found.');
  if (draft.status === 'discarded') throw new CommandError('PRECONDITION_FAILED', 'This evaluation draft was discarded.');
  if (draft.revision !== input.expectedRevision) {
    throw new CommandError('STALE_DRAFT', 'This draft changed somewhere else. Reload before submitting.', { current_revision: draft.revision });
  }

  // Re-submission of the same revision returns the same context and run.
  const existing = await contextForDraftRevision({ workspaceId, draftId: draft.id, draftRevision: draft.revision });
  if (existing?.council_run_id) {
    await createPersonalFitJob({ workspaceId, contextId: existing.id });
    if (draft.status !== 'submitted') await markEvaluationDraftSubmitted({ workspaceId, draftId: draft.id });
    return submissionResult(workspaceId, existing);
  }

  const { snapshot } = await snapshotFromDraft(workspaceId, draft);
  const inviteId = snapshot.company.pipeline_invite_id;
  const reviewMode = snapshot.framework.review_mode;

  // Another run on this deal that is not ours: refuse before writing anything.
  const active = await activeRun(inviteId);
  let adoptable = null;
  if (active) {
    const [claimed] = await query('SELECT id FROM angel_evaluation_contexts WHERE council_run_id = $1', [active.id]);
    const ours = existing && !claimed && active.review_mode === reviewMode
      && new Date(active.started_at) >= new Date(existing.created_at);
    if (!ours) throw new CommandError('PRECONDITION_FAILED', 'This deal already has an analysis running');
    adoptable = active;
  }

  if (draft.state.save_business_preferences === true) {
    const saved = await currentBusinessPreferenceList({ workspaceId });
    const items = validateBusinessPreferences(snapshot.business.items);
    if (!saved || !sameBusinessItems(saved.items, items)) await saveBusinessPreferenceList({ workspaceId, items });
  }

  if (draft.state.save_lens_name) {
    if (draft.state.lens_choice !== 'custom') throw new CommandError('PRECONDITION_FAILED', 'Only a custom lens can be saved from this analysis.');
    await saveAnalysisLens({ workspaceId, category: 'angel', lensId: draft.id,
      name: draft.state.save_lens_name, payload: { interests: snapshot.interests.items, business: snapshot.business.items } });
  }
  const context = existing || await createEvaluationContext({ workspaceId, draftId: draft.id, draftRevision: draft.revision, snapshot });

  let run = adoptable;
  if (!run) {
    const [canonical] = await query(`
      SELECT id FROM deal_evaluations
       WHERE pipeline_invite_id = $1 AND COALESCE(promotes_to_canonical, TRUE) LIMIT 1
    `, [inviteId]);
    const refresh = reviewMode === 'personalized' && Boolean(canonical);
    const queued = await queueCouncilRun({
      inviteId,
      reviewMode,
      runType: refresh ? 'research_refresh' : 'initial',
      fresh: refresh,
      requestNonce: context.id,
    });
    run = queued.run;
    if (!run) throw new CommandError('PRECONDITION_FAILED', 'Radar could not start the analysis for this deal.');
    if (queued.deduplicated === undefined && !['queued', 'running'].includes(run.status)) {
      throw new CommandError('PRECONDITION_FAILED', 'This deal already has an analysis running');
    }
  }

  const attached = await attachContextRun({ workspaceId, contextId: context.id, runId: run.id });
  await createPersonalFitJob({ workspaceId, contextId: context.id });
  await markEvaluationDraftSubmitted({ workspaceId, draftId: draft.id });
  return submissionResult(workspaceId, attached);
}

const draftState = { type: 'object', additionalProperties: true };

export const angelEvaluationCommandDefinitions = [
  definition({
    name: 'angel_evaluation.save_draft',
    title: 'Save evaluation draft',
    description: 'Create or update a private one-time angel evaluation draft. No research runs.',
    editableInputKeys: [],
    inputSchema: schema({
      workspaceId: workspaceProperty,
      draftId: { type: 'string', minLength: 1, maxLength: 64 },
      expectedRevision: { type: 'integer', minimum: 1 },
      inviteId: { type: 'integer', minimum: 1 },
      state: draftState,
      // A per-request nonce: proposals are idempotent by content, so two separate
      // "start a draft for this deal" requests must not replay one another.
      requestId: { type: 'string', minLength: 1, maxLength: 64 },
    }, ['state']),
    resolve: async input => {
      if (!input.draftId) return { type: 'angel_evaluation_draft', id: 'new', label: 'New evaluation draft' };
      return draftTarget(input);
    },
    inspect: async (target, input) => (target.id === 'new' ? { id: null, revision: 0, status: 'new' } : inspectDraft(target, input)),
    preview: ({ target, input, current }) => {
      if (target.id !== 'new') {
        if (!Number.isInteger(input.expectedRevision)) throw new CommandError('STALE_DRAFT', 'Saving a draft needs its current revision.');
        if (current.status !== 'draft') throw new CommandError('PRECONDITION_FAILED', `This evaluation draft was already ${current.status}.`);
        if (current.revision !== input.expectedRevision) {
          throw new CommandError('STALE_DRAFT', 'This draft changed somewhere else. Your edits are kept here; reload to merge.', { current_revision: current.revision });
        }
      }
      return {
        summary: `Save ${target.label}.`, target,
        before: [{ field: 'revision', value: current.revision }],
        after: [{ field: 'revision', value: current.revision + 1 }],
        derivedEffects: [], warnings: [], requiredReason: false,
      };
    },
    preconditions: ({ current }) => ({ revision: current.revision, status: current.status }),
    apply: async ({ input }) => {
      const workspaceId = workspaceOf(input);
      if (!input.draftId) return createEvaluationDraft({ workspaceId, inviteId: input.inviteId ?? null, state: input.state });
      return saveEvaluationDraft({ workspaceId, draftId: input.draftId, expectedRevision: input.expectedRevision, state: input.state });
    },
    affectedResources: ({ result }) => [{ type: 'angel_evaluation_draft', id: result.id }],
  }),
  definition({
    name: 'angel_evaluation.discard_draft',
    title: 'Discard evaluation draft',
    description: 'Discard a private one-time angel evaluation draft.',
    editableInputKeys: [],
    inputSchema: schema({ workspaceId: workspaceProperty, draftId: { type: 'string', minLength: 1, maxLength: 64 } }, ['draftId']),
    resolve: draftTarget,
    inspect: inspectDraft,
    preview: ({ target, current }) => {
      if (current.status === 'submitted') throw new CommandError('PRECONDITION_FAILED', 'A submitted evaluation cannot be discarded.');
      return {
        summary: `Discard ${target.label}.`, target,
        before: [{ field: 'status', value: current.status }], after: [{ field: 'status', value: 'discarded' }],
        derivedEffects: [], warnings: [], requiredReason: false,
      };
    },
    preconditions: ({ current }) => ({ status: current.status }),
    apply: ({ input }) => discardEvaluationDraft({ workspaceId: workspaceOf(input), draftId: input.draftId }),
    affectedResources: ({ target }) => [target],
  }),
  definition({
    name: 'angel_preferences.save_business',
    title: 'Save business preferences',
    description: 'Save the reusable list of how you prefer a business to work. An empty list is kept empty.',
    editableInputKeys: [],
    inputSchema: schema({
      workspaceId: workspaceProperty,
      items: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: true } },
    }, ['items']),
    resolve: async () => ({ type: 'angel_business_preferences', id: 'current', label: 'Business preferences' }),
    inspect: async (_target, input) => {
      const current = await currentBusinessPreferenceList({ workspaceId: workspaceOf(input) });
      return { version: current?.version || 0 };
    },
    preview: ({ target, input, current }) => {
      try { validateBusinessPreferences(input.items); } catch (error) {
        if (error instanceof PersonalContextError) throw personalContextProblem(error);
        throw error;
      }
      return {
        summary: input.items.length ? `Save ${input.items.length} business preference${input.items.length === 1 ? '' : 's'}.` : 'Save an empty business-preference list.',
        target, before: [{ field: 'version', value: current.version }], after: [{ field: 'version', value: current.version + 1 }],
        derivedEffects: [], warnings: [], requiredReason: false,
      };
    },
    preconditions: ({ current }) => current,
    apply: ({ input }) => saveBusinessPreferenceList({ workspaceId: workspaceOf(input), items: input.items }),
    affectedResources: ({ target }) => [target],
  }),
  definition({
    name: 'angel_evaluation.submit',
    title: 'Submit angel evaluation',
    description: 'Freeze the confirmed personal context and queue the objective analysis for one deal.',
    risk: 'lifecycle',
    editableInputKeys: [],
    inputSchema: schema({
      workspaceId: workspaceProperty,
      draftId: { type: 'string', minLength: 1, maxLength: 64 },
      expectedRevision: { type: 'integer', minimum: 1 },
    }, ['draftId', 'expectedRevision']),
    resolve: draftTarget,
    inspect: inspectDraft,
    preview: ({ target, input, current }) => {
      if (current.status === 'discarded') throw new CommandError('PRECONDITION_FAILED', 'This evaluation draft was discarded.');
      if (current.revision !== input.expectedRevision) {
        throw new CommandError('STALE_DRAFT', 'This draft changed somewhere else. Reload before submitting.', { current_revision: current.revision });
      }
      return {
        summary: `Submit ${target.label} for analysis.`, target,
        before: [{ field: 'status', value: current.status }], after: [{ field: 'status', value: 'submitted' }],
        derivedEffects: ['Radar Desktop will run the objective analysis in the background.'], warnings: [], requiredReason: false,
      };
    },
    preconditions: ({ current }) => ({ revision: current.revision }),
    apply: ({ input }) => submit(input),
    affectedResources: ({ target, result }) => [
      target,
      { type: 'angel_evaluation_context', id: result.context_id },
      ...(result.run_id ? [{ type: 'council_run', id: Number(result.run_id) }] : []),
    ],
  }),
  definition({
    name: 'angel_evaluation.retry_personal_fit',
    title: 'Retry personal-fit reading',
    description: 'Re-queue only the failed personal-fit synthesis. The objective report is untouched.',
    editableInputKeys: [],
    // requestId lets a second retry (after a second failure) run instead of replaying the first.
    inputSchema: schema({ workspaceId: workspaceProperty, contextId: { type: 'string', minLength: 1, maxLength: 64 }, requestId: { type: 'string', minLength: 1, maxLength: 64 } }, ['contextId']),
    resolve: async input => {
      const context = await getEvaluationContext({ workspaceId: workspaceOf(input), contextId: input.contextId });
      if (!context) throw new CommandError('TARGET_NOT_FOUND', 'Evaluation context not found.');
      return { type: 'angel_evaluation_context', id: context.id, label: context.snapshot?.company?.name || 'Evaluation' };
    },
    inspect: async (target, input) => {
      const job = await getPersonalFitJob({ workspaceId: workspaceOf(input), contextId: target.id });
      return { status: job?.status || null, attempt_number: job?.attempt_number || 0 };
    },
    preview: ({ target, current }) => {
      if (current.status !== 'failed') throw new CommandError('PRECONDITION_FAILED', `Only a failed personal-fit reading can be retried (this one is ${current.status || 'missing'}).`);
      return {
        summary: `Retry the personal-fit reading for ${target.label}.`, target,
        before: [{ field: 'personal_fit', value: 'failed' }], after: [{ field: 'personal_fit', value: 'waiting' }],
        derivedEffects: [], warnings: [], requiredReason: false,
      };
    },
    preconditions: ({ current }) => current,
    apply: ({ input }) => retryPersonalFitJob({ workspaceId: workspaceOf(input), contextId: input.contextId }),
    affectedResources: ({ target }) => [target],
  }),
];
