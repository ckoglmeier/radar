#!/usr/bin/env node

// Tests for councilEvaluate() (B1). The provider is faked — no real SDK — so
// these assert the ASSEMBLY: injected context, systemPrompt = the vendored
// skill, per-persona subagent model tiers, tool grants, and result passthrough.
// getCalibration() needs a DB, so run under a scratch PGlite (test:local).
// Run: DATABASE_URL=file:./.radar-test-local node src/council/test-evaluate.js

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

function fakeProvider() {
  const calls = [];
  return { calls, async runSession(req) { calls.push(req); return { text: 'graded', usage: {}, model: 'sonnet', apiKeySource: 'oauth', sessionId: 's1' }; } };
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

test('councilEvaluate: assembles the session request correctly', async () => {
  const fake = fakeProvider();
  const out = await councilEvaluate({ company: 'Acme Autonomy', stage: 'Series A' }, { provider: fake, env: {} });
  eq(fake.calls.length, 1, 'ran one session');
  const req = fake.calls[0];
  ok(req.systemPrompt.includes('Headless Council'), 'systemPrompt = vendored skill');
  ok(req.context.includes('Acme Autonomy'), 'deal in context');
  ok(req.context.includes('CALIBRATION'), 'calibration in context');
  eq(req.tools.join(','), 'Write', 'only the research subagent can retrieve evidence');
  eq(req.agents.research.tools.join(','), 'WebSearch', 'research owns retrieval');
  eq(req.agents.calibrator.model, 'opus', 'calibrator tier wired into subagents');
  eq(req.model, 'sonnet', 'orchestrator model');
  // Return shape
  eq(out.result.text, 'graded');
  eq(out.usedFallback, false);
  ok(out.calibrationMaturity, 'carries calibration maturity');
  eq(out.modelPolicy.calibrator, 'opus');
  eq(out.provenance.policyVersion, 2);
  ok(out.provenance.instructionHash && out.provenance.lensHash, 'provenance fingerprints');
});

test('councilEvaluate: model override flows to the subagents', async () => {
  const fake = fakeProvider();
  await councilEvaluate({ company: 'X' }, { provider: fake, env: {}, models: { calibrator: 'sonnet' } });
  eq(fake.calls[0].agents.calibrator.model, 'sonnet', 'override applied');
});

test('councilEvaluate: dry run assembles without a provider or a model call', async () => {
  const out = await councilEvaluate({ company: 'Dry Co' }, { dryRun: true, env: {} });
  eq(out.dryRun, true);
  ok(out.request.context.includes('Dry Co'), 'assembled the context');
  ok(out.request.systemPrompt.includes('Headless Council'), 'loaded the skill');
  eq(out.modelPolicy.calibrator, 'opus');
  ok(out.calibrationMaturity, 'reports calibration maturity');
});

for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failed++; }
}
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
