import { writeCapabilities } from '../db/index.js';
import { buildUploadItems, parseGivingImport } from '../giving/import.js';
import {
  addRefund,
  confirmItem,
  correctGift,
  createGift,
  createRequest,
  decideRequest,
  DEFAULT_WORKSPACE_ID,
  ensureMember,
  getGift,
  getItem,
  getOrganization,
  getRequest,
  getSource,
  givingProblem,
  importSource,
  removeSource,
  resetGiving,
  saveBudget,
  saveLens,
  saveOrganization,
  saveSnapshot,
  setOngoingIntake,
  givingSettings,
  voidGift,
} from '../models/giving.js';
import { sampleBatch } from '../giving/sample-batch.js';
import { startOrgReview, startRequestEvaluation } from '../models/giving-reviews.js';
import { CommandError } from './errors.js';

// Giving commands. Every write goes through here. Nothing records money as paid
// except add_gift / record_payment / confirm_item(action: gift), each an explicit
// user confirmation. No command contacts an organization or moves money.

const objectResult = { type: 'object', additionalProperties: true };
const payload = { type: 'object' };
const text = max => ({ type: 'string', minLength: 1, maxLength: max });
const idText = text(64);

async function available() {
  const capabilities = await writeCapabilities();
  return capabilities.proposalApply === 'transactional' && capabilities.serializedWrites;
}

const workspaceOf = input => input.workspaceId || DEFAULT_WORKSPACE_ID;

async function guarded(fn) {
  try { return await fn(); } catch (error) { throw givingProblem(error); }
}

// Builds a registry definition from the parts that differ per command.
// requestId lets two identical requests both apply instead of replaying one receipt.
function command({ name, title, description, risk = 'additive_reporting_fact', properties, required = [], target, inspect = async () => ({}), summary, check, apply }) {
  return {
    name,
    version: 1,
    tier: 'A',
    title,
    description,
    risk,
    domainAtomicity: 'multi_statement',
    proposeCapabilities: ['portfolio:propose'],
    applyCapabilities: ['portfolio:apply:metadata'],
    availability: available,
    resultSchema: objectResult,
    interactionPolicy: 'execute_inline',
    undoPolicy: 'unavailable',
    plannerExposure: false,
    editableInputKeys: [],
    inputSchema: {
      type: 'object',
      properties: { workspaceId: text(128), requestId: idText, ...properties },
      required,
      additionalProperties: false,
    },
    resolve: input => target(input),
    inspect: (resolved, input) => inspect(resolved, input),
    preview: async ({ target: resolved, input, current }) => {
      if (check) await guarded(() => check({ input, current }));
      return { summary: summary({ input, current, target: resolved }), target: resolved, before: [], after: [], derivedEffects: [], warnings: [], requiredReason: false };
    },
    preconditions: ({ current }) => current,
    apply: ({ input }) => guarded(() => apply(input, workspaceOf(input))),
    affectedResources: ({ target: resolved }) => [resolved],
  };
}

const giving = { type: 'giving', id: 'workspace', label: 'Giving' };

async function found(kind, label, loader) {
  const row = await loader();
  if (!row) throw new CommandError('TARGET_NOT_FOUND', `${label} not found.`);
  return { type: kind, id: row.id, label };
}

