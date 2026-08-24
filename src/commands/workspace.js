import { query, writeCapabilities } from '../db/index.js';
import { dismissAttentionItem } from '../models/attention-dismissals.js';
import { saveFrameworkVersion } from '../models/framework.js';
import {
  createInvestmentUpdate,
  retryInvestmentUpdate,
  reviewInvestmentUpdate,
  updateInvestmentUpdateMetadata,
} from '../models/investment-updates.js';
import { createMetricView, deleteMetricView, updateMetricView } from '../models/metric-views.js';
import { getUserSettings, setOnboarded } from '../models/settings.js';
import { CommandError } from './errors.js';

const objectResult = { type: 'object', additionalProperties: true };
const text = { type: 'string', minLength: 1 };
const nullableText = { anyOf: [text, { type: 'null' }] };
const date = { type: 'string', format: 'date' };
const uuid = { type: 'string', format: 'uuid' };

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
    plannerExposure: true,
    ...base,
  };
}

async function updateTarget(updateId) {
  const [row] = await query(`
    SELECT u.*, i.company_name
      FROM investment_updates u
      JOIN investments i ON i.id = u.investment_id
     WHERE u.id = $1
  `, [updateId]);
  if (!row) throw new CommandError('TARGET_NOT_FOUND', `Investment update not found: ${updateId}`);
  return { type: 'investment_update', id: row.id, label: row.title || `${row.company_name} update` };
}

async function inspectUpdate(target) {
  const [row] = await query('SELECT * FROM investment_updates WHERE id = $1', [target.id]);
  if (!row) throw new CommandError('TARGET_NOT_FOUND', `Investment update not found: ${target.id}`);
  return row;
}

async function metricViewTarget(id) {
  const [row] = await query('SELECT * FROM metric_views WHERE id = $1', [id]);
  if (!row) throw new CommandError('TARGET_NOT_FOUND', `Saved performance view not found: ${id}`);
  return { type: 'metric_view', id: Number(row.id), label: row.name };
}

async function inspectMetricView(target) {
  const [row] = await query('SELECT * FROM metric_views WHERE id = $1', [target.id]);
  if (!row) throw new CommandError('TARGET_NOT_FOUND', `Saved performance view not found: ${target.id}`);
  return row;
}

