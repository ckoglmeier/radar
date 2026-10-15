#!/usr/bin/env node
// Earned Equity company review: stage tables, privacy, run key, reuse, rubric
// findings, gate rules and follow-up. A fake provider only; no model calls.
// Invented companies and numbers only.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  EARNED_EQUITY_CALIBRATOR_SCHEMA,
  EARNED_EQUITY_GRADER_SCHEMA,
  EARNED_EQUITY_RESEARCH_SCHEMA,
  EARNED_EQUITY_STAGES,
  assertNoPersonalValues,
  earnedEquityCompanyReview,
  findProbabilityFields,
  finalizeBusinessGate,
  indexEvidence,
  loadEarnedEquityRubric,
  normalizeCompanyInput,
  validateCompanyFindings,
} from './earned-equity-mode.js';

const ENTITY = '3f1c2a9e-7a1b-4c53-9a3e-0d6a5f1b2c77';
const OTHER_ENTITY = '9b2d4c10-1e5f-4d77-8b0a-6c3e2f9a1d55';

// The invented offer. None of these may reach a company-review request.
const OFFER = { salary: '187342', units: '41700', strike: '0.8317', learningNote: 'Wants to learn marketplace operations' };
const PERSONAL_VALUES = [OFFER.salary, OFFER.units, OFFER.strike, OFFER.learningNote];

const company = (extra = {}) => ({
  portfolioEntityId: ENTITY, company: 'Northwind Freight Labs', stage: 'Series A', businessModel: 'marketplace',
  summary: 'Invented freight marketplace.', ...extra,
});

const EVIDENCE = [
  '[ee-demand-retention] VERIFIED | Carrier cohorts retained 91 percent of volume at month 12 | 2026-06-30 | Invented Trade Daily 2026-07-02 | https://example.invalid/retention',
  '[ee-runway-financing] SUPPLIED | Company states 31 months of runway as of 2026-09-01 | 2026-09-01 | Company letter | n/a',
  '[ee-capital-structure] UNAVAILABLE | Preference terms were not found | 2026-10-01 | Registry search | n/a',
  '[ee-growth-quality] CONFLICTING | One source says 60 percent of growth is paid; another says 20 percent | 2026-08-15 | Two reports | https://example.invalid/growth',
];
const IDX = indexEvidence(EVIDENCE);
const ctx = (extra = {}) => ({ evidence: IDX, stage: 'Series A', ...extra });

const sensitivity = (extra = {}) => ({
  kind: 'qualitative', description: 'Test a slower acquisition year.', value: null, unit: null,
  sourceEvidenceIds: [], userEstimate: false, ...extra,
});
const finding = (extra = {}) => ({
  id: 'F1', rubricRowId: 'weak_retention_unproven_demand', statement: 'Retention is strong for the carrier side.',
  evidenceIds: ['E1'], evidenceState: 'verified',
  applicability: { stage: 'series-a', businessModel: 'marketplace' },
  direction: 'strengthens', affectedAssumption: 'growth_trajectory', proposedSensitivity: sensitivity(),
  uncertainty: 'medium', counterevidence: [], confirmationState: 'proposed', ...extra,
});

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (error) {
    console.error(`FAIL  ${name}`); throw error;
  }
}
const throws = (fn, pattern) => assert.throws(fn, pattern);

// --- fake provider ---------------------------------------------------------

