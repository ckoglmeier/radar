#!/usr/bin/env node

// Tests for councilEvaluate() (B1). The provider is faked — no real SDK — so
// these assert that each Council stage is actually executed, shares one frozen
// evidence packet, and leaves scoring/file output to Radar.
// getCalibration() needs a DB, so run under a scratch PGlite (test:local).
// Run: DATABASE_URL=file:./.radar-test-local node src/council/test-evaluate.js

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  councilEvaluate,
  assembleContext,
  buildBaselineResearchPlan,
  buildCouncilAgents,
} from './evaluate.js';
import { loadLens, withLens } from '../lenses/loader.js';
import { resolveCouncilModels } from '../providers/council-models.js';
import { importDealLogs } from '../models/evaluations.js';
import { query } from '../db/index.js';

const TEMPLATE_LENS = loadLens(join(
  dirname(fileURLToPath(String(import.meta.url))),
  '..',
  '..',
  'lenses',
  '_template',
));

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function ok(v, msg = 'expected truthy') { if (!v) throw new Error(msg); }
function eq(a, b, msg = '') { if (a !== b) throw new Error(`${msg ? msg + ': ' : ''}expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function throwsAsync(fn, m = '') {
  let threw = false;
  try { await fn(); } catch (e) { threw = true; if (m && !e.message.includes(m)) throw new Error(`threw but lacked ${JSON.stringify(m)}: ${e.message}`); }
  if (!threw) throw new Error('expected throw');
}

const DIMENSIONS = [
  'Domain match',
  'Compounding structure',
  'Structural tailwind',
  'Portfolio construction fit',
  'Team-market fit',
  'Capital efficiency',
  'Business model clarity',
  'Differentiation',
  'Source quality',
];

function dimensionScores(likert) {
  return DIMENSIONS.map(name => ({ name, likert, rationale: `${name} rationale` }));
}

function evidenceAssessments() {
  return DIMENSIONS.map((name, index) => ({
    name,
    sufficiency: index === 0 ? 'thin' : 'strong',
    rationale: `${name} evidence rationale`,
    missing_evidence: index === 0 ? ['Founder confirmation'] : [],
  }));
}

function researchPlan() {
  return {
    deal_identity: 'Acme Autonomy, industrial robotics company',
    decision_frame: 'Test whether technical differentiation and traction justify the round.',
    questions: [{
      question_id: 'product-1',
      coverage_area: 'product_differentiation',
      question: 'What independently verified technical advantage is difficult to replicate?',
      rubric_dimensions: ['Differentiation'],
      confirming_evidence: 'Patents, benchmarks, or customer switching evidence.',
      disconfirming_evidence: 'A well-funded competitor shipping the same capability.',
      preferred_sources: ['Patent records', 'Customer documentation'],
      recency_requirement: 'Current within 18 months.',
      search_queries: ['Acme Autonomy patents benchmark competitors'],
      required: true,
    }],
    critical_unknowns: ['Current customer retention'],
    contradictions_to_resolve: ['Pitch moat claim versus competitor products'],
    stop_conditions: ['Required question answered or explicitly unavailable'],
  };
}

function researchAdaptation() {
  return {
    deal_identity: 'Acme Autonomy, industrial robotics company',
    decision_frame: 'Test whether technical differentiation and traction justify the round.',
    priority_question_ids: ['baseline-product-moat', 'baseline-traction-economics'],
    custom_questions: [{
      question_id: 'custom-safety-certification',
      coverage_area: 'product_differentiation',
      question: 'Has Acme completed the safety certification required for deployment?',
      rubric_dimensions: ['Differentiation', 'Business model clarity'],
      evidence_target: 'Certification record or a disclosed remaining approval path.',
      preferred_sources: ['Regulator records', 'Company technical documentation'],
      recency_requirement: 'Current within 12 months.',
      search_queries: ['Acme Autonomy safety certification deployment'],
      required: true,
    }],
    critical_unknowns: ['Current customer retention'],
    contradictions_to_resolve: ['Pitch moat claim versus competitor products'],
  };
}

function fakeProvider({ delay = 0, malformedOnceStage = null } = {}) {
  const calls = [];
  const malformedStages = new Set();
  return {
    calls,
    async runSession(req) {
      calls.push(req);
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const stage = req.prompt.match(/^STAGE:\s*(\w+)/m)?.[1];
      const outputs = {
        room: {
          facts: [{
            claim: 'Critical end fact and Named Rival competitor.',
            classification: 'supplied',
            source_locator: 'doc-91-chunk-2:24000-48000',
          }],
          contradictions: [],
          missing_evidence: [],
          named_entities: ['Full Room Co'],
          named_competitors: ['Named Rival'],
        },
        research: {
          evidence: ['verified: Example fact — https://example.com/source'],
          team_dossier: 'Team dossier',
          company_context: 'Company context',
          custom_questions: researchAdaptation().custom_questions,
          critical_unknowns: researchAdaptation().critical_unknowns,
          contradictions_to_resolve: researchAdaptation().contradictions_to_resolve,
        },
        bull: { dimension_scores: dimensionScores(4), key_argument: 'Bull case' },
        bear: { dimension_scores: dimensionScores(2), key_argument: 'Bear case' },
        calibrator: {
          dimension_scores: dimensionScores(3),
          evidence_assessments: evidenceAssessments(),
          key_argument: 'Calibrated case',
          kill_criteria: 'No kill criteria triggered',
          primary_thesis: 'Primary thesis',
          moves_up: ['More proof'],
          moves_down: ['Less proof'],
          net_assessment: 'Balanced',
          key_questions: [{
            question_id: 'retention-proof',
            question: 'What is current net revenue retention?',
            why_it_matters: 'Retention determines whether the model compounds.',
            rubric_dimension: 'Compounding structure',
            upside_likert: 5,
            downside_likert: 2,
            priority: 'critical',
          }],
          email: 'Email draft',
          linkedin: 'LinkedIn draft',
        },
        cfo: { verdict: 'Defer', reason: 'Need more proof' },
      };
      let structuredOutput = outputs[stage];
      if (!structuredOutput) throw new Error(`unexpected stage ${stage}`);
      if (stage === malformedOnceStage && !malformedStages.has(stage)) {
        malformedStages.add(stage);
        structuredOutput = {
          ...structuredOutput,
          dimension_scores: structuredOutput.dimension_scores.filter(
            choice => choice.name !== 'Structural tailwind',
          ),
        };
      }
      return {
        text: JSON.stringify(structuredOutput),
        structuredOutput,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalCostUsd: 0.01,
          byModel: {
            [req.model]: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
          },
        },
        model: req.model,
        apiKeySource: 'oauth',
        numTurns: 1,
        sessionId: `session-${stage}`,
      };
    },
  };
}

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'radar-council-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n  councilEvaluate (B1) tests\n');

// ---- assembleContext (pure) ----
test('assembleContext: has DEAL/LENS/CALIBRATION and the deal facts + rubric', () => {
  const ctx = assembleContext(
    { company: 'Acme Autonomy', stage: 'Series A' },
    { rubric: { verdict_bands: [{ range: [40, 50], verdict: 'Strong fit' }] }, kill: [], gpTiers: [], theses: [], clusters: [], roundParams: {} },
    { maturity: 'default', investLine: 40 }
  );
  ok(ctx.includes('DEAL'), 'DEAL block');
  ok(ctx.includes('Acme Autonomy'), 'deal facts rendered');
  ok(ctx.includes('LENS'), 'LENS block');
  ok(ctx.includes('verdict_bands'), 'rubric injected');
  ok(ctx.includes('CALIBRATION') && ctx.includes('default'), 'calibration injected');
  ok(ctx.includes('COUNCIL RUN CONTRACT'), 'run contract injected');
  ok(ctx.includes('Evidence Ledger'), 'shared evidence requirement injected');
  ok(ctx.includes('authoritative as the terms presently offered'), 'current private terms keep first-party authority');
  ok(ctx.includes('source or syndicate presenting access'), 'lead semantics distinguish deal source from company round lead');
  ok(ctx.includes('older public round does not contradict'), 'historical public financing cannot negate a current offering');
});
test('assembleContext: missing deal fields render as Not provided', () => {
  const ctx = assembleContext({ company: 'X', valuation: '' }, { rubric: {}, kill: [], gpTiers: [], theses: [], clusters: [], roundParams: {} }, {});
  ok(ctx.includes('Not provided'), ctx);
});

// ---- buildCouncilAgents (pure) ----
test('buildCouncilAgents: research uses Sonnet 4.6 and calibrator uses Opus', () => {
  const a = buildCouncilAgents(resolveCouncilModels());
  eq(a.calibrator.model, 'opus');
  eq(a.bull.model, 'sonnet');
  eq(a.bear.model, 'sonnet');
  eq(a.cfo.model, 'sonnet');
  eq(a.research.model, 'claude-sonnet-4-6');
  for (const key of ['research', 'bull', 'bear', 'calibrator', 'cfo']) {
    ok(a[key].description && a[key].prompt, `${key} has description + prompt`);
  }
});

test('buildBaselineResearchPlan: creates the same complete question bank without a model', () => {
  const first = buildBaselineResearchPlan({ company: 'Acme Autonomy' });
  const second = buildBaselineResearchPlan({ company: 'Acme Autonomy' });
  eq(JSON.stringify(first), JSON.stringify(second), 'baseline is deterministic');
  eq(first.seed_version, 'baseline-v1');
  eq(first.questions.length, 9, 'covers nine durable diligence areas');
  eq(first.priority_question_ids.length, 9);
  ok(first.questions.every(question => question.required), 'baseline questions are required');
  ok(first.questions.some(question => question.question.includes('Acme Autonomy')));
  const financing = first.questions.find(question => question.question_id === 'baseline-financing');
  ok(financing.question.includes('deal source or syndicate'), 'financing research uses access semantics');
  ok(financing.disconfirming_evidence.includes('not mere absence'), 'public silence is not disconfirming evidence');
});

// ---- councilEvaluate (fake provider; needs scratch DB for getCalibration) ----
test('councilEvaluate: requires a provider', () => throwsAsync(() => councilEvaluate({ company: 'X' }, {}), 'requires a provider'));

test('councilEvaluate: executes five explicit stages against one seeded evidence packet', async () =>
  withTempDir(async dealLogDir => {
    const fake = fakeProvider();
    const stages = [];
    const out = await councilEvaluate(
      { company: 'Acme Autonomy', stage: 'Series A' },
      { provider: fake, env: {}, dealLogDir, onStage: stage => stages.push(stage) },
    );
    eq(fake.calls.length, 5, 'ran five sessions');
    const byStage = Object.fromEntries(
      fake.calls.map(req => [req.prompt.match(/^STAGE:\s*(\w+)/m)?.[1], req]),
    );
    eq(Object.keys(byStage).sort().join(','), 'bear,bull,calibrator,cfo,research');
    ok(byStage.research.systemPrompt.includes('Council Research Contract'), 'research gets its role contract');
    ok(byStage.bull.systemPrompt.includes('Council Bull Contract'), 'Bull gets its role contract');
    ok(byStage.bear.systemPrompt.includes('Council Bear Contract'), 'Bear gets its role contract');
    ok(byStage.calibrator.systemPrompt.includes('Council Calibrator Contract'), 'Calibrator gets its role contract');
    ok(byStage.cfo.systemPrompt.includes('Council Portfolio Action Contract'), 'CFO gets its role contract');
    eq(byStage.research.model, 'claude-sonnet-4-6', 'research uses Sonnet 4.6');
    ok(byStage.research.context.includes('Acme Autonomy'), 'deal in context');
    ok(byStage.research.context.includes('RADAR RESEARCH PLAN'), 'research receives Radar plan');
    ok(byStage.research.context.includes('baseline-falsification'), 'research sees deterministic baseline');
    ok(byStage.research.prompt.includes('zero to three'), 'research identifies deal-specific gaps');
    ok(byStage.research.prompt.includes('[question_id] STATUS'), 'research gets the evidence-line contract');
    ok(byStage.research.prompt.includes('Never infer that something did not happen'), 'research cannot turn search absence into a fact');
    ok(byStage.research.prompt.includes('authoritative as terms being offered'), 'research preserves current private offering facts');
    ok(byStage.research.prompt.includes('presenting access'), 'research does not confuse syndicate access with company round lead');
    ok(byStage.bear.systemPrompt.includes('public silence is not itself adverse evidence'), 'Bear cannot penalize missing public disclosure');
    ok(byStage.calibrator.systemPrompt.includes('missing public corroboration'), 'Calibrator cannot convert public silence into a conflict');
    ok(!byStage.research.context.includes('CALIBRATION'), 'research does not receive calibration');
    ok(!byStage.research.context.includes('SCORING LENS'), 'research does not receive the scoring lens');
    eq(byStage.research.tools.join(','), 'WebSearch', 'research owns retrieval');
    eq(byStage.research.maxTurns, 20, 'research keeps a bounded retrieval budget');
    for (const stage of ['bull', 'bear', 'calibrator', 'cfo']) {
      eq(byStage[stage].tools.length, 0, `${stage} cannot retrieve or write`);
      ok(!byStage[stage].agents, `${stage} is not an optional subagent`);
      eq(byStage[stage].maxTurns, 5, `${stage} has a bounded judgment budget`);
    }
    ok(byStage.bull.context.includes('https://example.com/source'), 'Bull sees frozen research');
    ok(byStage.bear.context.includes('https://example.com/source'), 'Bear sees frozen research');
    ok(byStage.bull.context.includes('SCORING LENS'), 'Bull sees the scoring lens');
    ok(!byStage.bull.context.includes('CALIBRATION'), 'Bull does not receive calibration');
    ok(byStage.calibrator.context.includes('CALIBRATION'), 'Calibrator receives calibration');
    ok(!byStage.cfo.context.includes('FROZEN BULL OUTPUT'), 'CFO does not receive full grader transcripts');
    ok(!byStage.cfo.context.includes('FROZEN RESEARCH PACKET'), 'CFO does not receive the evidence packet');
    ok(byStage.cfo.context.includes('RADAR-COMPUTED CANONICAL SCORE'), 'CFO receives canonical score');
    eq(byStage.calibrator.model, 'opus', 'Calibrator stage uses Opus');

    eq(out.usedFallback, false);
    ok(out.calibrationMaturity, 'carries calibration maturity');
    eq(out.modelPolicy.calibrator, 'opus');
    eq(out.usage.inputTokens, 500, 'aggregates input usage');
    eq(out.usage.outputTokens, 100, 'aggregates output usage');
    eq(out.usage.totalCostUsd, 0.05, 'aggregates direct API cost');
    eq(out.stageMetrics.length, 6, 'returns per-stage usage');
    eq(out.provenance.policyVersion, 8);
    ok(out.provenance.instructionHash && out.provenance.lensHash, 'provenance fingerprints');
    eq(out.provenance.researchPlanSeedVersion, 'baseline-v1');
    ok(out.provenance.researchPlanSeedHash, 'fingerprints the deterministic seed plan');
    ok(out.provenance.researchPlanHash, 'fingerprints the generated research plan');
    eq(out.provenance.researchPlan.questions.length, 10, 'persists baseline plus one custom question');
    eq(out.provenance.researchPlan.priority_question_ids[0], 'baseline-identity-status');
    eq(out.provenance.researchPlan.questions.at(-1).question_id, 'custom-safety-certification');
    eq(out.provenance.evidenceAssessments.length, 9, 'persists evidence sufficiency by dimension');
    eq(out.provenance.followupQuestions[0].current_likert, 3);
    eq(out.provenance.followupQuestions[0].upside_points, 3, 'Radar computes question upside');
    eq(out.provenance.followupQuestions[0].downside_points, -1.5, 'Radar computes question downside');
    eq(out.writtenFiles.length, 1);
    eq(stages.join(','), 'research,bull_bear,calibrator,cfo,finalizing', 'reported durable UI stages');
    const artifact = readFileSync(join(dealLogDir, out.writtenFiles[0]), 'utf8');
    ok(artifact.includes('## Research Plan'), 'artifact records the research plan');
    ok(artifact.includes('## Evidence Sufficiency'), 'artifact separates evidence confidence');
    ok(artifact.includes('retention-proof'), 'artifact records actionable founder questions');
    ok(artifact.includes('## Council Evaluation'), 'Radar wrote Council table');
    ok(artifact.includes('| Calibrator | 30/50 |'), 'Radar computed the canonical total');
  }));

test('councilEvaluate: model override flows to the explicit Calibrator stage', async () =>
  withTempDir(async dealLogDir => {
    const fake = fakeProvider();
    await councilEvaluate(
      { company: 'X' },
      { provider: fake, env: {}, models: { calibrator: 'sonnet' }, dealLogDir },
    );
    const calibrator = fake.calls.find(req => req.prompt.startsWith('STAGE: calibrator'));
    eq(calibrator.model, 'sonnet', 'override applied');
  }));

test('councilEvaluate: repairs one incomplete rubric response and counts both attempts', async () =>
  withTempDir(async dealLogDir => {
    const fake = fakeProvider({ malformedOnceStage: 'bull' });
    const out = await councilEvaluate(
      { company: 'Repair Co' },
      { provider: fake, env: {}, dealLogDir },
    );
    const bullCalls = fake.calls.filter(req => req.prompt.startsWith('STAGE: bull'));
    eq(bullCalls.length, 2, 'retries the malformed grader once');
    ok(bullCalls[1].prompt.includes('REPAIR REQUIRED'), 'repair call names the validation failure');
    eq(out.usage.inputTokens, 600, 'usage includes the rejected attempt');
    eq(out.stageMetrics.length, 7, 'stage metrics retain the rejected attempt');
    eq(out.stageMetrics[0].stage, 'bull_invalid');
  }));

test('councilEvaluate: identical run fingerprint reuses the stored evaluation', async () => {
  const fake = fakeProvider();
  const out = await councilEvaluate(
    { company: 'Repeat Co' },
    {
      provider: fake,
      env: {},
      findExisting: async () => [{ id: 77 }],
    },
  );
  eq(out.reused, true);
  eq(out.evaluationId, 77);
  eq(fake.calls.length, 0, 'no model session for an identical run');
  ok(out.provenance.runKey, 'stable run fingerprint returned');
});

test('councilEvaluate: dry run assembles without a provider or a model call', async () => {
  const out = await councilEvaluate({ company: 'Dry Co' }, { dryRun: true, env: {} });
  eq(out.dryRun, true);
  ok(out.requests.research.context.includes('Dry Co'), 'assembled the context');
  ok(out.requests.research.systemPrompt.includes('Council Research Contract'), 'loaded the research role contract');
  ok(!out.requests.research.context.includes('SCORING LENS'), 'research excludes the scoring lens');
  ok(!out.requests.research.context.includes('CALIBRATION'), 'research excludes calibration');
  ok(out.requests.calibrator.context.includes('LENS (authoritative'), 'Calibrator receives the scoring lens');
  ok(out.requests.calibrator.context.includes('CALIBRATION'), 'Calibrator receives calibration');
  ok(out.requests.cfo.context.includes('PORTFOLIO POLICY'), 'CFO receives portfolio policy');
  ok(!out.requests.cfo.context.includes('FROZEN RESEARCH'), 'CFO excludes the research packet');
  eq(Object.keys(out.requests).length, 5, 'previews all enforced stages');
  eq(out.requests.research.model, 'claude-sonnet-4-6');
  eq(out.modelPolicy.calibrator, 'opus');
  ok(out.calibrationMaturity, 'reports calibration maturity');
  ok(out.provenance.runKey, 'reports the idempotency fingerprint');
});

test('councilEvaluate: full source documents reach Research once and downstream stages receive only their manifest', async () => {
  const sourceMarker = 'PRIVATE-DEAL-ROOM-FACT-ONLY-RESEARCH-SHOULD-READ';
  const deal = {
    company: 'Full Room Co',
    source_documents: [{
      document_id: 91,
      filename: 'Full Room Co _ AngelList.html',
      mime: 'text/html',
      sha256: 'full-room-sha',
      size_bytes: 500,
      text: sourceMarker,
    }],
  };
  const out = await councilEvaluate(deal, { dryRun: true, env: {} });

  ok(out.requests.research.context.includes(sourceMarker), 'Research receives the complete source text');
  for (const stage of ['bull', 'bear', 'calibrator', 'cfo']) {
    ok(!out.requests[stage].context.includes(sourceMarker), `${stage} does not receive duplicate source text`);
    ok(out.requests[stage].context.includes('Full Room Co _ AngelList.html'), `${stage} retains source provenance`);
    ok(out.requests[stage].context.includes('full-room-sha'), `${stage} retains the source hash`);
  }

  const changed = await councilEvaluate({
    ...deal,
    source_documents: [{ ...deal.source_documents[0], text: `${sourceMarker}-changed` }],
  }, { dryRun: true, env: {} });
  ok(out.provenance.inputHash !== changed.provenance.inputHash, 'full source content participates in the input fingerprint');
});

test('councilEvaluate: chunk-all reads every oversized source chunk before Research', async () =>
  withTempDir(async dealLogDir => {
    const marker = 'CRITICAL-END-FACT-NAMED-RIVAL';
    const fake = fakeProvider();
    const out = await councilEvaluate({
      company: 'Oversized Room Co',
      source_documents: [{
        document_id: 91,
        filename: 'oversized-room.html',
        mime: 'text/html',
        sha256: 'oversized-room-sha',
        text: `${'Substantial evidence paragraph. '.repeat(2_000)}${marker}`,
      }],
    }, {
      provider: fake,
      dealLogDir,
      env: {
        RADAR_COUNCIL_DIRECT_CONTEXT_TOKENS: '8000',
        RADAR_COUNCIL_CHUNK_CHARACTERS: '12000',
        RADAR_COUNCIL_BATCH_CHARACTERS: '24000',
      },
      reuse: false,
      sourceManifest: [{
        document_id: 91,
        filename: 'oversized-room.html',
        sha256: 'oversized-room-sha',
        extraction_status: 'included',
      }],
      sourceCoverage: { attached: 1, included: 1, scoring_permitted: true },
      evidenceContractVersion: 1,
    });
    const roomCalls = fake.calls.filter(req => req.prompt.startsWith('STAGE: room evidence'));
    ok(roomCalls.length > 1, 'oversized room is processed in multiple complete batches');
    eq(roomCalls.filter(call => call.context.includes(marker)).length, 1, 'end fact is read exactly once');
    const researchCall = fake.calls.find(req => req.prompt.startsWith('STAGE: research'));
    ok(!researchCall.context.includes(marker), 'Research receives the frozen ledger instead of repeated raw text');
    ok(researchCall.context.includes('Named Rival'), 'Research receives named competitors from the room ledger');
    eq(out.provenance.sourceCoverage.strategy, 'chunk_all');
    eq(out.provenance.sourceCoverage.batches, roomCalls.length);
    eq(out.provenance.researchSnapshot.room_evidence.named_competitors[0], 'Named Rival');
    ok(out.provenance.sourceManifestHash);
    ok(out.provenance.sourceCoverageHash);
    ok(out.provenance.researchSnapshotHash);
  }));

test('councilEvaluate: controlled replay can pin an exact calibration snapshot', async () => {
  const calibrationSnapshot = {
    maturity: 'pinned-replay',
    confidence: 1,
    dealsScored: 1,
    examples: [],
    thresholds: {
      verdictBands: [],
      investLine: 40,
      defaultInvestLine: 40,
      revealedInvestLine: null,
    },
    dimensionWeights: {},
    note: 'Exact historical calibration snapshot.',
  };
  const out = await councilEvaluate(
    { company: 'Pinned Co' },
    { dryRun: true, env: {}, calibrationSnapshot },
  );
  ok(out.requests.calibrator.context.includes('"maturity":"pinned-replay"'));
  eq(out.calibrationMaturity, 'pinned-replay');
});

test('councilEvaluate: controlled replay can pin planning and research without model calls', async () =>
  withTempDir(async dealLogDir => {
    const fake = fakeProvider();
    const plannerSnapshot = researchPlan();
    const researchSnapshot = {
      evidence: ['Verified: frozen fact — https://example.com/frozen'],
      team_dossier: 'Frozen team.',
      company_context: 'Frozen company.',
    };
    const out = await councilEvaluate(
      { company: 'Frozen Research Co' },
      {
        provider: fake,
        dealLogDir,
        env: {},
        reuse: false,
        plannerSnapshot,
        researchSnapshot,
      },
    );
    ok(!fake.calls.some(req => req.prompt.startsWith('STAGE: planner')));
    ok(!fake.calls.some(req => req.prompt.startsWith('STAGE: research')));
    eq(out.result.structuredOutput.planner, plannerSnapshot);
    eq(out.result.structuredOutput.research.evidence, researchSnapshot.evidence);
    eq(out.result.structuredOutput.research.custom_questions.length, 0);
    eq(out.stageMetrics.find(stage => stage.stage === 'planner').numTurns, 0);
    eq(out.stageMetrics.find(stage => stage.stage === 'research').numTurns, 0);
    ok(out.provenance.plannerSnapshotHash, 'fingerprints the pinned research plan');
    ok(out.provenance.researchSnapshotHash, 'fingerprints the pinned research packet');
  }));

test('councilEvaluate: imported evaluation persists the structured research plan', async () =>
  withTempDir(async dealLogDir => {
    const fake = fakeProvider();
    const out = await councilEvaluate(
      { company: 'Durable Plan Fixture' },
      {
        provider: fake,
        dealLogDir,
        env: {},
        reuse: false,
      },
    );
    const imported = await importDealLogs(dealLogDir, {
      mode: 'council',
      files: out.writtenFiles,
      provenance: out.provenance,
    });
    eq(imported.imported, 1);
    const rows = await query(
      `SELECT id, council_research_plan_hash, council_research_plan,
              council_dimension_scores, council_evidence_assessments, council_rubric_snapshot
       FROM deal_evaluations
       WHERE file_path = $1`,
      [join(dealLogDir, out.writtenFiles[0])],
    );
    eq(rows.length, 1);
    eq(rows[0].council_research_plan_hash, out.provenance.researchPlanHash);
    eq(rows[0].council_research_plan.deal_identity, 'Durable Plan Fixture');
    eq(
      rows[0].council_research_plan.questions.at(-1).search_queries[0],
      researchAdaptation().custom_questions[0].search_queries[0],
    );
    eq(rows[0].council_dimension_scores.length, 9);
    eq(rows[0].council_evidence_assessments.length, 9);
    eq(rows[0].council_rubric_snapshot.total_points, 50);
  }));

test('councilEvaluate: concurrent identical clicks share one in-flight run', async () =>
  withTempDir(async dealLogDir => {
    const fake = fakeProvider({ delay: 5 });
    const options = {
      provider: fake,
      env: {},
      dealLogDir,
      findExisting: async () => [],
    };
    const [first, second] = await Promise.all([
      councilEvaluate({ company: 'Concurrent Co' }, options),
      councilEvaluate({ company: 'Concurrent Co' }, options),
    ]);
    eq(fake.calls.length, 5, 'only one set of stages ran');
    ok(first.reusedInFlight || second.reusedInFlight, 'one click joined the active run');
    eq(readdirSync(dealLogDir).filter(file => file.endsWith('.md')).length, 1, 'one artifact written');
  }));

test('councilEvaluate: changed deal input produces a new run fingerprint', async () => {
  const first = await councilEvaluate({ company: 'Dry Co', round: 'Seed' }, { dryRun: true, env: {} });
  const changed = await councilEvaluate({ company: 'Dry Co', round: 'Series A' }, { dryRun: true, env: {} });
  ok(first.provenance.runKey !== changed.provenance.runKey, 'input change must allow a new evaluation');
});

test('councilEvaluate: explicit execution id permits a controlled fresh run', async () => {
  const first = await councilEvaluate(
    { company: 'Fresh Co' },
    { dryRun: true, env: {}, executionId: 'run-1' },
  );
  const second = await councilEvaluate(
    { company: 'Fresh Co' },
    { dryRun: true, env: {}, executionId: 'run-2' },
  );
  ok(first.provenance.inputHash === second.provenance.inputHash, 'same deal input');
  ok(first.provenance.runKey !== second.provenance.runKey, 'fresh executions have distinct run keys');
});

await withLens(TEMPLATE_LENS, async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failed++; }
  }
});
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
