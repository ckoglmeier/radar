import { query, writeCapabilities } from '../db/index.js';
import {
  assignPrimaryTheses,
  getThesisById,
  primaryThesisAssignments,
  removeThesisIfUnreferenced,
  restorePrimaryThesisAssignments,
  saveThesis,
  setThesisActive,
  updateThesisById,
} from '../models/theses.js';
import { CommandError } from './errors.js';

const objectResult = { type: 'object', additionalProperties: true };
const nullableText = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const nullableConviction = { anyOf: [{ type: 'integer', minimum: 0, maximum: 5 }, { type: 'null' }] };
const date = { type: 'string', format: 'date' };

function schema(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false };
}

async function available() {
  const capability = await writeCapabilities();
  return capability.proposalApply === 'transactional' && capability.serializedWrites;
}

function dateOnly(value) {
  return value == null ? null : String(value instanceof Date ? value.toISOString() : value).slice(0, 10);
}

function thesisSnapshot(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    active: Boolean(row.active),
    inactive_at: dateOnly(row.inactive_at),
    inactive_reason: row.inactive_reason || null,
    lens_source: row.lens_source || null,
    lens_thesis_id: row.lens_thesis_id || null,
    belief: row.belief || null,
    proves_true: row.proves_true || null,
    proves_false: row.proves_false || null,
    open_question: row.open_question || null,
    conviction_now: row.conviction_now == null ? null : Number(row.conviction_now),
    conviction_entry: row.conviction_entry == null ? null : Number(row.conviction_entry),
    qualifications: row.qualifications || [],
    exclusions: row.exclusions || [],
    conviction_signal: row.conviction_signal || null,
  };
}

function contentInput(input) {
  return {
    name: input.name,
    belief: input.belief ?? null,
    proves_true: input.provesTrue ?? null,
    proves_false: input.provesFalse ?? null,
    open_question: input.openQuestion ?? null,
    conviction_now: input.convictionNow ?? null,
    conviction_entry: input.convictionEntry ?? null,
    qualifications: input.qualifications ?? [],
    exclusions: input.exclusions ?? [],
    conviction_signal: input.convictionSignal ?? null,
  };
}

function snapshotContent(snapshot) {
  return {
    name: snapshot.name,
    belief: snapshot.belief,
    proves_true: snapshot.proves_true,
    proves_false: snapshot.proves_false,
    open_question: snapshot.open_question,
    conviction_now: snapshot.conviction_now,
    conviction_entry: snapshot.conviction_entry,
    qualifications: snapshot.qualifications,
    exclusions: snapshot.exclusions,
    conviction_signal: snapshot.conviction_signal,
  };
}

const contentProperties = {
  name: { type: 'string', minLength: 1 },
  belief: nullableText,
  provesTrue: nullableText,
  provesFalse: nullableText,
  openQuestion: nullableText,
  convictionNow: nullableConviction,
  convictionEntry: nullableConviction,
  qualifications: { type: 'array', items: { type: 'string' } },
  exclusions: { type: 'array', items: { type: 'string' } },
  convictionSignal: nullableText,
};

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
    undoPolicy: 'inverse',
    ...definition,
  };
}

async function thesisTarget(thesisId) {
  const thesis = await getThesisById(thesisId);
  if (!thesis) throw new CommandError('TARGET_NOT_FOUND', `Thesis not found: ${thesisId}`);
  return { type: 'thesis', id: Number(thesis.id), label: thesis.name };
}

async function inspectThesis(target) {
  const thesis = await getThesisById(target.id);
  if (!thesis) throw new CommandError('TARGET_NOT_FOUND', `Thesis not found: ${target.id}`);
  return thesisSnapshot(thesis);
}

async function assignmentTarget(input) {
  const thesis = await getThesisById(input.thesisId);
  if (!thesis) throw new CommandError('TARGET_NOT_FOUND', `Thesis not found: ${input.thesisId}`);
  const assignments = await primaryThesisAssignments(input.investmentIds || [input.investmentId]);
  return {
    type: assignments.length === 1 ? 'direct_position' : 'direct_position_set',
    id: assignments.length === 1 ? assignments[0].investmentId : assignments.map(item => item.investmentId).join(','),
    label: assignments.length === 1 ? assignments[0].companyName : `${assignments.length} Direct positions`,
    investmentIds: assignments.map(item => item.investmentId),
    thesisId: Number(thesis.id),
    thesisName: thesis.name,
  };
}

