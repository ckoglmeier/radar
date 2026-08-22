#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  applyEvidencePolicy,
  capsForStage,
  normalizeCouncilStage,
  normalizeHistoricalChoice,
} from './evidence-policy.js';

function choice(overrides = {}) {
  return {
    name: 'Business model clarity',
    quality_likert: 5,
    rationale: 'The substantive facts satisfy the stage-adjusted anchor.',
    missing_evidence_treatment: 'confidence_only',
    stage_cap_id: null,
    ...overrides,
  };
}

function assessment(overrides = {}) {
  return {
    name: 'Business model clarity',
    sufficiency: 'partial',
    confidence: 'medium',
    score_effect: 'confidence_only',
    stage_cap_id: null,
    rationale: 'A material measurement remains open.',
    missing_evidence: ['Current measurement'],
    ...overrides,
  };
}

function apply(stage, dimensionChoice = choice(), evidenceAssessment = assessment()) {
  return applyEvidencePolicy({
    stage,
    dimensionChoices: [dimensionChoice],
    evidenceAssessments: [evidenceAssessment],
  });
}

assert.equal(normalizeCouncilStage('Pre Seed'), 'pre-seed');
assert.equal(normalizeCouncilStage('Seed+'), 'seed');
assert.equal(normalizeCouncilStage('Series B+'), 'series-b-plus');
assert.equal(normalizeCouncilStage('Series D'), 'series-b-plus');

// Seed private founder evidence with no public corroboration is confidence-only.
let result = apply('Seed', choice({ name: 'Team-market fit' }), assessment({ name: 'Team-market fit' }));
assert.equal(result.dimensionChoices[0].likert, 5);
assert.deepEqual(result.capReceipt.applied, []);

// Seed missing margins or unit economics never activates a v9 cap.
result = apply('Seed');
assert.equal(result.dimensionChoices[0].likert, 5);
assert.equal(capsForStage('Seed').length, 0);

// Series A missing actual revenue is capped at 3.
result = apply(
  'Series A',
  choice({ missing_evidence_treatment: 'stage_cap', stage_cap_id: 'series_a_actual_revenue_missing' }),
  assessment({ score_effect: 'stage_cap', stage_cap_id: 'series_a_actual_revenue_missing' }),
);
assert.equal(result.dimensionChoices[0].quality_likert, 5);
assert.equal(result.dimensionChoices[0].likert, 3);
assert.equal(result.capReceipt.applied[0].configured_cap, 3);

// Series B and later missing proven unit economics is capped at 1.
result = apply(
  'Series C',
  choice({ missing_evidence_treatment: 'stage_cap', stage_cap_id: 'series_b_unit_economics_missing' }),
  assessment({ score_effect: 'stage_cap', stage_cap_id: 'series_b_unit_economics_missing' }),
);
assert.equal(result.dimensionChoices[0].likert, 1);

for (const [label, stage, dimensionChoice, evidenceAssessment] of [
  ['unknown cap', 'Series A', choice({ missing_evidence_treatment: 'stage_cap', stage_cap_id: 'invented_cap' }), assessment({ score_effect: 'stage_cap', stage_cap_id: 'invented_cap' })],
  ['wrong stage', 'Seed', choice({ missing_evidence_treatment: 'stage_cap', stage_cap_id: 'series_a_actual_revenue_missing' }), assessment({ score_effect: 'stage_cap', stage_cap_id: 'series_a_actual_revenue_missing' })],
  ['wrong dimension', 'Series A', choice({ name: 'Capital efficiency', missing_evidence_treatment: 'stage_cap', stage_cap_id: 'series_a_actual_revenue_missing' }), assessment({ name: 'Capital efficiency', score_effect: 'stage_cap', stage_cap_id: 'series_a_actual_revenue_missing' })],
  ['source leakage', 'Series A', choice({ name: 'Source quality', missing_evidence_treatment: 'stage_cap', stage_cap_id: 'series_a_actual_revenue_missing' }), assessment({ name: 'Source quality', score_effect: 'stage_cap', stage_cap_id: 'series_a_actual_revenue_missing' })],
]) {
  assert.throws(() => apply(stage, dimensionChoice, evidenceAssessment), { message: new RegExp(label === 'unknown cap' ? 'Unknown stage cap' : 'does not apply') });
}

// Supplied/private and verified/public evidence produce the same effective score.
const privateResult = apply('Seed', choice(), assessment({ confidence: 'medium' }));
const verifiedResult = apply('Seed', choice(), assessment({ sufficiency: 'strong', confidence: 'high', missing_evidence: [] }));
assert.equal(privateResult.dimensionChoices[0].likert, verifiedResult.dimensionChoices[0].likert);

// A contradiction changes the quality judgment itself, never via an absence cap.
result = apply(
  'Seed',
  choice({ quality_likert: 2, rationale: 'Same-event evidence explicitly conflicts.', missing_evidence_treatment: 'none' }),
  assessment({ confidence: 'high', score_effect: 'none', rationale: 'The conflict is documented.', missing_evidence: [] }),
);
assert.equal(result.dimensionChoices[0].quality_likert, 2);
assert.equal(result.dimensionChoices[0].likert, 2);
assert.deepEqual(result.capReceipt.applied, []);

// v1/v8 choices remain readable without recalculation.
assert.deepEqual(
  normalizeHistoricalChoice({ name: 'Domain match', likert: 4, rationale: 'Saved v8 choice.' }),
  {
    name: 'Domain match',
    likert: 4,
    quality_likert: 4,
    rationale: 'Saved v8 choice.',
    missing_evidence_treatment: 'confidence_only',
    stage_cap_id: null,
  },
);

console.log('council-evidence-policy: 8 policy invariants passed');