export const workspaceCommandDefinitions = [
  definition({
    name: 'framework.save',
    title: 'Save evaluation framework',
    description: 'Validate and save a new immutable evaluation-framework version.',
    risk: 'lifecycle',
    interactionPolicy: 'confirm_inline',
    editableInputKeys: ['framework', 'changeNote'],
    inputSchema: schema({
      framework: { type: 'object', additionalProperties: true },
      changeNote: nullableText,
    }, ['framework']),
    resolve: () => ({ type: 'evaluation_framework', id: 'active', label: 'Evaluation framework' }),
    inspect: async () => (await query(`
      SELECT id, version, created_at
        FROM lens_framework_versions
       ORDER BY created_at DESC, id DESC LIMIT 1
    `))[0] || null,
    preview: ({ target, current }) => ({
      summary: 'Save a new immutable evaluation-framework version.', target,
      before: [{ field: 'active_version', value: current?.version || null }],
      after: [{ field: 'active_version', value: 'next patch version' }],
      derivedEffects: [], warnings: [], requiredReason: true,
    }),
    preconditions: ({ current }) => current,
    apply: ({ input }) => saveFrameworkVersion(input),
    affectedResources: ({ result }) => [{ type: 'evaluation_framework_version', id: Number(result.id), label: result.version }],
  }),
  definition({
    name: 'update.add',
    title: 'Add investment update',
    description: 'Attach a staged source document to an investment as a typed update record.',
    risk: 'additive_reporting_fact',
    applyCapabilities: ['portfolio:apply:additive'],
    editableInputKeys: ['updateKind', 'taxYear', 'title', 'receivedDate', 'processingMode'],
    inputSchema: schema({
      investmentId: { type: 'integer', minimum: 1 },
      sourceDocumentId: { type: 'integer', minimum: 1 },
      updateKind: { type: 'string', enum: ['founder_update', 'fund_update', 'fund_k1', 'employment_disclosure', 'valuation_update', 'financial_update', 'general'] },
      taxYear: { anyOf: [{ type: 'integer', minimum: 1900, maximum: 2100 }, { type: 'null' }] },
      title: nullableText,
      receivedDate: date,
      processingMode: { type: 'string', enum: ['store_only', 'interpret'] },
    }, ['investmentId', 'sourceDocumentId', 'updateKind', 'receivedDate', 'processingMode']),
    resolve: async input => {
      const [row] = await query('SELECT id, company_name FROM investments WHERE id = $1', [input.investmentId]);
      if (!row) throw new CommandError('TARGET_NOT_FOUND', `Investment not found: ${input.investmentId}`);
      return { type: 'investment', id: Number(row.id), label: row.company_name };
    },
    inspect: async (target, input) => ({
      investment: (await query('SELECT id, company_name, asset_class, updated_at FROM investments WHERE id = $1', [target.id]))[0],
      document: (await query('SELECT id, entity_type, entity_id, sha256 FROM documents WHERE id = $1', [input.sourceDocumentId]))[0] || null,
      existing: (await query('SELECT id FROM investment_updates WHERE source_document_id = $1', [input.sourceDocumentId]))[0] || null,
    }),
    preview: ({ target, input, current }) => {
      if (!current.document || current.document.entity_type !== 'investment' || Number(current.document.entity_id) !== target.id) {
        throw new CommandError('WRONG_TARGET_TYPE', 'Source document must be staged against this investment.');
      }
      return {
        summary: `Add ${input.updateKind.replaceAll('_', ' ')} for ${target.label}.`, target,
        before: [{ field: 'existing_update_id', value: current.existing?.id || null }],
        after: [{ field: 'source_document_id', value: input.sourceDocumentId }],
        derivedEffects: input.processingMode === 'interpret' ? ['Interpretation must run as a tracked follow-on workflow.'] : [],
        warnings: [], requiredReason: false,
      };
    },
    preconditions: ({ current }) => current,
    apply: ({ input }) => createInvestmentUpdate(input),
    affectedResources: ({ target, result }) => [target, { type: 'investment_update', id: result.update.id, label: result.update.title || target.label }],
  }),
  definition({
    name: 'update.retry',
    title: 'Retry investment update',
    description: 'Move a failed update back to pending so its tracked interpretation workflow can run again.',
    risk: 'lifecycle',
    editableInputKeys: [],
    inputSchema: schema({ updateId: uuid }, ['updateId']),
    resolve: input => updateTarget(input.updateId),
    inspect: inspectUpdate,
    preview: ({ target, current }) => ({
      summary: `Retry ${target.label}.`, target,
      before: [{ field: 'status', value: current.status }],
      after: [{ field: 'status', value: 'pending' }],
      derivedEffects: ['Interpretation must run as a tracked follow-on workflow.'], warnings: [], requiredReason: false,
    }),
    preconditions: ({ current }) => ({ status: current.status, updated_at: current.updated_at }),
    apply: ({ target }) => retryInvestmentUpdate(target.id),
    affectedResources: ({ target }) => [target],
  }),
  definition({
    name: 'update.review',
    title: 'Review investment update',
    description: 'Close a pending source interpretation without applying its proposed record changes.',
    risk: 'lifecycle',
    editableInputKeys: ['outcome', 'note'],
    inputSchema: schema({
      updateId: uuid,
      outcome: { type: 'string', enum: ['reviewed_no_changes', 'interpretation_rejected'] },
      reviewedBy: text,
      note: nullableText,
    }, ['updateId', 'outcome', 'reviewedBy']),
    resolve: input => updateTarget(input.updateId),
    inspect: inspectUpdate,
    preview: ({ target, input, current }) => ({
      summary: `Mark ${target.label} ${input.outcome.replaceAll('_', ' ')}.`, target,
      before: [{ field: 'review_status', value: current.review_status }],
      after: [{ field: 'review_status', value: input.outcome }],
      derivedEffects: [], warnings: [], requiredReason: false,
    }),
    preconditions: ({ current }) => ({ status: current.status, review_status: current.review_status, updated_at: current.updated_at }),
    apply: ({ target, input }) => reviewInvestmentUpdate(target.id, input),
    affectedResources: ({ target }) => [target],
  }),
  definition({
    name: 'update.update_metadata',
    title: 'Update investment-update metadata',
    description: 'Change the received date recorded for an investment update.',
    editableInputKeys: ['receivedDate'],
    inputSchema: schema({ updateId: uuid, receivedDate: date }, ['updateId', 'receivedDate']),
    resolve: input => updateTarget(input.updateId),
    inspect: inspectUpdate,
    preview: ({ target, input, current }) => ({
      summary: `Update the received date for ${target.label}.`, target,
      before: [{ field: 'received_date', value: String(current.received_date).slice(0, 10) }],
      after: [{ field: 'received_date', value: input.receivedDate }],
      derivedEffects: [], warnings: [], requiredReason: false,
    }),
    preconditions: ({ current }) => ({ received_date: current.received_date, updated_at: current.updated_at }),
    apply: ({ target, input }) => updateInvestmentUpdateMetadata(target.id, input),
    affectedResources: ({ target }) => [target],
  }),
  definition({
    name: 'performance.save_view',
    title: 'Save performance view',
    description: 'Save a validated metric query for reuse.',
    risk: 'additive_reporting_fact',
    applyCapabilities: ['portfolio:apply:additive'],
    editableInputKeys: ['name', 'query'],
    inputSchema: schema({ name: text, query: { type: 'object', additionalProperties: true } }, ['name', 'query']),
    resolve: input => ({ type: 'metric_view_name', id: input.name.trim().toLowerCase(), label: input.name.trim() }),
    inspect: async target => ({ sameNameCount: Number((await query('SELECT COUNT(*)::int AS count FROM metric_views WHERE LOWER(name) = $1', [target.id]))[0].count) }),
    preview: ({ target, current }) => ({
      summary: `Save performance view ${target.label}.`, target,
      before: [{ field: 'same_name_count', value: current.sameNameCount }],
      after: [{ field: 'saved', value: true }], derivedEffects: [], warnings: [], requiredReason: false,
    }),
    preconditions: ({ current }) => current,
    apply: ({ input }) => createMetricView(input),
    affectedResources: ({ result }) => [{ type: 'metric_view', id: Number(result.id), label: result.name }],
  }),
  definition({
    name: 'performance.rename_view',
    title: 'Rename performance view',
    description: 'Rename one saved metric view.',
    editableInputKeys: ['name'],
    inputSchema: schema({ viewId: { type: 'integer', minimum: 1 }, name: text }, ['viewId', 'name']),
    resolve: input => metricViewTarget(input.viewId),
    inspect: inspectMetricView,
    preview: ({ target, input, current }) => ({
      summary: `Rename ${target.label} to ${input.name.trim()}.`, target,
      before: [{ field: 'name', value: current.name }],
      after: [{ field: 'name', value: input.name.trim() }], derivedEffects: [], warnings: [], requiredReason: false,
    }),
    preconditions: ({ current }) => ({ name: current.name, updated_at: current.updated_at }),
    apply: ({ target, input }) => updateMetricView(target.id, { name: input.name }),
    affectedResources: ({ target }) => [target],
  }),
  definition({
    name: 'performance.delete_view',
    title: 'Delete performance view',
    description: 'Delete one saved metric view.',
    risk: 'destructive',
    interactionPolicy: 'confirm_inline',
    editableInputKeys: [],
    inputSchema: schema({ viewId: { type: 'integer', minimum: 1 } }, ['viewId']),
    resolve: input => metricViewTarget(input.viewId),
    inspect: inspectMetricView,
    preview: ({ target, current }) => ({
      summary: `Delete saved performance view ${target.label}.`, target,
      before: [{ field: 'name', value: current.name }, { field: 'query', value: current.query }],
      after: [{ field: 'deleted', value: true }], derivedEffects: [], warnings: [], requiredReason: false,
    }),
    preconditions: ({ current }) => current,
    apply: async ({ target }) => ({ deleted: await deleteMetricView(target.id), id: target.id }),
    inspectAfter: ({ result }) => result,
    affectedResources: ({ target }) => [target],
  }),
  definition({
    name: 'preference.finish_onboarding',
    title: 'Finish onboarding',
    description: 'Record onboarding completion and the chosen starting workspace.',
    editableInputKeys: ['track'],
    inputSchema: schema({
      userId: text,
      track: { type: 'string', enum: ['theses', 'portfolio', 'cockpit'] },
    }, ['userId', 'track']),
    resolve: input => ({ type: 'user_settings', id: input.userId, label: 'Workspace preferences' }),
    inspect: target => getUserSettings(target.id),
    preview: ({ target, input, current }) => ({
      summary: `Finish onboarding with ${input.track} as the starting workspace.`, target,
      before: [{ field: 'onboarded', value: current?.onboarded || false }, { field: 'onboarding_track', value: current?.onboarding_track || null }],
      after: [{ field: 'onboarded', value: true }, { field: 'onboarding_track', value: input.track }],
      derivedEffects: [], warnings: [], requiredReason: false,
    }),
    preconditions: ({ current }) => current,
    apply: ({ input }) => setOnboarded(input.userId, true, input.track),
    affectedResources: ({ target }) => [target],
  }),
  definition({
    name: 'pin.dismiss',
    title: 'Dismiss pinned work',
    description: 'Remove one exact derived work item from the active to-do list.',
    editableInputKeys: [],
    inputSchema: schema({ signalKey: text, signalType: text }, ['signalKey', 'signalType']),
    resolve: input => ({ type: 'pinned_work', id: input.signalKey, label: input.signalKey }),
    inspect: async target => (await query('SELECT * FROM attention_dismissals WHERE signal_key = $1', [target.id]))[0] || null,
    preview: ({ target, current }) => ({
      summary: `Dismiss ${target.label}.`, target,
      before: [{ field: 'dismissed', value: Boolean(current) }],
      after: [{ field: 'dismissed', value: true }], derivedEffects: [], warnings: [], requiredReason: false,
    }),
    preconditions: ({ current }) => current,
    apply: ({ input }) => dismissAttentionItem(input),
    affectedResources: ({ target }) => [target],
  }),
];