const money = cents => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export const givingCommandDefinitions = [
  command({
    name: 'giving.import_file',
    title: 'Import giving proposals',
    description: 'Load a giving-import/v1 file as proposals to review. Nothing becomes confirmed giving.',
    properties: { file: payload, label: text(300), fileName: text(300), fileSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' } },
    required: ['file'],
    target: async () => giving,
    check: ({ input }) => { parseGivingImport(input.file); },
    summary: ({ input }) => `Add ${input.file.items?.length ?? 0} proposed giving records for review.`,
    apply: (input, workspaceId) => {
      const parsed = parseGivingImport(input.file);
      return importSource({
        workspaceId,
        source: { ...parsed.source, label: input.label || `Email scan ${parsed.source.metadata.period.from} to ${parsed.source.metadata.period.to}`, file_name: input.fileName, file_sha256: input.fileSha256 },
        items: parsed.items,
      });
    },
  }),
  command({
    name: 'giving.import_upload',
    title: 'Import uploaded giving file',
    description: 'Add proposals read from one uploaded file (email file, PDF, spreadsheet or screenshot) for review. Nothing becomes confirmed giving.',
    properties: {
      fileName: text(300),
      fileSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      fileKind: { type: 'string', enum: ['eml', 'pdf', 'csv', 'image', 'text'] },
      memberDisplayName: text(80),
      candidates: { type: 'array', minItems: 1, maxItems: 2000, items: payload },
    },
    required: ['fileName', 'fileSha256', 'fileKind', 'candidates'],
    target: async () => giving,
    check: ({ input }) => { buildUploadItems(input); },
    summary: ({ input }) => `Add ${input.candidates.length} proposed giving ${input.candidates.length === 1 ? 'record' : 'records'} from ${input.fileName} for review.`,
    apply: (input, workspaceId) => importSource({
      workspaceId,
      source: { kind: 'upload', label: input.fileName, member_display_name: input.memberDisplayName, file_name: input.fileName, file_sha256: input.fileSha256, metadata: { file_kind: input.fileKind } },
      items: buildUploadItems(input),
    }),
  }),
  command({
    name: 'giving.remove_source',
    title: 'Remove giving source',
    description: 'Withdraw a source and its undecided proposals. Confirmed records are kept and listed for review.',
    risk: 'corrective',
    properties: { sourceId: idText },
    required: ['sourceId'],
    target: input => found('giving_source', 'Source', () => getSource({ workspaceId: workspaceOf(input), sourceId: input.sourceId })),
    inspect: async (target, input) => ({ removed_at: (await getSource({ workspaceId: workspaceOf(input), sourceId: target.id }))?.removed_at || null }),
    summary: () => 'Remove this source and withdraw its undecided proposals.',
    apply: (input, workspaceId) => removeSource({ workspaceId, sourceId: input.sourceId }),
  }),
  command({
    name: 'giving.confirm_item',
    title: 'Confirm giving proposal',
    description: 'Confirm, correct, link or reject one proposed record.',
    risk: 'reconciliation',
    properties: { itemId: idText, decision: payload },
    required: ['itemId', 'decision'],
    target: input => found('giving_source_item', 'Proposed item', () => getItem({ workspaceId: workspaceOf(input), itemId: input.itemId })),
    inspect: async (target, input) => ({ status: (await getItem({ workspaceId: workspaceOf(input), itemId: target.id })).status }),
    check: ({ current }) => {
      if (current.status !== 'proposed') throw new CommandError('PRECONDITION_FAILED', `This item was already ${current.status}.`);
    },
    summary: ({ input }) => (input.decision.action === 'reject' ? 'Reject this proposal.' : `Confirm this proposal as ${String(input.decision.action).replaceAll('_', ' ')}.`),
    apply: (input, workspaceId) => confirmItem({ workspaceId, itemId: input.itemId, decision: input.decision }),
  }),
  command({
    name: 'giving.add_member',
    title: 'Add household member',
    description: 'Add a household member whose giving is tracked.',
    properties: { displayName: text(80) },
    required: ['displayName'],
    target: async () => giving,
    summary: ({ input }) => `Add ${input.displayName} to the household.`,
    apply: (input, workspaceId) => ensureMember({ workspaceId, displayName: input.displayName }),
  }),
  command({
    name: 'giving.save_organization',
    title: 'Save organization',
    description: 'Add or update one organization identity. A matching EIN reuses the existing record.',
    risk: 'metadata_change',
    properties: { organizationId: idText, name: text(300), ein: text(12), website: text(300), registrySnapshot: payload },
    required: ['name'],
    target: async input => (input.organizationId
      ? found('giving_organization', 'Organization', () => getOrganization({ workspaceId: workspaceOf(input), organizationId: input.organizationId }))
      : giving),
    inspect: async (target, input) => (target.type === 'giving_organization'
      ? { updated_at: String((await getOrganization({ workspaceId: workspaceOf(input), organizationId: target.id })).updated_at) }
      : {}),
    summary: ({ input }) => `${input.organizationId ? 'Update' : 'Add'} ${input.name}.`,
    apply: (input, workspaceId) => saveOrganization({ workspaceId, organizationId: input.organizationId, name: input.name, ein: input.ein, website: input.website, registrySnapshot: input.registrySnapshot }),
  }),
  command({
    name: 'giving.add_gift',
    title: 'Record paid gift',
    description: 'Record money already given. Only confirmed, paid gifts count in the report.',
    properties: { organization: payload, gift: payload },
    required: ['organization', 'gift'],
    target: async () => giving,
    summary: ({ input }) => `Record a paid gift of ${Number.isSafeInteger(input.gift.amount_cents) ? money(input.gift.amount_cents) : 'an amount'}.`,
    apply: (input, workspaceId) => createGift({ workspaceId, organization: input.organization, gift: input.gift }),
  }),
  command({
    name: 'giving.record_payment',
    title: 'Record payment for a request',
    description: 'Record a confirmed payment against an approved or pledged request.',
    risk: 'lifecycle',
    properties: { giftRequestId: idText, gift: payload },
    required: ['giftRequestId', 'gift'],
    target: input => found('giving_request', 'Request', () => getRequest({ workspaceId: workspaceOf(input), requestId: input.giftRequestId })),
    inspect: async (target, input) => ({ status: (await getRequest({ workspaceId: workspaceOf(input), requestId: target.id })).status }),
    check: ({ current }) => {
      if (!['approved', 'pledged'].includes(current.status)) throw new CommandError('PRECONDITION_FAILED', 'Only an approved or pledged request can receive a payment.');
    },
    summary: ({ input }) => `Record a confirmed payment of ${Number.isSafeInteger(input.gift.amount_cents) ? money(input.gift.amount_cents) : 'an amount'}.`,
    apply: async (input, workspaceId) => {
      const request = await getRequest({ workspaceId, requestId: input.giftRequestId });
      return createGift({ workspaceId, organization: { id: request.organization_id }, gift: { ...input.gift, request_id: request.id } });
    },
  }),
  command({
    name: 'giving.correct_gift',
    title: 'Correct gift',
    description: 'Correct a recorded gift. The change is logged; saved snapshots keep their original figures.',
    risk: 'corrective',
    properties: { giftId: idText, changes: payload },
    required: ['giftId', 'changes'],
    target: input => found('giving_gift', 'Gift', () => getGift({ workspaceId: workspaceOf(input), giftId: input.giftId })),
    inspect: async (target, input) => ({ updated_at: String((await getGift({ workspaceId: workspaceOf(input), giftId: target.id })).updated_at) }),
    summary: () => 'Correct this gift.',
    apply: (input, workspaceId) => correctGift({ workspaceId, giftId: input.giftId, changes: input.changes }),
  }),
  command({
    name: 'giving.void_gift',
    title: 'Void gift',
    description: 'Remove a gift from totals with a reason. The record and its history are kept.',
    risk: 'corrective',
    properties: { giftId: idText, reason: text(300) },
    required: ['giftId', 'reason'],
    target: input => found('giving_gift', 'Gift', () => getGift({ workspaceId: workspaceOf(input), giftId: input.giftId })),
    inspect: async (target, input) => ({ updated_at: String((await getGift({ workspaceId: workspaceOf(input), giftId: target.id })).updated_at) }),
    summary: () => 'Void this gift.',
    apply: (input, workspaceId) => voidGift({ workspaceId, giftId: input.giftId, reason: input.reason }),
  }),
  command({
    name: 'giving.add_refund',
    title: 'Record refund',
    description: 'Record a refund against an original gift. Reports show gross, refunds and net.',
    risk: 'corrective',
    properties: { giftId: idText, amountCents: { type: 'integer', minimum: 1 }, refundedOn: { type: 'string', format: 'date' } },
    required: ['giftId', 'amountCents'],
    target: input => found('giving_gift', 'Gift', () => getGift({ workspaceId: workspaceOf(input), giftId: input.giftId })),
    summary: ({ input }) => `Record a ${money(input.amountCents)} refund.`,
    apply: (input, workspaceId) => addRefund({ workspaceId, giftId: input.giftId, amountCents: input.amountCents, refundedOn: input.refundedOn }),
  }),
  command({
    name: 'giving.create_request',
    title: 'Add gift request',
    description: 'Add an incoming gift request to the Gift Pipeline. It can coexist with past gifts to the same organization.',
    properties: { organization: payload, request: payload },
    required: ['organization', 'request'],
    target: async () => giving,
    summary: () => 'Add a gift request to the pipeline.',
    apply: (input, workspaceId) => createRequest({ workspaceId, organization: input.organization, request: input.request }),
  }),
  command({
    name: 'giving.decide_request',
    title: 'Decide gift request',
    description: 'Record a decision: evaluate, approve, pledge, defer, pass or cancel. No money moves and nothing is recorded as paid.',
    risk: 'lifecycle',
    properties: {
      giftRequestId: idText,
      status: { type: 'string', enum: ['requested', 'evaluating', 'approved', 'pledged', 'deferred', 'passed', 'cancelled'] },
      decidedCents: { type: 'integer', minimum: 0 },
      rationale: text(4000),
      pledge: payload,
    },
    required: ['giftRequestId', 'status'],
    target: input => found('giving_request', 'Request', () => getRequest({ workspaceId: workspaceOf(input), requestId: input.giftRequestId })),
    inspect: async (target, input) => {
      const request = await getRequest({ workspaceId: workspaceOf(input), requestId: target.id });
      return { status: request.status, updated_at: String(request.updated_at) };
    },
    summary: ({ input, current }) => `Move this request from ${current.status} to ${input.status}.`,
    apply: (input, workspaceId) => decideRequest({ workspaceId, requestId: input.giftRequestId, status: input.status, decidedCents: input.decidedCents, rationale: input.rationale, pledge: input.pledge }),
  }),
  command({
    name: 'giving.save_lens',
    title: 'Save giving causes and priorities',
    description: 'Save confirmed causes and priorities as a new version. Earlier versions and snapshots are unchanged.',
    risk: 'metadata_change',
    properties: { lens: payload },
    required: ['lens'],
    target: async () => ({ type: 'giving_lens', id: 'current', label: 'Giving lens' }),
    summary: ({ input }) => `Save ${input.lens.causes?.length || 0} causes and ${input.lens.priorities?.length || 0} priorities.`,
    apply: (input, workspaceId) => saveLens({ workspaceId, lens: input.lens }),
  }),
  command({
    name: 'giving.save_budget',
    title: 'Save giving budget',
    description: 'Save the forward budget for fixed dates: a confirmed amount (zero allowed) or skipped.',
    risk: 'metadata_change',
    properties: { budget: payload },
    required: ['budget'],
    target: async () => ({ type: 'giving_budget', id: 'current', label: 'Giving budget' }),
    summary: ({ input }) => (input.budget.mode === 'skipped' ? 'Skip the dollar budget.' : `Set the giving budget to ${Number.isSafeInteger(input.budget.amount_cents) ? money(input.budget.amount_cents) : 'an amount'}.`),
    apply: (input, workspaceId) => saveBudget({ workspaceId, budget: input.budget }),
  }),
  command({
    name: 'giving.save_snapshot',
    title: 'Save giving snapshot',
    description: 'Save a dated, immutable copy of a report or decision.',
    properties: { kind: { type: 'string', enum: ['report', 'decision'] }, asOf: { type: 'string', format: 'date' }, payload, label: text(300), subjectId: idText },
    required: ['kind', 'asOf', 'payload'],
    target: async () => giving,
    summary: ({ input }) => `Save a ${input.kind} snapshot as of ${input.asOf}.`,
    apply: (input, workspaceId) => saveSnapshot({ workspaceId, kind: input.kind, asOf: input.asOf, payload: input.payload, label: input.label, subjectId: input.subjectId }),
  }),
  command({
    name: 'giving.start_org_review',
    title: 'Research an organization',
    description: 'Start an evidence review of one organization against the giving rubric. Only its public identity is used.',
    risk: 'lifecycle',
    properties: { organizationId: idText },
    required: ['organizationId'],
    target: input => found('giving_organization', 'Organization', () => getOrganization({ workspaceId: workspaceOf(input), organizationId: input.organizationId })),
    summary: ({ target }) => `Research ${target.label}.`,
    apply: (input, workspaceId) => startOrgReview({ workspaceId, organizationId: input.organizationId }),
  }),
  command({
    name: 'giving.start_request_evaluation',
    title: 'Evaluate a gift request',
    description: 'Start reading one request against its organization review, your causes and priorities, and your budget.',
    risk: 'lifecycle',
    properties: { giftRequestId: idText },
    required: ['giftRequestId'],
    target: input => found('giving_request', 'Request', () => getRequest({ workspaceId: workspaceOf(input), requestId: input.giftRequestId })),
    summary: () => 'Evaluate this request.',
    apply: (input, workspaceId) => startRequestEvaluation({ workspaceId, requestId: input.giftRequestId }),
  }),
  command({
    name: 'giving.set_ongoing_intake',
    title: 'Turn ongoing intake on or off',
    description: 'Explicit opt-in for ongoing intake. Until an email connector exists this is a simulation with labeled sample batches; nothing reads email.',
    risk: 'metadata_change',
    properties: { enabled: { type: 'boolean' } },
    required: ['enabled'],
    target: async () => ({ type: 'giving_settings', id: 'ongoing_intake', label: 'Ongoing intake' }),
    inspect: async (_target, input) => ({ enabled: (await givingSettings({ workspaceId: workspaceOf(input) })).ongoing_intake.enabled === true }),
    summary: ({ input }) => (input.enabled ? 'Turn on the ongoing-intake simulation.' : 'Turn off ongoing intake.'),
    apply: (input, workspaceId) => setOngoingIntake({ workspaceId, enabled: input.enabled }),
  }),
  command({
    name: 'giving.add_sample_batch',
    title: 'Add a sample intake batch',
    description: 'Add one labeled sample batch (fictional organizations) to show how ongoing intake would arrive. Only while the simulation is on.',
    properties: {},
    target: async () => giving,
    inspect: async (_target, input) => ({ enabled: (await givingSettings({ workspaceId: workspaceOf(input) })).ongoing_intake.enabled === true }),
    check: ({ current }) => {
      if (!current.enabled) throw new CommandError('PRECONDITION_FAILED', 'Turn on the ongoing-intake simulation first.');
    },
    summary: () => 'Add a labeled sample batch.',
    apply: (_input, workspaceId) => {
      const parsed = parseGivingImport(sampleBatch());
      return importSource({ workspaceId, source: { ...parsed.source, label: `Sample batch (simulation) ${new Date().toISOString().slice(0, 10)}` }, items: parsed.items });
    },
  }),
  command({
    name: 'giving.reset',
    title: 'Delete all giving data',
    description: 'Permanently delete every giving record in this workspace. Investment data is untouched.',
    risk: 'destructive',
    properties: { confirmText: { type: 'string', const: 'delete giving data' } },
    required: ['confirmText'],
    target: async () => giving,
    summary: () => 'Permanently delete all giving data.',
    apply: (_input, workspaceId) => resetGiving({ workspaceId }),
  }),
];
