#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { councilFollowupEvaluate } from './followup.js';
import { getRubric } from '../lenses/loader.js';

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function ok(value, message = 'expected truthy') { if (!value) throw new Error(message); }
function eq(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`${message ? `${message}: ` : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
async function throwsAsync(fn, message = '') {
  let error = null;
  try { await fn(); } catch (caught) { error = caught; }
  if (!error) throw new Error('expected throw');
  if (message && !error.message.includes(message)) {
    throw new Error(`threw but lacked ${JSON.stringify(message)}: ${error.message}`);
  }
}

function baseEvaluation() {
  const rubric = getRubric();
  const dimensions = rubric.sections.flatMap(section => section.dimensions || []);
  return {
    id: 41,
    round: 'Seed',
    council_policy: 'balanced',
    council_lens_hash: 'lens-hash',
    council_calibration_hash: 'calibration-hash',
    council_rubric_snapshot: rubric,
    council_dimension_scores: dimensions.map(dimension => ({
      name: dimension.name,
      likert: 3,
      rationale: `Base rationale for ${dimension.name}.`,
    })),
    council_evidence_assessments: dimensions.map(dimension => ({
      name: dimension.name,
      sufficiency: 'thin',
      rationale: `Base evidence for ${dimension.name}.`,
      missing_evidence: ['Founder confirmation'],
    })),
    raw_content: '# Deal Log: Acme\n\n## Total: 30/50',
  };
}

function founderAnswer() {
  return {
    id: 7,
    question: 'What is current net revenue retention?',
    why_it_matters: 'Retention determines whether the model compounds.',
    rubric_dimension: 'Compounding structure',
    answer: 'Net revenue retention is 142% across 19 customers.',
    answer_source: 'founder',
  };
}

function fakeProvider(output) {
  const calls = [];
  return {
    calls,
    async runSession(request) {
      calls.push(request);
      return {
        text: JSON.stringify(output),
        structuredOutput: output,
        model: request.model,
        sessionId: 'followup-session',
        apiKeySource: 'oauth',
        usage: { inputTokens: 100, outputTokens: 25, totalCostUsd: 0.01 },
      };
    },
  };
}

function validOutput() {
  return {
    dimension_updates: [{
      name: 'Compounding structure',
      quality_likert: 5,
      rationale: 'Founder-reported retention supports strong expansion dynamics.',
      evidence_sufficiency: 'partial',
      confidence: 'medium',
      missing_evidence_treatment: 'confidence_only',
      stage_cap_id: null,
      missing_evidence: ['Cohort export or customer-level retention report'],
    }],
    answer_assessments: [{
      question_id: '7',
      assessment: 'supports',
      rationale: 'The answer is directionally strong but not independently documented.',
    }],
  };
}

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'radar-founder-followup-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n  Council founder follow-up tests\n');

test('requires a frozen base evaluation, an answer, a provider, and an output directory', async () => {
  await throwsAsync(
    () => councilFollowupEvaluate({}, {}),
    'requires a base evaluation',
  );
  await throwsAsync(
    () => councilFollowupEvaluate({ baseEvaluation: baseEvaluation(), answers: [] }, {}),
    'at least one answered question',
  );
  await throwsAsync(
    () => councilFollowupEvaluate({
      baseEvaluation: baseEvaluation(),
      answers: [founderAnswer()],
      company: 'Acme',
    }, {}),
    'requires a provider',
  );
});

test('uses one retrieval-free Calibrator pass and preserves unrelated dimensions', async () =>
  withTempDir(async dealLogDir => {
    const provider = fakeProvider(validOutput());
    const result = await councilFollowupEvaluate({
      baseEvaluation: baseEvaluation(),
      answers: [founderAnswer()],
      company: 'Acme',
    }, {
      provider,
      dealLogDir,
      env: {},
    });

    eq(provider.calls.length, 1, 'one model call');
    eq(provider.calls[0].model, 'claude-sonnet-4-6');
    eq(provider.calls[0].tools.length, 0, 'no retrieval');
    eq(provider.calls[0].maxTurns, 2, 'bounded follow-up turns');
    eq(provider.calls[0].effort, 'low', 'low-effort targeted amendment');
    eq(
      provider.calls[0].outputFormat.schema.properties.dimension_updates
        .items.properties.rationale.maxLength,
      480,
      'bounded dimension rationale',
    );
    eq(
      provider.calls[0].outputFormat.schema.properties.dimension_updates
        .items.properties.missing_evidence.maxItems,
      3,
      'bounded missing evidence',
    );
    ok(provider.calls[0].prompt.startsWith('STAGE: founder_followup'));
    eq(result.provenance.runType, 'founder_followup');
    eq(result.effort, 'low');
    eq(result.provenance.parentEvaluationId, 41);
    eq(result.provenance.dimensionScores.length, 9);
    eq(
      result.provenance.dimensionScores.find(item => item.name === 'Compounding structure').likert,
      5,
    );
    eq(
      result.provenance.dimensionScores.find(item => item.name === 'Domain match').likert,
      3,
      'untouched dimension',
    );
    eq(
      result.provenance.evidenceAssessments.find(item => item.name === 'Compounding structure').sufficiency,
      'partial',
    );
    eq(result.writtenFiles.length, 1);
    const artifact = readFileSync(join(dealLogDir, result.writtenFiles[0]), 'utf8');
    ok(artifact.includes('## Founder Follow-up'));
    ok(artifact.includes('Net revenue retention is 142%'));
    ok(artifact.includes('## Evidence Confidence'));
    ok(artifact.includes('## Total: 33/50'));
  }));

test('rejects a model attempt to rescore an unrelated dimension', async () =>
  withTempDir(async dealLogDir => {
    const output = validOutput();
    output.dimension_updates[0].name = 'Team-market fit';
    const provider = fakeProvider(output);
    await throwsAsync(
      () => councilFollowupEvaluate({
        baseEvaluation: baseEvaluation(),
        answers: [founderAnswer()],
        company: 'Acme',
      }, { provider, dealLogDir, env: {} }),
      'changed an unrelated dimension',
    );
  }));

test('requires an assessment for every founder answer', async () =>
  withTempDir(async dealLogDir => {
    const output = validOutput();
    output.answer_assessments = [];
    const provider = fakeProvider(output);
    await throwsAsync(
      () => councilFollowupEvaluate({
        baseEvaluation: baseEvaluation(),
        answers: [founderAnswer()],
        company: 'Acme',
      }, { provider, dealLogDir, env: {} }),
      'assess every supplied answer',
    );
  }));

test('uses the shared policy to remove a cap without changing unrelated dimensions', async () =>
  withTempDir(async dealLogDir => {
    const base = baseEvaluation();
    base.round = 'Series A';
    base.council_dimension_scores = base.council_dimension_scores.map(choice =>
      choice.name === 'Business model clarity'
        ? {
          ...choice,
          quality_likert: 5,
          likert: 3,
          missing_evidence_treatment: 'stage_cap',
          stage_cap_id: 'series_a_actual_revenue_missing',
        }
        : choice);
    base.council_evidence_assessments = base.council_evidence_assessments.map(item =>
      item.name === 'Business model clarity'
        ? {
          ...item,
          confidence: 'low',
          score_effect: 'stage_cap',
          stage_cap_id: 'series_a_actual_revenue_missing',
        }
        : item);
    const answer = {
      id: 9,
      question: 'What actual revenue has the company generated?',
      why_it_matters: 'Series A requires actual revenue evidence.',
      rubric_dimension: 'Business model clarity',
      answer: 'The attached ledger reports $1.2M of recognized revenue.',
      answer_source: 'founder',
    };
    const provider = fakeProvider({
      dimension_updates: [{
        name: 'Business model clarity',
        quality_likert: 5,
        rationale: 'The supplied revenue ledger satisfies the named Series A requirement.',
        evidence_sufficiency: 'partial',
        confidence: 'medium',
        missing_evidence_treatment: 'confidence_only',
        stage_cap_id: null,
        missing_evidence: ['Reconcile recognized revenue to bank records'],
      }],
      answer_assessments: [{
        question_id: '9',
        assessment: 'supports',
        rationale: 'The answer supplies actual revenue evidence.',
      }],
    });
    const result = await councilFollowupEvaluate({
      baseEvaluation: base,
      answers: [answer],
      company: 'Acme',
    }, { provider, dealLogDir, env: {} });
    const businessModel = result.provenance.dimensionScores.find(
      item => item.name === 'Business model clarity',
    );
    eq(businessModel.quality_likert, 5);
    eq(businessModel.likert, 5, 'removed cap restores effective quality Likert');
    eq(result.provenance.evidenceCapReceipt.applied.length, 0);
    eq(
      result.provenance.dimensionScores.find(item => item.name === 'Domain match').likert,
      3,
      'unrelated v1 choice remains unchanged',
    );
  }));

for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (error) { console.log(`  ✗ ${name}: ${error.message}`); failed++; }
}
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