function researchOutput(extra = {}) {
  return {
    evidence: EVIDENCE, team_dossier: 'Invented team notes.', company_context: 'Invented company context.',
    custom_questions: [], critical_unknowns: ['Preference stack'], contradictions_to_resolve: ['Paid growth share'], ...extra,
  };
}
function gradeOutput(findings, gateView = 'supported') {
  return { findings, key_argument: 'Argument.', gate_view: gateView };
}
function calibratorOutput(overrides = {}) {
  return {
    gate_proposal: {
      status: 'supported', rationale: 'Retention evidence is strong for the stage.', deciding_finding_ids: ['F1'], unresolved_reasons: [],
    },
    findings: [finding()],
    evidence_confidence: 'medium',
    stage_cap_ids: [],
    employee_common_equity_notes: ['Preferences are not disclosed, so common payout is unresolved.'],
    questions_for_employer: [{
      question_id: 'q1', question: 'What liquidation preferences exist?', why_it_matters: 'They sit ahead of common.',
      rubric_row_id: 'preferences_or_debt_unresolved',
    }],
    net_assessment: 'Credible business; common-equity terms unknown.', ...overrides,
  };
}
function makeProvider(handlers = {}) {
  const calls = [];
  return {
    calls,
    async runSession(request) {
      const stage = /STAGE:\s*(\w+)/.exec(request.prompt)[1];
      calls.push({ stage, request });
      const handler = handlers[stage];
      const data = typeof handler === 'function' ? handler(request, calls.filter(call => call.stage === stage).length) : handler;
      if (data === undefined) throw new Error(`unexpected stage ${stage}`);
      return { structuredOutput: structuredClone(data), usage: { inputTokens: 10, outputTokens: 5, totalCostUsd: null }, sessionId: `s-${calls.length}` };
    },
  };
}
const standard = () => makeProvider({
  research: researchOutput(),
  bull: gradeOutput([finding()]),
  bear: gradeOutput([finding({ id: 'B1', rubricRowId: 'preferences_or_debt_unresolved', evidenceIds: ['E3'], evidenceState: 'unavailable', direction: 'unknown', affectedAssumption: 'common_payout' })], 'unresolved'),
  company_calibrator: calibratorOutput({
    findings: [
      finding(),
      finding({ id: 'F2', rubricRowId: 'preferences_or_debt_unresolved', evidenceIds: ['E3'], evidenceState: 'unavailable', direction: 'unknown', affectedAssumption: 'common_payout' }),
    ],
  }),
});
const review = (input, provider, extra = {}) => earnedEquityCompanyReview(input, { provider, env: {}, ...extra });

console.log('Earned Equity company review');

await test('schemas and rubric carry no probability field', () => {
  for (const schema of [EARNED_EQUITY_RESEARCH_SCHEMA, EARNED_EQUITY_GRADER_SCHEMA, EARNED_EQUITY_CALIBRATOR_SCHEMA, loadEarnedEquityRubric()]) {
    assert.deepEqual(findProbabilityFields(JSON.parse(JSON.stringify(schema))), []);
  }
  assert.deepEqual(findProbabilityFields({ a: { exit_probability: 1 } }), ['.a.exit_probability']);
  assert.ok(findProbabilityFields({ note: 'A 30% chance of exit' }).length);
});