async function inspectAssignments(target) {
  return {
    thesis: thesisSnapshot(await getThesisById(target.thesisId)),
    assignments: await primaryThesisAssignments(target.investmentIds),
  };
}

function assignmentPreview(target, input, current) {
  const changed = input.onlyIfUnassigned
    ? current.assignments.filter(item => item.thesisId == null)
    : current.assignments;
  return {
    summary: `Assign ${changed.length} position${changed.length === 1 ? '' : 's'} to ${target.thesisName}.`,
    target: { type: 'thesis', id: target.thesisId, label: target.thesisName },
    targetCount: current.assignments.length,
    targets: current.assignments.map(item => ({ type: 'direct_position', id: item.investmentId, label: item.companyName })),
    before: current.assignments.map(item => ({ targetId: item.investmentId, field: 'primary_thesis_id', value: item.thesisId })),
    after: changed.map(item => ({ targetId: item.investmentId, field: 'primary_thesis_id', value: target.thesisId })),
    derivedEffects: [],
    warnings: input.onlyIfUnassigned ? ['Existing primary thesis assignments will remain unchanged.'] : [],
    requiredReason: false,
  };
}

function assignmentResources({ target }) {
  return [
    { type: 'thesis', id: target.thesisId, label: target.thesisName },
    ...target.investmentIds.map(id => ({ type: 'direct_position', id })),
  ];
}

