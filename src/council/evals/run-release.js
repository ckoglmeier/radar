import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { councilEvaluate } from '../evaluate.js';
import { AgentSdkProvider } from '../../providers/agent-sdk-provider.js';
import { resolveAuthMode } from '../../providers/auth-mode.js';
import {
  evidenceConfidenceSemanticFixtures,
  substantialRoomFixture,
} from './fixtures.js';
import { atomicWriteJson, runCheckpointedCase } from './checkpoint-runner.js';

const RUNS_PER_MODE = 3;
const MODES = Object.freeze({
  direct: 120_000,
  chunk_all: 1_000,
});

function joinedEvidence(output) {
  const research = output.provenance?.researchSnapshot || {};
  return JSON.stringify(research).toLowerCase();
}

function recall(output, facts) {
  const evidence = joinedEvidence(output);
  const found = facts.filter(fact => evidence.includes(fact.marker.toLowerCase()));
  return {
    found: found.map(fact => fact.id),
    missing: facts.filter(fact => !found.includes(fact)).map(fact => fact.id),
    recall: facts.length ? found.length / facts.length : 1,
  };
}

function score(output) {
  return Number(output.result?.text?.match(/Council complete:\s*([\d.]+)/)?.[1] || NaN);
}

function dimensionScores(output) {
  return Object.fromEntries(
    (output.result?.structuredOutput?.calibrator?.dimension_scores || [])
      .map(dimension => [dimension.name, Number(dimension.likert)]),
  );
}

function range(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) - Math.min(...finite) : null;
}

function validate(results, fixture) {
  const failures = [];
  for (const result of results) {
    if (result.critical.recall !== 1) failures.push(`${result.id}: critical recall below 100%`);
    if (result.important.recall < 0.8) failures.push(`${result.id}: important recall below 80%`);
    if (!result.sourceLocatorsComplete) failures.push(`${result.id}: critical source locator missing`);
    if (!result.competitors.includes('Northstar Relay')) failures.push(`${result.id}: named competitor missing`);
    if (!result.sameEventConflict) failures.push(`${result.id}: same-event conflict missing`);
    if (result.publicSilenceConflict) failures.push(`${result.id}: public silence treated as conflict`);
  }
  for (const mode of Object.keys(MODES)) {
    const runs = results.filter(result => result.mode === mode);
    if (range(runs.map(result => result.score)) > 2) failures.push(`${mode}: total-score variance exceeds 2`);
    const dimensions = new Set(runs.flatMap(result => Object.keys(result.dimensions)));
    for (const dimension of dimensions) {
      if (range(runs.map(result => result.dimensions[dimension])) > 1) {
        failures.push(`${mode}: ${dimension} variance exceeds 1`);
      }
    }
  }
  const mean = (mode, field) => {
    const values = results.filter(result => result.mode === mode).map(result => result[field].recall);
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };
  if (Math.abs(mean('direct', 'important') - mean('chunk_all', 'important')) > 0.05) {
    failures.push('direct/chunk-all important-fact mean recall differs by more than 5 points');
  }
  const scores = mode => results.filter(result => result.mode === mode).map(result => result.score);
  const scoreMean = mode => scores(mode).reduce((sum, value) => sum + value, 0) / RUNS_PER_MODE;
  if (Math.abs(scoreMean('direct') - scoreMean('chunk_all')) > 2) {
    failures.push('direct/chunk-all total-score means differ by more than 2');
  }
  return failures;
}

function validateSemantic(results, fixtures) {
  const failures = [];
  const byId = new Map(results.map(result => [result.fixtureId, result]));
  const privateOnly = byId.get('private-only-seed');
  const corroborated = byId.get('corroborated-twin');
  const contradicted = byId.get('contradicted-twin');
  const laterStage = byId.get('later-stage-missing-disclosure');
  if (!privateOnly || !corroborated || !contradicted || !laterStage) {
    return ['semantic evidence-confidence fixtures are incomplete'];
  }
  if (Math.abs(privateOnly.score - corroborated.score) > 1) {
    failures.push('private-only/corroborated total scores differ by more than 1');
  }
  for (const dimension of Object.keys(privateOnly.dimensions)) {
    if (Math.abs(privateOnly.dimensions[dimension] - corroborated.dimensions[dimension]) > 1) {
      failures.push(`private-only/corroborated ${dimension} differs by more than 1 Likert`);
    }
  }
  const confidenceRank = { low: 1, medium: 2, high: 3 };
  const privateConfidence = Object.values(privateOnly.confidence)
    .reduce((sum, value) => sum + (confidenceRank[value] || 0), 0);
  const corroboratedConfidence = Object.values(corroborated.confidence)
    .reduce((sum, value) => sum + (confidenceRank[value] || 0), 0);
  if (corroboratedConfidence <= privateConfidence) failures.push('corroborated twin did not improve confidence');
  if (privateOnly.publicSilencePenalty) failures.push('private-only output penalized public silence');
  const affectedDimension = fixtures.find(item => item.id === 'contradicted-twin').affectedDimension;
  if (contradicted.dimensions[affectedDimension] >= privateOnly.dimensions[affectedDimension]) {
    failures.push(`contradicted twin did not lower ${affectedDimension}`);
  }
  const expectedCapId = fixtures.find(item => item.id === 'later-stage-missing-disclosure').expectedCapId;
  if (!laterStage.caps.some(cap => cap.cap_id === expectedCapId)) {
    failures.push(`later-stage fixture did not apply ${expectedCapId}`);
  }
  return failures;
}