await test('stages are research, bull, bear, calibrator; no CFO; no angel context', async () => {
  assert.deepEqual(EARNED_EQUITY_STAGES, ['research', 'bull', 'bear', 'calibrator']);
  const provider = standard();
  const stages = [];
  const result = await review(company(), provider, { onStage: stage => stages.push(stage), personalValues: PERSONAL_VALUES });
  assert.deepEqual(provider.calls.map(call => call.stage).sort(), ['bear', 'bull', 'company_calibrator', 'research']);
  assert.ok(!provider.calls.some(call => /cfo/i.test(call.stage)));
  assert.deepEqual(stages, ['research', 'bull_bear', 'calibrator', 'finalizing']);
  assert.deepEqual(provider.calls.find(call => call.stage === 'research').request.tools, ['WebSearch']);
  assert.ok(provider.calls.filter(call => call.stage !== 'research').every(call => call.request.tools.length === 0));
  const banned = /gpTiers|gp tiers|check size|check_size|syndicate|portfolio fit|portfolio construction|sizing|round params|calibration \(how/i;
  for (const { request } of provider.calls) {
    for (const field of ['prompt', 'systemPrompt', 'context']) {
      assert.doesNotMatch(String(request[field]), banned, `${field} of a request carries angel text`);
    }
  }
  assert.equal(result.review.gate.status, 'supported');
  assert.equal(result.review.reviewMode, 'earned_equity_company');
  assert.deepEqual(findProbabilityFields(result.review), []);
  assert.equal(result.usage.inputTokens, 40);
});

await test('company-review input and every request contain none of the offer values', async () => {
  const provider = standard();
  await review(company(), provider, { personalValues: PERSONAL_VALUES });
  for (const { request } of provider.calls) {
    const text = JSON.stringify(request);
    for (const value of PERSONAL_VALUES) assert.ok(!text.includes(value), `request carries ${value}`);
  }
  const dry = await earnedEquityCompanyReview(company(), { dryRun: true, env: {}, personalValues: PERSONAL_VALUES });
  for (const request of Object.values(dry.requests)) {
    for (const value of PERSONAL_VALUES) assert.ok(!JSON.stringify(request).includes(value));
  }
  // The input is whitelisted: personal fields cannot be passed at all.
  for (const key of ['salary', 'offer', 'grant', 'units', 'strike', 'notes', 'learningNote', 'checkSize']) {
    assert.throws(() => normalizeCompanyInput({ ...company(), [key]: OFFER.salary }), e => e.code === 'PERSONAL_FIELD_REJECTED');
  }
  assert.throws(() => normalizeCompanyInput(company({ sourceDocuments: [{ document_id: 1, filename: 'offer.pdf', text: 'x', scope: 'personal' }] })),
    e => e.code === 'PERSONAL_DOCUMENT_REJECTED');
  assert.throws(() => normalizeCompanyInput(company({ sourceDocuments: [{ document_id: 1, filename: 'a.txt', text: 'x' }] })),
    e => e.code === 'PERSONAL_DOCUMENT_REJECTED');
  // Defence in depth: a personal value that slipped into company text is blocked before any call.
  const leaky = standard();
  await assert.rejects(review(company({ summary: `Pays ${OFFER.salary}` }), leaky, { personalValues: PERSONAL_VALUES }),
    e => e.code === 'PERSONAL_VALUE_IN_COMPANY_INPUT');
  assert.equal(leaky.calls.length, 0);
  assert.throws(() => assertNoPersonalValues({ context: `strike ${OFFER.strike}` }, PERSONAL_VALUES), /personal offer value/);
});

await test('company documents are sent when company-scoped', async () => {
  const provider = standard();
  await review(company({ sourceDocuments: [{ document_id: 7, filename: 'update.txt', sha256: 'a'.repeat(64), text: 'Invented investor update body.', scope: 'company' }] }), provider);
  assert.match(provider.calls[0].request.context, /Invented investor update body\./);
});

await test('run key changes with lens version, manifest, policy version and entity; stable otherwise', async () => {
  const key = async (input = company(), extra = {}) => (await earnedEquityCompanyReview(input, { dryRun: true, env: {}, ...extra })).provenance.runKey;
  const base = await key();
  assert.equal(await key(), base, 'stable for identical input');
  assert.equal(await key(company(), { personalValues: PERSONAL_VALUES }), base, 'personal values never enter the key');
  assert.notEqual(await key(company(), { lensVersion: 2 }), base);
  assert.notEqual(await key(company(), { sourceManifest: [{ sha256: 'b'.repeat(64) }] }), base);
  assert.notEqual(await key(company(), { policyVersion: 99 }), base);
  assert.notEqual(await key(company({ portfolioEntityId: OTHER_ENTITY })), base);
  assert.notEqual(await key(company(), { models: { calibrator: 'other-model' } }), base);
  assert.notEqual(await key(company(), { reviewKind: 'refresh' }), base);
  assert.match(base, /^[0-9a-f]{64}$/);
});

await test('reuse returns the completed review without provider calls', async () => {
  const stored = { id: 'rev-1', artifact: { reviewMode: 'earned_equity_company', gate: { status: 'supported' } } };
  let asked;
  const provider = makeProvider({});
  const result = await earnedEquityCompanyReview(company(), {
    provider, env: {}, findExisting: async runKey => { asked = runKey; return stored; },
  });
  assert.equal(result.reused, true);
  assert.equal(result.reviewId, 'rev-1');
  assert.equal(result.review, stored.artifact);
  assert.equal(asked, result.provenance.runKey);
  assert.equal(provider.calls.length, 0);
});

await test('in-flight duplicate joins the running review', async () => {
  const provider = standard();
  const [a, b] = await Promise.all([review(company(), provider), review(company(), provider)]);
  assert.equal(provider.calls.length, 4);
  assert.equal(b.reusedInFlight || a.reusedInFlight, true);
});

await test('rubric: findings validate and carry their economic question', () => {
  const [validated] = validateCompanyFindings([finding()], ctx());
  assert.match(validated.economicQuestion, /retention improvement/);
  throws(() => validateCompanyFindings([finding({ rubricRowId: 'made_up' })], ctx()), /unknown rubric row/);
  throws(() => validateCompanyFindings([finding({ evidenceIds: ['E99'] })], ctx()), /unknown evidence/);
  throws(() => validateCompanyFindings([finding(), finding()], ctx()), /repeated/);
  throws(() => validateCompanyFindings([finding({ confirmationState: 'confirmed' })], ctx()), /only propose/);
  throws(() => validateCompanyFindings([finding({ evidenceIds: [], evidenceState: 'verified' })], ctx()), /must cite evidence/);
  // The stage must agree with the company stage, and the row must apply to it.
  throws(() => validateCompanyFindings([finding({ applicability: { stage: 'seed', businessModel: 'marketplace' } })], ctx()), /disagrees with the company stage/);
  throws(() => validateCompanyFindings([finding({ rubricRowId: 'early_stage_no_operating_history', evidenceState: 'unavailable', evidenceIds: [], direction: 'unknown' })], ctx()), /does not apply to stage/);
});

await test('rubric: weak evidence cannot produce a numeric assumption without a source or user-estimate flag', () => {
  const numeric = extra => finding({
    rubricRowId: 'short_runway_high_burn', affectedAssumption: 'financing_need',
    proposedSensitivity: sensitivity({ kind: 'numeric', description: 'Raise needed', value: '4000000', unit: 'usd', ...extra }),
  });
  // Cited, supplied evidence: allowed.
  validateCompanyFindings([numeric({ sourceEvidenceIds: ['E2'] }) && finding({ ...numeric({ sourceEvidenceIds: ['E2'] }), evidenceIds: ['E2'], evidenceState: 'supplied', direction: 'weakens' })], ctx());
  // No source.
  throws(() => validateCompanyFindings([numeric({ sourceEvidenceIds: [] })], ctx()), /cited supplied or verified evidence/);
  // Source is unavailable or conflicting evidence.
  assert.equal(validateCompanyFindings([finding({ ...numeric({ sourceEvidenceIds: ['E3'] }), evidenceIds: ['E3'], evidenceState: 'unavailable', direction: 'unknown' })], ctx())[0].proposedSensitivity.kind, 'qualitative', 'unavailable evidence drops the number');
  throws(() => validateCompanyFindings([finding({ ...numeric({ sourceEvidenceIds: ['E4'] }), evidenceIds: ['E4'], evidenceState: 'conflicting', direction: 'weakens', counterevidence: ['other report'] })], ctx()), /cited supplied or verified/);
  // A model may not set the user-estimate flag; only a user-supplied value may.
  throws(() => validateCompanyFindings([numeric({ userEstimate: true })], ctx()), /user-estimate flag/);
  validateCompanyFindings([numeric({ userEstimate: true })], ctx({ allowUserEstimate: true }));
  // Non-numeric sensitivities carry no value or flag.
  throws(() => validateCompanyFindings([finding({ proposedSensitivity: sensitivity({ value: '5' }) })], ctx()), /only a numeric sensitivity/);
  throws(() => validateCompanyFindings([numeric({ value: 'four million', sourceEvidenceIds: ['E2'] })], ctx()), /decimal value/);
});

await test('rubric: contradictory evidence is recorded, not resolved by assertion', () => {
  const conflicted = extra => finding({
    id: 'C1', rubricRowId: 'paid_channel_dependent_growth', evidenceIds: ['E4'], evidenceState: 'conflicting',
    direction: 'weakens', affectedAssumption: 'financing_need', ...extra,
  });
  throws(() => validateCompanyFindings([conflicted()], ctx()), /counterevidence/);
  const [ok] = validateCompanyFindings([conflicted({ counterevidence: ['A second report puts paid growth at 20 percent.'] })], ctx());
  assert.equal(ok.evidenceState, 'conflicting');
  // A failed gate cannot rest on conflicting evidence: it becomes investigate.
  const gate = finalizeBusinessGate({
    proposal: { status: 'failed', rationale: 'Growth is paid.', deciding_finding_ids: ['C1'], unresolved_reasons: [] },
    findings: [ok], evidenceConfidence: 'medium',
  });
  assert.equal(gate.status, 'unresolved');
  assert.equal(gate.presentation, 'investigate');
  assert.equal(gate.modelProposed, 'failed');
  assert.equal(gate.adjustments[0].code, 'failed_requires_sufficient_evidence');
});

await test('rubric: missing evidence stays unknown and keeps the gate unresolved', () => {
  // Unavailable evidence with a direction is normalized, never rejected.
  const norm = [];
  const [fixed] = validateCompanyFindings([finding({ evidenceIds: [], evidenceState: 'unavailable', direction: 'weakens',
    proposedSensitivity: sensitivity({ kind: 'numeric', value: '5', unit: 'usd' }) })], ctx({ normalized: norm }));
  assert.equal(fixed.direction, 'unknown');
  assert.equal(fixed.proposedSensitivity.kind, 'qualitative');
  assert.deepEqual(norm.map(item => [item.field, item.from, item.to]), [['direction', 'weakens', 'unknown'], ['proposedSensitivity', 'numeric', 'qualitative']]);
  const [missing] = validateCompanyFindings([finding({
    id: 'M1', rubricRowId: 'preferences_or_debt_unresolved', evidenceIds: ['E3'], evidenceState: 'unavailable', direction: 'unknown', affectedAssumption: 'common_payout',
  })], ctx());
  assert.equal(missing.withholdDefinitiveCommonPayout, true);
  const gate = finalizeBusinessGate({
    proposal: { status: 'failed', rationale: 'No terms.', deciding_finding_ids: ['M1'], unresolved_reasons: [] },
    findings: [missing], evidenceConfidence: 'low',
  });
  assert.equal(gate.status, 'unresolved');
  // Supported needs positive supplied or verified evidence.
  const unsupported = finalizeBusinessGate({
    proposal: { status: 'supported', rationale: 'Feels strong.', deciding_finding_ids: ['M1'], unresolved_reasons: [] },
    findings: [missing], evidenceConfidence: 'medium',
  });
  assert.equal(unsupported.status, 'unresolved');
  assert.equal(unsupported.adjustments[0].code, 'no_supporting_evidence');
});

await test('strong business with a poor package stays supported; the company review never sees the package', async () => {
  const provider = standard();
  const result = await review(company(), provider, { personalValues: PERSONAL_VALUES });
  assert.equal(result.review.gate.status, 'supported');
  // The demanding valuation shows up as a common-equity finding, not as a reason to fail the business.
  const valuation = validateCompanyFindings([finding({
    id: 'V1', rubricRowId: 'strong_business_demanding_valuation', evidenceIds: ['E2'], evidenceState: 'supplied', direction: 'weakens', affectedAssumption: 'common_payout',
  })], ctx());
  const gate = finalizeBusinessGate({
    proposal: { status: 'supported', rationale: 'Strong business.', deciding_finding_ids: ['F1'], unresolved_reasons: [] },
    findings: [finding(), ...valuation], evidenceConfidence: 'high',
  });
  assert.equal(gate.status, 'supported');
  assert.equal(result.review.withholdDefinitiveCommonPayout, true, 'unresolved preferences withhold a definitive payout');
});

await test('weak business with a large grant: the business gate fails on evidence, whatever the grant', async () => {
  const weak = finding({
    id: 'W1', rubricRowId: 'weak_contribution_economics', evidenceIds: ['E2'], evidenceState: 'supplied',
    direction: 'weakens', affectedAssumption: 'dilution', uncertainty: 'low',
  });
  const provider = makeProvider({
    research: researchOutput(),
    bull: gradeOutput([weak], 'unresolved'),
    bear: gradeOutput([weak], 'failed'),
    company_calibrator: calibratorOutput({
      gate_proposal: { status: 'failed', rationale: 'Economics are weak on supplied evidence.', deciding_finding_ids: ['W1'], unresolved_reasons: [] },
      findings: [weak], evidence_confidence: 'high',
    }),
  });
  const result = await review(company(), provider, { personalValues: [...PERSONAL_VALUES, '9999999'] });
  assert.equal(result.review.gate.status, 'failed');
  assert.equal(result.review.gate.presentation, 'failed');
  for (const { request } of provider.calls) assert.ok(!JSON.stringify(request).includes('9999999'));
});

await test('stage caps are reused: an unmet cap blocks supported', async () => {
  const provider = makeProvider({
    research: researchOutput(), bull: gradeOutput([finding()]), bear: gradeOutput([finding()]),
    company_calibrator: calibratorOutput({ stage_cap_ids: ['series_a_actual_revenue_missing'] }),
  });
  const result = await review(company(), provider);
  assert.equal(result.review.gate.status, 'unresolved');
  assert.deepEqual(result.review.stageCapIds, ['series_a_actual_revenue_missing']);
  assert.match(provider.calls.find(call => call.stage === 'company_calibrator').request.context, /series_a_actual_revenue_missing/);
  // An unknown cap id is rejected, and a seed-stage company has no valid caps.
  const bad = makeProvider({
    research: researchOutput(), bull: gradeOutput([finding()]), bear: gradeOutput([finding()]),
    company_calibrator: calibratorOutput({ stage_cap_ids: ['invented_cap'] }),
  });
  await assert.rejects(review(company(), bad), /Unknown stage cap/);
});

await test('an invalid stage output is repaired once; probability output is refused', async () => {
  const noSource = finding({
    rubricRowId: 'short_runway_high_burn', affectedAssumption: 'financing_need', evidenceIds: ['E2'], evidenceState: 'supplied', direction: 'weakens',
    proposedSensitivity: sensitivity({ kind: 'numeric', value: '2500000', unit: 'usd' }),
  });
  const provider = makeProvider({
    research: researchOutput(),
    bull: (_request, n) => gradeOutput([n === 1 ? noSource : finding()]),
    bear: gradeOutput([finding()]),
    company_calibrator: calibratorOutput(),
  });
  const result = await review(company(), provider);
  const bullCalls = provider.calls.filter(call => call.stage === 'bull');
  assert.equal(bullCalls.length, 2);
  assert.match(bullCalls[1].request.prompt, /REPAIR REQUIRED/);
  assert.match(bullCalls[1].request.prompt, /cited supplied or verified evidence/);
  assert.doesNotMatch(bullCalls[1].request.prompt, /rubric dimension/i);
  assert.equal(result.usage.inputTokens, 50, 'rejected attempt usage is counted');

  const probabilistic = makeProvider({
    research: researchOutput(), bull: gradeOutput([finding()]), bear: gradeOutput([finding()]),
    company_calibrator: { ...calibratorOutput(), exit_probability: 0.3 },
  });
  await assert.rejects(review(company(), probabilistic), /Probability fields/);
});

await test('follow-up: employer answers create a new linked review from frozen research; the parent is untouched', async () => {
  const first = await review(company(), standard());
  const parent = { id: 'rev-parent', artifact: first.review };
  const snapshot = JSON.stringify(parent);
  const provider = makeProvider({
    bull: gradeOutput([finding()]), bear: gradeOutput([finding()]),
    company_calibrator: (request) => {
      assert.match(request.context, /followup:q1/);
      return calibratorOutput();
    },
  });
  const answers = [{ questionId: 'q1', answer: 'One-times non-participating preferred, no debt.' }];
  const followup = await review(company(), provider, { reviewKind: 'followup', parentReviewId: 'rev-parent', followup: { parent, answers } });
  assert.ok(!provider.calls.some(call => call.stage === 'research'), 'follow-up does not repeat web research');
  assert.equal(followup.review.reviewKind, 'followup');
  assert.equal(followup.review.provenance.parentReviewId, 'rev-parent');
  assert.equal(followup.review.research.evidence.length, first.review.research.evidence.length + 1);
  assert.deepEqual(followup.review.research.evidence.slice(0, 4).map(item => item.id), ['E1', 'E2', 'E3', 'E4'], 'earlier evidence IDs do not move');
  assert.notEqual(followup.provenance.runKey, first.provenance.runKey);
  assert.equal(JSON.stringify(parent), snapshot, 'the parent artifact is unchanged');
  await assert.rejects(review(company(), standard(), { reviewKind: 'followup' }), /follow-up review needs/);
  await assert.rejects(review(company(), standard(), { parentReviewId: 'x' }), /Only a follow-up/);
});

await test('unavailable-evidence weakens finding completes, normalized and recorded; other rules still reject', async () => {
  const bad = finding({ id: 'F4', rubricRowId: 'preferences_or_debt_unresolved', evidenceIds: ['E3'], evidenceState: 'unavailable',
    direction: 'weakens', affectedAssumption: 'common_payout' });
  const provider = makeProvider({
    research: researchOutput(), bull: gradeOutput([finding()]), bear: gradeOutput([bad], 'unresolved'),
    company_calibrator: calibratorOutput({ findings: [finding(), bad] }),
  });
  const result = await review(company(), provider);
  assert.equal(provider.calls.filter(call => call.stage === 'bear').length, 1, 'no repair needed');
  const record = result.review.provenance.normalizedFindings;
  assert.deepEqual(record.map(item => [item.findingId, item.field, item.from, item.to]), [['F4', 'direction', 'weakens', 'unknown']]);
  assert.ok(record[0].reason);
  assert.equal(result.review.findings.find(item => item.id === 'F4').direction, 'unknown');
  assert.equal(result.review.normalizedFindingCount, 1);
  // Everything else is still a hard rejection.
  const rejects = async (out, pattern) => assert.rejects(review(company(), makeProvider({
    research: researchOutput(), bull: gradeOutput(out), bear: gradeOutput([finding()]), company_calibrator: calibratorOutput(),
  })), pattern);
  await rejects([finding({ evidenceIds: ['E99'] })], /unknown evidence/);
  await rejects([finding({ applicability: { stage: 'seed', businessModel: 'marketplace' } })], /company stage/);
  await rejects([finding({ statement: 'There is a 30% chance of exit.' })].map(f => ({ ...f, probability: 0.3 })), /./);
});

await test('the repair note and stage prompts state every validator rule', async () => {
  const provider = makeProvider({
    research: researchOutput(),
    bull: (_r, n) => gradeOutput([n === 1 ? finding({ evidenceIds: ['E99'] }) : finding()]),
    bear: gradeOutput([finding()]), company_calibrator: calibratorOutput(),
  });
  await review(company(), provider);
  const repair = provider.calls.filter(call => call.stage === 'bull')[1].request.prompt;
  for (const rule of [/unavailable must use direction unknown/, /conflicting evidence must list the counterevidence/, /only evidence IDs/, /applicability\.stage must equal the company stage/,
    /rubric row IDs and affected assumptions/, /numeric sensitivity needs/, /no probabilities/i, /confirmationState is always proposed/]) assert.match(repair, rule);
  for (const call of provider.calls.filter(item => item.stage !== 'research')) {
    assert.match(call.request.prompt, /unavailable evidence must use direction unknown/);
    assert.match(call.request.systemPrompt, /Rules Radar enforces/);
  }
});

console.log(`Earned Equity company review: ${passed} checks passed`);