export const thesisCommandDefinitions = [
  base({
    name: 'thesis.create',
    title: 'Create thesis',
    description: 'Create an Active first-level investing thesis.',
    risk: 'metadata_change',
    interactionPolicy: 'execute_inline',
    editableInputKeys: Object.keys(contentProperties),
    inputSchema: schema(contentProperties, ['name']),
    resolve: input => ({ type: 'thesis_name', id: input.name.trim().toLowerCase(), label: input.name.trim() }),
    inspect: async target => {
      const [row] = await query('SELECT * FROM theses WHERE LOWER(name) = $1', [target.id]);
      return { existing: thesisSnapshot(row) };
    },
    preview: ({ target, current }) => {
      if (current.existing) throw new CommandError('TARGET_ALREADY_EXISTS', `A thesis named ${target.label} already exists.`);
      return { summary: `Create thesis ${target.label}.`, target, before: [], after: [{ field: 'name', value: target.label }], derivedEffects: [], warnings: [], requiredReason: false };
    },
    preconditions: ({ current }) => ({ existing: current.existing }),
    apply: async ({ input }) => ({ thesis: thesisSnapshot(await saveThesis(contentInput(input))) }),
    inspectAfter: async ({ result }) => thesisSnapshot(await getThesisById(result.thesis.id)),
    affectedResources: ({ result }) => [{ type: 'thesis', id: result.thesis.id, label: result.thesis.name }],
    undo: async ({ result }) => ({ thesis: thesisSnapshot(await removeThesisIfUnreferenced(result.thesis.id)) }),
    inspectUndo: async ({ result }) => thesisSnapshot(await getThesisById(result.thesis.id)),
  }),
  base({
    name: 'thesis.update',
    title: 'Update thesis',
    description: 'Edit the content of an existing thesis without changing its identity.',
    risk: 'metadata_change',
    interactionPolicy: 'execute_inline',
    editableInputKeys: Object.keys(contentProperties),
    inputSchema: schema({ thesisId: { type: 'integer', minimum: 1 }, ...contentProperties }, ['thesisId', 'name']),
    resolve: input => thesisTarget(input.thesisId),
    inspect: inspectThesis,
    preview: ({ target, input, current }) => ({ summary: `Update ${target.label}.`, target, before: [snapshotContent(current)], after: [contentInput(input)], derivedEffects: [], warnings: [], requiredReason: false }),
    preconditions: ({ current }) => current,
    apply: async ({ target, input }) => ({ thesis: thesisSnapshot(await updateThesisById(target.id, contentInput(input))) }),
    affectedResources: ({ target }) => [target],
    undo: async ({ target, before }) => ({ thesis: thesisSnapshot(await updateThesisById(target.id, snapshotContent(before))) }),
  }),
  base({
    name: 'thesis.set_active',
    title: 'Set thesis activity',
    description: 'Make a thesis Active or Inactive while preserving its history.',
    risk: 'lifecycle',
    interactionPolicy: 'execute_inline',
    editableInputKeys: ['active', 'effectiveDate', 'reason'],
    inputSchema: schema({ thesisId: { type: 'integer', minimum: 1 }, active: { type: 'boolean' }, effectiveDate: date, reason: nullableText }, ['thesisId', 'active']),
    resolve: input => thesisTarget(input.thesisId),
    inspect: inspectThesis,
    preview: ({ target, input, current }) => ({ summary: `Make ${target.label} ${input.active ? 'Active' : 'Inactive'}.`, target, before: [{ field: 'active', value: current.active }, { field: 'inactive_at', value: current.inactive_at }], after: [{ field: 'active', value: input.active }, { field: 'inactive_at', value: input.active ? null : (input.effectiveDate || 'today') }], derivedEffects: [], warnings: [], requiredReason: false }),
    preconditions: ({ current }) => ({ active: current.active, inactive_at: current.inactive_at, inactive_reason: current.inactive_reason }),
    apply: async ({ target, input }) => ({ thesis: thesisSnapshot(await setThesisActive(target.id, input)) }),
    affectedResources: ({ target }) => [target],
    undo: async ({ target, before }) => ({ thesis: thesisSnapshot(await setThesisActive(target.id, { active: before.active, effectiveDate: before.inactive_at, reason: before.inactive_reason })) }),
  }),
  base({
    name: 'thesis.assign_primary',
    title: 'Assign primary thesis',
    description: 'Assign one Direct position to its primary thesis.',
    risk: 'metadata_change',
    interactionPolicy: 'execute_inline',
    editableInputKeys: ['thesisId', 'onlyIfUnassigned'],
    inputSchema: schema({ investmentId: { type: 'integer', minimum: 1 }, thesisId: { type: 'integer', minimum: 1 }, onlyIfUnassigned: { type: 'boolean' } }, ['investmentId', 'thesisId']),
    resolve: input => assignmentTarget({ ...input, investmentIds: [input.investmentId] }),
    inspect: inspectAssignments,
    preview: ({ target, input, current }) => assignmentPreview(target, { ...input, onlyIfUnassigned: input.onlyIfUnassigned ?? false }, current),
    preconditions: ({ current }) => current,
    apply: ({ target, input }) => assignPrimaryTheses(target.investmentIds, target.thesisId, { onlyIfUnassigned: input.onlyIfUnassigned ?? false }),
    affectedResources: assignmentResources,
    undo: ({ before }) => restorePrimaryThesisAssignments(before.assignments),
  }),
  base({
    name: 'thesis.assign_primary_bulk',
    title: 'Assign primary thesis in bulk',
    description: 'Assign an exact snapshot of Direct positions to one primary thesis.',
    risk: 'metadata_change',
    interactionPolicy: 'confirm_inline',
    interactionPolicyForInput: input => input.onlyIfUnassigned ? 'execute_inline' : 'confirm_inline',
    editableInputKeys: ['thesisId'],
    inputSchema: schema({ investmentIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'integer', minimum: 1 } }, thesisId: { type: 'integer', minimum: 1 }, onlyIfUnassigned: { type: 'boolean' } }, ['investmentIds', 'thesisId', 'onlyIfUnassigned']),
    resolve: assignmentTarget,
    inspect: inspectAssignments,
    preview: ({ target, input, current }) => assignmentPreview(target, input, current),
    preconditions: ({ current }) => current,
    apply: ({ target, input }) => assignPrimaryTheses(target.investmentIds, target.thesisId, { onlyIfUnassigned: input.onlyIfUnassigned }),
    affectedResources: assignmentResources,
    undo: ({ before }) => restorePrimaryThesisAssignments(before.assignments),
  }),
];
