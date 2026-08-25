#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  buildDecisionEvidencePacket,
  buildResearchRunEnvelope,
  normalizeEvidenceObservation,
  normalizeResearchTask,
  normalizeSourceReceipt,
  researchTaskId,
  researchTasksFromPlan,
  sourceReceiptsForTasks,
} from './research-evidence.js';

const plan = {
  questions: [{
    question_id: 'baseline-financing',
    required: true,
    search_queries: ['fixture funding'],
    preferred_sources: ['primary filing'],
    recency_requirement: 'current',
  }, {
    question_id: 'baseline-team',
    required: true,
    search_queries: ['fixture founder'],
  }],
};

assert.equal(
  researchTaskId('baseline-team', 'public_web'),
  researchTaskId('baseline-team', 'public_web'),
  'task identity is stable',
);
assert.throws(
  () => normalizeResearchTask({
    questionId: 'paid-only',
    capability: 'structured_company_data',
    required: true,
  }),
  error => error.code === 'CREDENTIALED_CAPABILITY_REQUIRED',
);
assert.equal(
  normalizeResearchTask({
    questionId: 'paid-only',
    capability: 'structured_company_data',
    required: false,
  }).required,
  false,
);

const financing = normalizeEvidenceObservation({
  targetId: 'baseline-financing',
  relation: 'supports',
  classification: 'verified',
  sourceClass: 'sdk_public_web',
  authority: 'primary',
  url: 'synthetic://filing',
  value: '$4M financing',
});
assert.equal(financing.targetId, 'baseline-financing');
assert.ok(financing.observationId);
assert.throws(
  () => normalizeEvidenceObservation({
    targetId: 'baseline-financing',
    relation: 'context',
    sourceClass: 'credentialed_database',
    value: 'Excellent investment',
    providerOpinion: true,
  }),
  error => error.code === 'PROVIDER_OPINION_NOT_EVIDENCE',
);
assert.throws(
  () => normalizeEvidenceObservation({
    targetId: 'baseline-financing',
    relation: 'context',
    sourceClass: 'credentialed_database',
    value: '$5M-$10M modeled revenue',
    isDerivedEstimate: true,
  }),
  /consistent or inconsistent direction/,
);

const packet = buildDecisionEvidencePacket({
  researchPlan: plan,
  observations: [financing],
  criticalUnknowns: ['Current leadership'],
  teamDossier: 'No current leadership observation was found.',
  companyContext: 'Synthetic company.',
});
assert.equal(packet.contractVersion, 1);
assert.equal(packet.questionCoverage.length, 2);
assert.equal(packet.questionCoverage[0].status, 'verified');
assert.equal(packet.questionCoverage[1].status, 'unavailable');
assert.equal(packet.researchPlan.every(task => task.required), true);

const receipts = sourceReceiptsForTasks(
  researchTasksFromPlan(plan),
  packet.observations,
  { durationMs: 24, actualCostUsd: 0.01 },
);
assert.equal(receipts[0].status, 'completed');
assert.equal(receipts[1].status, 'unavailable');
assert.equal(receipts[1].continuation, 'synthesis_without_observation');
assert.equal(
  normalizeSourceReceipt({
    taskId: 'task-failed',
    sourceClass: 'sdk_public_web',
    status: 'failed',
    continuation: 'run_failed',
  }).continuation,
  'run_failed',
);

const envelope = buildResearchRunEnvelope({
  productEdition: 'desktop',
  capabilities: ['public_web', 'supplied_documents'],
  completedResearchPasses: ['plan_and_acquire', 'reconcile_and_synthesize'],
  sourceReceipts: receipts,
  decisionPacket: packet,
});
const reordered = buildResearchRunEnvelope({
  productEdition: 'desktop',
  capabilities: ['supplied_documents', 'public_web'],
  completedResearchPasses: ['plan_and_acquire', 'reconcile_and_synthesize'],
  sourceReceipts: receipts,
  decisionPacket: packet,
});
assert.equal(envelope.toolRegistryFingerprint, reordered.toolRegistryFingerprint);
assert.equal(envelope.decisionPacket.questionCoverage[1].status, 'unavailable');

console.log('council-research-evidence: v1 packet and edition gates passed');
