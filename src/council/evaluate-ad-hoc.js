import { createHash } from 'node:crypto';
import { AD_HOC_REVIEW_SCHEMA, AD_HOC_REVIEW_INSTRUCTIONS, validateAdHocReview, createAdHocReviewArtifact } from './ad-hoc-review.js';
import { chunkRoomDocuments, batchRoomChunks, assertCompleteChunkCoverage } from './room-evidence.js';
import { resolveCouncilModels } from '../providers/council-models.js';
import { aggregateStageUsage } from '../providers/session-usage.js';

const webSource = { type: 'object', additionalProperties: false, required: ['id', 'url', 'title'], properties: {
  id: { type: 'string' }, url: { type: 'string' }, title: { type: 'string' },
} };
const researchSchema = { type: 'object', additionalProperties: false, required: ['report', 'web_sources'], properties: {
  report: AD_HOC_REVIEW_SCHEMA, web_sources: { type: 'array', maxItems: 30, items: webSource },
} };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// No DB/lens/calibration access. The caller owns authorization, queue lifecycle
// and persistence. Research may search; consolidation has no tools or writes.
export async function evaluateAdHoc(deal, { provider, models, signal, onStage,
  stageTimeoutMs = 20 * 60 * 1000, chunkCharacters = 24000 } = {}) {
  if (!provider?.runSession) throw new Error('A model provider is required');
  if (!Number.isFinite(stageTimeoutMs) || stageTimeoutMs <= 0) throw new Error('A positive stage timeout is required');
  const documents = deal?.source_documents || [];
  if (!Array.isArray(documents)) throw new Error('Source documents must be an array');
  const ids = new Set();
  for (const doc of documents) {
    if (!doc.document_id || ids.has(String(doc.document_id)) || typeof doc.text !== 'string' || !doc.text.trim()) {
      throw new Error('Each source needs a unique document ID and extracted text');
    }
    ids.add(String(doc.document_id));
  }
  if (!documents.length) throw new Error('Attach a pitch before starting an ad hoc review');
  const policy = resolveCouncilModels(models);
  const chunks = chunkRoomDocuments(documents, { maxCharacters: chunkCharacters });
  const batches = batchRoomChunks(chunks);
  assertCompleteChunkCoverage(chunks, batches);
  const sources = documents.map(doc => ({ id: `doc-${doc.document_id}`, title: doc.filename || 'Attached document', sha256: doc.sha256 || digest(doc.text) }));
  const stages = [];
  const checkAbort = () => signal?.throwIfAborted();
  const run = async (stage, context, schema, tools, model) => {
    checkAbort();
    await onStage?.(stage);
    checkAbort();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    let timer;
    let rejectAbort;
    const interrupted = new Promise((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason || new Error('Review cancelled'));
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
      timer = setTimeout(() => controller.abort(new Error(`Ad hoc ${stage} timed out`)), stageTimeoutMs);
    });
    try {
      const result = await Promise.race([provider.runSession({
        prompt: AD_HOC_REVIEW_INSTRUCTIONS + (stage === 'research'
          ? '\nResearch the important uncertainties using web search. Return report and web_sources; use web: IDs with HTTP(S) URLs. These are model-reported sources, not independently verified receipts.'
          : '\nWork only from the supplied evidence. Preserve contradictions and missing information.'),
        context: JSON.stringify(context), systemPrompt: AD_HOC_REVIEW_INSTRUCTIONS,
        outputFormat: { type: 'json_schema', schema }, tools, model,
        maxTurns: stage === 'research' ? 20 : 8, signal: controller.signal,
      }), interrupted]);
      checkAbort();
      stages.push({ stage, result });
      return result.structuredOutput || JSON.parse(result.text);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', rejectAbort);
    }
  };
  const notes = [];
  for (const [i, batch] of batches.entries()) {
    const allowed = sources.filter(source => batch.chunks.some(chunk => source.id === `doc-${chunk.document_id}`));
    const note = await run(`room_evidence_${i + 1}`, { sources: allowed, chunks: batch.chunks }, AD_HOC_REVIEW_SCHEMA, [], policy.research);
    notes.push(validateAdHocReview(note, allowed));
  }
  const research = await run('research', { company: deal.company || deal.company_name || null, sources, notes }, researchSchema, ['WebSearch'], policy.research);
  if (!research || Object.keys(research).sort().join(',') !== 'report,web_sources'
      || !Array.isArray(research.web_sources) || research.web_sources.length > 30) throw new Error('Invalid research output');
  for (const source of research.web_sources) {
    if (!source || Object.keys(source).sort().join(',') !== 'id,title,url'
        || typeof source.id !== 'string' || !source.id.startsWith('web:')
        || typeof source.title !== 'string' || !source.title.trim()) throw new Error('Invalid web source');
    const url = new URL(source.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid web source URL');
    sources.push({ ...source, provenance: 'model_reported' });
  }
  validateAdHocReview(research.report, sources);
  const final = await run('consolidation', { sources, document_notes: notes, research: research.report }, AD_HOC_REVIEW_SCHEMA, [], policy.calibrator);
  const artifact = createAdHocReviewArtifact(final, sources);
  const usage = aggregateStageUsage(stages);
  return { artifact, usage: usage.total, stageMetrics: usage.perStage,
    provenance: { reviewMode: 'ad_hoc', inputHash: digest(documents), modelPolicy: policy,
      chunkIds: chunks.map(chunk => chunk.chunk_id), stageSessions: stages.map(({ stage, result }) => ({ stage, sessionId: result.sessionId || null })) } };
}
