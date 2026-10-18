import { writeCapabilities } from '../db/index.js';
import { saveAnalysisLens, validateAnalysisLens } from '../models/analysis-lenses.js';
export const analysisLensCommandDefinitions = [{
  name: 'analysis_lens.save', version: 1, tier: 'A', title: 'Save a reusable analysis lens',
  description: 'Explicitly save personal preferences for future Angel or Giving analyses. Does not replace the plan or save deal facts.',
  risk: 'metadata_change', domainAtomicity: 'multi_statement',
  proposeCapabilities: ['portfolio:propose'], applyCapabilities: ['portfolio:apply:metadata'],
  availability: async () => { const cap = await writeCapabilities(); return cap.proposalApply === 'transactional' && cap.serializedWrites; },
  resultSchema: { type: 'object', additionalProperties: true }, interactionPolicy: 'execute_inline', undoPolicy: 'unavailable', plannerExposure: false, editableInputKeys: [],
  inputSchema: { type: 'object', additionalProperties: false, required: ['category','name','payload'], properties: {
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 }, category: { enum: ['angel','giving'] },
    name: { type: 'string', minLength: 1, maxLength: 80 }, payload: { type: 'object' },
    lensId: { type: 'string', format: 'uuid' }, requestId: { type: 'string', maxLength: 64 },
  } },
  resolve: input => ({ type: 'analysis_lens', id: input.lensId || 'new', label: 'Analysis lens' }),
  inspect: async () => ({}),
  preview: ({ input, target }) => { validateAnalysisLens(input.category, input.payload); return { summary: `Save ${input.name} for future ${input.category} analyses.`, target, before: [], after: [], derivedEffects: [], warnings: [], requiredReason: false }; },
  preconditions: ({ current }) => current,
  apply: ({ input }) => saveAnalysisLens({ ...input, workspaceId: input.workspaceId || 'local' }),
  affectedResources: ({ target }) => [target],
}];
