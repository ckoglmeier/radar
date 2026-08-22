import assert from 'node:assert/strict';
import {
  compactReplayComparison,
  renderReplayComparisonMarkdown,
  replayHash,
  validateReplayBundle,
} from './controlled-replay.js';

function replayCase(company) {
  const entry = {
    company,
    deal: { company, round: 'Seed' },
    planner_snapshot: { deal_identity: company },
    research_snapshot: { evidence: [`supplied | ${company} fact`] },
    calibration_snapshot: { maturity: 'frozen' },
    lens_snapshot: { rubric: { total_points: 50 } },
    source_manifest: [],
    v8: {
      policy_version: 8,
      total: 30,
      verdict: 'Defer',
      dimensions: { 'Domain match': 3 },
      confidence: { 'Domain match': 'low' },
    },
  };
  entry.frozen_hashes = {
    deal: replayHash(entry.deal),
    planner: replayHash(entry.planner_snapshot),
    research: replayHash(entry.research_snapshot),
    calibration: replayHash(entry.calibration_snapshot),
    lens: replayHash(entry.lens_snapshot),
    source_manifest: replayHash(entry.source_manifest),
  };
  return entry;
}

const bundle = {
  cases: ['Sourcerer', 'Standard Bots', 'Saturn Dynamics'].map(replayCase),
};
assert.equal(validateReplayBundle(bundle).length, 3);
const comparison = compactReplayComparison(bundle.cases[0], {
  total: 32,
  verdict: 'Defer',
  dimensions: { 'Domain match': 4 },
  confidence: { 'Domain match': 'medium' },
  evidence_assessments: [{ name: 'Domain match', confidence: 'medium', score_effect: 'confidence_only' }],
  caps: [],
  review_gates: { 'fixture gate': true },
});
assert.equal(comparison.total_delta, 2);
assert.equal(comparison.dimensions[0].delta, 1);
assert.equal(comparison.dimensions[0].attribution, 'evidence_policy');
assert.match(renderReplayComparisonMarkdown([comparison]), /Evidence hashes match: \*\*yes\*\*/);
const changed = structuredClone(bundle);
changed.cases[0].research_snapshot.evidence.push('changed');
assert.throws(() => validateReplayBundle(changed), /frozen research hash does not match/);
console.log('controlled-replay: bundle validation and comparison artifact passed');
