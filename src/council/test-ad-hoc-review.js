import assert from 'node:assert/strict';
import { createAdHocReviewArtifact, validateAdHocReview } from './ad-hoc-review.js';

const sources = [{ id: 'pitch:1', title: 'Synthetic pitch' }, { id: 'web:1', title: 'Synthetic independent source' }];
const claim = { text: 'The company reports early customers.', evidence: 'source_claim', source_ids: ['pitch:1'] };
const report = { company: 'Synthetic Company', summary: claim, strengths: [claim], risks: [], open_questions: ['Can customers confirm renewal?'], deal_terms: [] };
const artifact = createAdHocReviewArtifact(report, sources);
assert.equal(artifact.review_mode, 'ad_hoc');
assert.deepEqual(artifact.report, report);
artifact.report.summary.text = 'Changed';
assert.equal(report.summary.text, claim.text);
for (const field of ['score', 'total_score', 'primary_thesis', 'recommended_check', 'verdict']) {
  assert.throws(() => validateAdHocReview({ ...report, [field]: 0 }, sources), /unexpected/);
}
for (const invalid of [
  { ...claim, source_ids: ['invented'] },
  { ...claim, source_ids: [] },
  { ...claim, source_ids: ['pitch:1', 'pitch:1'] },
  { ...claim, evidence: 'corroborated' },
  { ...claim, evidence: 'verified' },
  { ...claim, text: ' ' },
  { ...claim, score: 45 },
]) assert.throws(() => validateAdHocReview({ ...report, summary: invalid }, sources));
assert.doesNotThrow(() => validateAdHocReview({ ...report, summary: { ...claim, evidence: 'corroborated', source_ids: ['pitch:1', 'web:1'] } }, sources));
assert.doesNotThrow(() => validateAdHocReview({ ...report, strengths: [], summary: { text: 'Not established.', evidence: 'unknown', source_ids: [] } }, []));
assert.throws(() => validateAdHocReview(report, [sources[0], sources[0]]), /Duplicate/);
assert.throws(() => validateAdHocReview({ ...report, open_questions: [''] }, sources));
console.log('Ad hoc review contract: valid reports, citation checks, and scored-output rejection passed');
