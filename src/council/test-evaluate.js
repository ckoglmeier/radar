#!/usr/bin/env node

// Tests for councilEvaluate() (B1). The provider is faked — no real SDK — so
// these assert that each Council stage is actually executed, shares one frozen
// evidence packet, and leaves scoring/file output to Radar.
// getCalibration() needs a DB, so run under a scratch PGlite (test:local).
// Run: DATABASE_URL=file:./.radar-test-local node src/council/test-evaluate.js

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { councilEvaluate, assembleContext, buildCouncilAgents } from './evaluate.js';
import { resolveCouncilModels } from '../providers/council-models.js';

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

function fakeProvider({ delay = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async runSession(req) {
      calls.push(req);
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const stage = req.prompt.match(/^STAGE:\s*(\w+)/m)?.[1];
      const outputs = {
        research: {
          evidence: ['verified: Example fact — https://example.com/source'],
          team_dossier: 'Team dossier',
          company_context: 'Company context',
        },
        bull: { dimension_scores: dimensionScores(4), key_argument: 'Bull case' },
        bear: { dimension_scores: dimensionScores(2), key_argument: 'Bear case' },
        calibrator: {
          dimension_scores: dimensionScores(3),
          key_argument: 'Calibrated case',
          kill_criteria: 'No kill criteria triggered',
          primary_thesis: 'Primary thesis',
          moves_up: ['More proof'],
          moves_down: ['Less proof'],
          net_assessment: 'Balanced',
          key_questions: ['What is retention?'],
          email: 'Email draft',
          linkedin: 'LinkedIn draft',
        },
        cfo: { verdict: 'Defer', reason: 'Need more proof' },
      };
      const structuredOutput = outputs[stage];
      if (!structuredOutput) throw new Error(`unexpected stage ${stage}`);
      return {
        text: JSON.stringify(structuredOutput),
        structuredOutput,
        usage: {},
        model: req.model,
        apiKeySource: 'oauth',
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
});
test('assembleContext: missing deal fields render as Not provided', () => {
  const ctx = assembleContext({ company: 'X', valuation: '' }, { rubric: {}, kill: [], gpTiers: [], theses: [], clusters: [], roundParams: {} }, {});
  ok(ctx.includes('Not provided'), ctx);
});

// ---- buildCouncilAgents (pure) ----
test('buildCouncilAgents: per-persona model tiers (calibrator opus, arguers sonnet, research haiku)', () => {
  const a = buildCouncilAgents(resolveCouncilModels());
  eq(a.calibrator.model, 'opus');
  eq(a.bull.model, 'sonnet');
  eq(a.bear.model, 'sonnet');
  eq(a.cfo.model, 'sonnet');
  eq(a.research.model, 'haiku');
  for (const key of ['research', 'bull', 'bear', 'calibrator', 'cfo']) {
    ok(a[key].description && a[key].prompt, `${key} has description + prompt`);
  }
});

// ---- councilEvaluate (fake provider; needs scratch DB for getCalibration) ----
test('councilEvaluate: requires a provider', () => throwsAsync(() => councilEvaluate({ company: 'X' }, {}), 'requires a provider'));

test('councilEvaluate: executes five explicit stages against one evidence packet', async () =>
  withTempDir(async dealLogDir => {
    const fake = fakeProvider();
    const out = await councilEvaluate(
      { company: 'Acme Autonomy', stage: 'Series A' },
      { provider: fake, env: {}, dealLogDir },
    );
    eq(fake.calls.length, 5, 'ran five sessions');
    const byStage = Object.fromEntries(
      fake.calls.map(req => [req.prompt.match(/^STAGE:\s*(\w+)/m)?.[1], req]),
    );
    eq(Object.keys(byStage).sort().join(','), 'bear,bull,calibrator,cfo,research');
    ok(byStage.research.systemPrompt.includes('Headless Council'), 'systemPrompt = vendored skill');
    ok(byStage.research.context.includes('Acme Autonomy'), 'deal in context');
    ok(byStage.research.context.includes('CALIBRATION'), 'calibration in context');
    eq(byStage.research.tools.join(','), 'WebSearch', 'research owns retrieval');
    for (const stage of ['bull', 'bear', 'calibrator', 'cfo']) {
      eq(byStage[stage].tools.length, 0, `${stage} cannot retrieve or write`);
      ok(!byStage[stage].agents, `${stage} is not an optional subagent`);
    }
    ok(byStage.bull.context.includes('https://example.com/source'), 'Bull sees frozen research');
    ok(byStage.bear.context.includes('https://example.com/source'), 'Bear sees frozen research');
    eq(byStage.calibrator.model, 'opus', 'Calibrator stage uses Opus');

    eq(out.usedFallback, false);
    ok(out.calibrationMaturity, 'carries calibration maturity');
    eq(out.modelPolicy.calibrator, 'opus');
    eq(out.provenance.policyVersion, 3);
    ok(out.provenance.instructionHash && out.provenance.lensHash, 'provenance fingerprints');
    eq(out.writtenFiles.length, 1);
    const artifact = readFileSync(join(dealLogDir, out.writtenFiles[0]), 'utf8');
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
  ok(out.requests.research.systemPrompt.includes('Headless Council'), 'loaded the skill');
  eq(Object.keys(out.requests).length, 5, 'previews all enforced stages');
  eq(out.modelPolicy.calibrator, 'opus');
  ok(out.calibrationMaturity, 'reports calibration maturity');
  ok(out.provenance.runKey, 'reports the idempotency fingerprint');
});

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

for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failed++; }
}
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