const fixture = substantialRoomFixture();
const authMode = resolveAuthMode(process.env);
const outputDir = resolve(process.argv[2] || 'src/council/evals/results');
mkdirSync(outputDir, { recursive: true });
const reportPath = resolve(outputDir, 'v0.3.0-release-eval.json');
const selectorArguments = process.argv.slice(3);
const selectedIds = new Set();
for (let index = 0; index < selectorArguments.length; index += 1) {
  if (selectorArguments[index] !== '--selector' || !selectorArguments[index + 1]) {
    throw new Error('Usage: run-release.js [output-dir] [--selector <case-id>]');
  }
  selectedIds.add(selectorArguments[index + 1]);
  index += 1;
}
const resetModes = new Set(
  String(process.env.RADAR_COUNCIL_EVAL_RESET_MODES || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
);
const checkpoint = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : {};
const checkpointResults = checkpoint.results || [];
const checkpointSemanticResults = checkpoint.semantic_results || [];
const results = checkpointResults.filter(result => !resetModes.has(result.mode));
const semanticResults = checkpointSemanticResults;
const attempts = checkpoint.attempts || [];
const semanticFixtures = evidenceConfidenceSemanticFixtures();
const knownIds = new Set([
  ...Object.keys(MODES).flatMap(mode =>
    Array.from({ length: RUNS_PER_MODE }, (_, index) => `${mode}-${index + 1}`),
  ),
  ...semanticFixtures.map(entry => `semantic-${entry.id}`),
]);
for (const id of selectedIds) {
  if (!knownIds.has(id)) throw new Error(`Unknown release evaluation selector: ${id}`);
}

function incompleteSelectors() {
  const incomplete = [];
  for (const mode of Object.keys(MODES)) {
    for (let run = 1; run <= RUNS_PER_MODE; run += 1) {
      const id = `${mode}-${run}`;
      if (!results.some(result => result.id === id)) incomplete.push(id);
    }
  }
  for (const semanticFixture of semanticFixtures) {
    if (!semanticResults.some(result => result.fixtureId === semanticFixture.id)) {
      incomplete.push(`semantic-${semanticFixture.id}`);
    }
  }
  return incomplete;
}

function writeReport({ failures = [], passed = null } = {}) {
  atomicWriteJson(reportPath, {
    contract: 'v0.3.0-evaluation-integrity',
    generated_at: new Date().toISOString(),
    fictional_fixture: 'Nimbus Forge',
    model_policy: results[0]?.modelPolicy || null,
    results,
    semantic_results: semanticResults,
    attempts,
    incomplete_selectors: incompleteSelectors(),
    failures,
    passed,
  });
}

for (const [mode, directContextBudgetTokens] of Object.entries(MODES)) {
  for (let run = 1; run <= RUNS_PER_MODE; run += 1) {
    if (results.some(result => result.id === `${mode}-${run}`)) {
      console.log(`[${mode}-${run}] resumed from checkpoint`);
      continue;
    }
    const id = `${mode}-${run}`;
    if (selectedIds.size > 0 && !selectedIds.has(id)) {
      console.log(`[${id}] not selected`);
      continue;
    }
    const output = await runCheckpointedCase({
      selector: { suite: 'release', case_id: id },
      attempts,
      onCheckpoint: () => writeReport(),
      operation: attempt => councilEvaluate(fixture.deal, {
        provider: new AgentSdkProvider({ authMode, cwd: outputDir }),
        env: process.env,
        dealLogDir: outputDir,
        policyId: 'balanced',
        executionId: `v0.3.0-${id}-attempt-${attempt}`,
        directContextBudgetTokens,
        sourceManifest: fixture.manifest,
        evidenceContractVersion: 2,
        reuse: false,
        stageTimeoutMs: Number(process.env.RADAR_COUNCIL_RELEASE_STAGE_TIMEOUT_MS || 20 * 60 * 1_000),
        onStage: stage => console.log(`[${id} attempt ${attempt}] ${stage}`),
      }),
    });
    const researchSnapshot = output.provenance?.researchSnapshot || {};
    const researchText = joinedEvidence(output);
    const facts = researchSnapshot.room_evidence?.facts || [];
    const evidenceLines = researchSnapshot.evidence || [];
    const criticalMarkers = fixture.facts
      .filter(fact => fact.priority === 'critical')
      .map(fact => fact.marker);
    const contradictionText = [
      ...(researchSnapshot.room_evidence?.contradictions || []),
      ...(researchSnapshot.contradictions_to_resolve || []),
    ];
    results.push({
      id,
      mode,
      run,
      score: score(output),
      dimensions: dimensionScores(output),
      critical: recall(output, fixture.facts.filter(fact => fact.priority === 'critical')),
      important: recall(output, fixture.facts.filter(fact => fact.priority === 'important')),
      competitors: output.provenance?.researchSnapshot?.room_evidence?.named_competitors || (
        researchText.includes('northstar relay') ? ['Northstar Relay'] : []
      ),
      sourceLocatorsComplete: criticalMarkers.every(marker => {
        const locatedFinalEvidence = evidenceLines.some(line => (
          line.includes(marker)
          && /(doc(?:ument)?\s*900\d|fictional-room|source)/i.test(line)
        ));
        if (locatedFinalEvidence) return true;
        return facts.some(fact => (
          `${fact.claim} ${fact.source_locator}`.includes(marker)
          && Boolean(fact.source_locator)
        ));
      }),
      sameEventConflict: researchText.includes('conflict-same-event-23'),
      publicSilenceConflict: contradictionText
        .some(value => /absence|public silence/i.test(value)),
      strategy: output.provenance?.sourceCoverage?.strategy,
      sourceManifestHash: output.provenance?.sourceManifestHash,
      researchSnapshotHash: output.provenance?.researchSnapshotHash,
      usage: output.usage,
      stageMetrics: output.stageMetrics,
      modelPolicy: output.modelPolicy,
    });
    writeReport();
  }
}

for (const semanticFixture of semanticFixtures) {
  if (semanticResults.some(result => result.fixtureId === semanticFixture.id)) {
    console.log(`[semantic-${semanticFixture.id}] resumed from checkpoint`);
    continue;
  }
  const id = `semantic-${semanticFixture.id}`;
  if (selectedIds.size > 0 && !selectedIds.has(id)) {
    console.log(`[${id}] not selected`);
    continue;
  }
  const output = await runCheckpointedCase({
    selector: { suite: 'semantic', fixture_id: semanticFixture.id },
    attempts,
    onCheckpoint: () => writeReport(),
    operation: attempt => councilEvaluate(semanticFixture.deal, {
      provider: new AgentSdkProvider({ authMode, cwd: outputDir }),
      env: process.env,
      dealLogDir: outputDir,
      policyId: 'balanced',
      executionId: `v0.4.0-${id}-attempt-${attempt}`,
      researchSnapshot: semanticFixture.researchSnapshot,
      evidenceContractVersion: 2,
      reuse: false,
      stageTimeoutMs: Number(process.env.RADAR_COUNCIL_RELEASE_STAGE_TIMEOUT_MS || 20 * 60 * 1_000),
      onStage: stage => console.log(`[${id} attempt ${attempt}] ${stage}`),
    }),
  });
  const calibrator = output.result.structuredOutput.calibrator;
  const serializedOutput = JSON.stringify(calibrator).toLowerCase();
  semanticResults.push({
    fixtureId: semanticFixture.id,
    score: score(output),
    verdict: output.result.text.split('·').at(-1)?.trim() || null,
    dimensions: dimensionScores(output),
    confidence: Object.fromEntries(
      calibrator.evidence_assessments.map(item => [item.name, item.confidence]),
    ),
    caps: output.provenance.evidenceCapReceipt?.applied || [],
    publicSilencePenalty: /public silence|not publicly corroborated|lack of public corroboration/.test(serializedOutput)
      && /penalt|reduce|lower|contradict|structural flag/.test(serializedOutput),
    researchSnapshotHash: output.provenance.researchSnapshotHash,
    modelPolicy: output.modelPolicy,
  });
  writeReport();
}

if (incompleteSelectors().length > 0) {
  writeReport({ passed: null });
  console.log(`INCOMPLETE ${reportPath}: ${incompleteSelectors().join(', ')}`);
  process.exit(0);
}

const failures = [
  ...validate(results, fixture),
  ...validateSemantic(semanticResults, semanticFixtures),
];
const passed = failures.length === 0;
writeReport({ failures, passed });
console.log(`${passed ? 'PASS' : 'FAIL'} ${reportPath}`);
if (!passed) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}
