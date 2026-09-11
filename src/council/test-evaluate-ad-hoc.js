import assert from 'node:assert/strict';
import { evaluateAdHoc } from './evaluate-ad-hoc.js';
const report = { company: 'Synthetic', summary: { text: 'The pitch describes a product.', evidence: 'source_claim', source_ids: ['doc-1'] }, strengths: [], risks: [], open_questions: ['Who pays?'], deal_terms: [] };
const deal = { source_documents: [{ document_id: 1, filename: 'pitch.txt', text: 'A synthetic product pitch. '.repeat(200) }] };
const calls = [];
const provider = { async runSession(req) {
  calls.push(req);
  return { structuredOutput: req.tools.length ? { report, web_sources: [] } : report, usage: { inputTokens: 10, outputTokens: 5, totalCostUsd: null }, sessionId: `test-${calls.length}` };
} };
const stages = [];
const result = await evaluateAdHoc(deal, { provider, onStage: stage => stages.push(stage), chunkCharacters: 2000 });
assert.deepEqual(stages, ['room_evidence_1', 'research', 'consolidation']);
assert.equal(result.provenance.chunkIds.length, 3);
assert.equal(result.artifact.review_mode, 'ad_hoc');
assert.equal(result.usage.inputTokens, 30);
assert.equal(result.usage.totalCostUsd, null);
assert.deepEqual(calls.map(call => call.tools), [[], ['WebSearch'], []]);
assert.ok(calls.every(call => !call.skills && !call.agents));
assert.ok(calls.every(call => !call.context.includes('risk_capital')));
assert.equal(result.stageMetrics.length, 3);
for (const identity of [{ company: 'App Company' }, { company_name: 'Engine Company' }]) {
  const offset = calls.length;
  await evaluateAdHoc({ ...deal, ...identity }, { provider });
  const researchCall = calls.slice(offset).find(call => call.tools.includes('WebSearch'));
  assert.equal(JSON.parse(researchCall.context).company, identity.company || identity.company_name);
}
await assert.rejects(evaluateAdHoc({ source_documents: [] }, { provider }), /Attach a pitch/);
await assert.rejects(evaluateAdHoc({ source_documents: [deal.source_documents[0], deal.source_documents[0]] }, { provider }), /unique/);
await assert.rejects(evaluateAdHoc(deal, { provider: { runSession: async () => ({ structuredOutput: { ...report, score: 45 } }) } }), /unexpected/);
const cancelled = new AbortController();
cancelled.abort(new Error('Cancelled test'));
const before = calls.length;
await assert.rejects(evaluateAdHoc(deal, { provider, signal: cancelled.signal }), /Cancelled test/);
assert.equal(calls.length, before);
await assert.rejects(evaluateAdHoc(deal, { stageTimeoutMs: 10, provider: { runSession: () => new Promise(() => {}) } }), /timed out/);
const midway = new AbortController();
await assert.rejects(evaluateAdHoc(deal, { provider, signal: midway.signal, onStage(stage) { if (stage === 'research') midway.abort(new Error('Stop before research')); } }), /Stop before research/);
console.log('Ad hoc runner: chunk coverage, research/consolidation, usage, invalid output, cancellation, and timeout passed');
