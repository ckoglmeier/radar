import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { councilEvaluate } from '../evaluate.js';
import { withLens } from '../../lenses/loader.js';
import { AgentSdkProvider } from '../../providers/agent-sdk-provider.js';
import { resolveAuthMode } from '../../providers/auth-mode.js';
import {
  compactReplayComparison,
  renderReplayComparisonMarkdown,
  replayHash,
  validateReplayBundle,
} from './controlled-replay.js';
import { atomicWriteJson, runCheckpointedCase } from './checkpoint-runner.js';

const bundlePath = resolve(process.argv[2] || '');
const outputDir = resolve(process.argv[3] || '');
if (!bundlePath || !existsSync(bundlePath) || !process.argv[3]) {
  throw new Error('Usage: node run-controlled-replays.js <frozen-bundle.json> <isolated-output-dir>');
}
mkdirSync(outputDir, { recursive: true });
const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
const cases = validateReplayBundle(bundle);
const authMode = resolveAuthMode(process.env);
const checkpointPath = resolve(outputDir, 'controlled-replay-checkpoint.json');
const bundleHash = replayHash(bundle);
const checkpoint = existsSync(checkpointPath)
  ? JSON.parse(readFileSync(checkpointPath, 'utf8'))
  : {};
if (checkpoint.bundle_hash && checkpoint.bundle_hash !== bundleHash) {
  throw new Error('Controlled replay checkpoint belongs to a different frozen bundle');
}
const comparisons = checkpoint.comparisons || [];
const attempts = checkpoint.attempts || [];
const companyArguments = process.argv.slice(4);
const selectedCompanies = new Set();
for (let index = 0; index < companyArguments.length; index += 1) {
  if (companyArguments[index] !== '--company' || !companyArguments[index + 1]) {
    throw new Error('Usage: run-controlled-replays.js <bundle> <output-dir> [--company <name>]');
  }
  selectedCompanies.add(companyArguments[index + 1]);
  index += 1;
}
const knownCompanies = new Set(cases.map(entry => entry.company));
for (const company of selectedCompanies) {
  if (!knownCompanies.has(company)) throw new Error(`Unknown controlled replay company: ${company}`);
}

function incompleteCompanies() {
  return cases
    .map(entry => entry.company)
    .filter(company => !comparisons.some(comparison => comparison.company === company));
}

function writeCheckpoint({ passed = null, failures = [] } = {}) {
  atomicWriteJson(checkpointPath, {
    format_version: 1,
    generated_at: new Date().toISOString(),
    bundle_hash: bundleHash,
    comparisons,
    attempts,
    incomplete_companies: incompleteCompanies(),
    failures,
    passed,
  });
}

function normalizedText(value) {
  return JSON.stringify(value || '').toLowerCase();
}

function reviewGates(company, calibrator) {
  const dimensionText = Object.fromEntries(
    calibrator.dimension_scores.map(item => [item.name, normalizedText(item.rationale)]),
  );
  const questions = normalizedText(calibrator.key_questions);
  if (company === 'Sourcerer') {
    const mechanismText = [
      dimensionText['Domain match'],
      dimensionText['Compounding structure'],
      dimensionText.Differentiation,
    ].join(' ');
    return {
      'no public-silence-only founder structural flag': !/founders? without domain|lack domain experience/.test(normalizedText(calibrator.kill_criteria)),
      'supplied product/data/flywheel mechanisms considered': /product|data|flywheel|workflow|network/.test(mechanismText),
      'working-capital or contribution-margin questions remain prominent': /working capital|contribution margin/.test(questions),
    };
  }
  if (company === 'Standard Bots') {
    const outsideSourceQuality = Object.entries(dimensionText)
      .filter(([name]) => name !== 'Source quality')
      .map(([, rationale]) => rationale)
      .join(' ');
    return {
      'source-quality concerns do not leak into unrelated dimensions': !/builders capital|source quality|deal source/.test(outsideSourceQuality),
    };
  }
  return {};
}

for (const entry of cases) {
  if (comparisons.some(comparison => comparison.company === entry.company)) {
    console.log(`[${entry.company}] resumed from checkpoint`);
    continue;
  }
  if (selectedCompanies.size > 0 && !selectedCompanies.has(entry.company)) {
    console.log(`[${entry.company}] not selected`);
    continue;
  }
  const output = await runCheckpointedCase({
    selector: { suite: 'controlled_replay', company: entry.company },
    attempts,
    onCheckpoint: writeCheckpoint,
    operation: attempt => withLens(entry.lens_snapshot, () => councilEvaluate(entry.deal, {
      provider: new AgentSdkProvider({ authMode, cwd: outputDir }),
      env: process.env,
      dealLogDir: outputDir,
      policyId: entry.policy_id || 'balanced',
      executionId: `policy-v9-controlled-replay-${entry.company}-attempt-${attempt}`,
      calibrationSnapshot: entry.calibration_snapshot,
      plannerSnapshot: entry.planner_snapshot,
      researchSnapshot: entry.research_snapshot,
      sourceManifest: entry.source_manifest || [],
      evidenceContractVersion: 2,
      reuse: false,
      stageTimeoutMs: Number(process.env.RADAR_COUNCIL_RELEASE_STAGE_TIMEOUT_MS || 20 * 60 * 1_000),
      onStage: stage => console.log(`[${entry.company} attempt ${attempt}] ${stage}`),
    })),
  });
  const calibrator = output.result.structuredOutput.calibrator;
  const v9 = {
    total: Number(output.result.text.match(/Council complete:\s*([\d.]+)/)?.[1]),
    verdict: output.result.text.split('·').at(-1)?.trim(),
    dimensions: Object.fromEntries(calibrator.dimension_scores.map(item => [item.name, item.likert])),
    dimension_rationales: Object.fromEntries(calibrator.dimension_scores.map(item => [item.name, item.rationale])),
    confidence: Object.fromEntries(calibrator.evidence_assessments.map(item => [item.name, item.confidence])),
    evidence_assessments: calibrator.evidence_assessments,
    caps: output.provenance.evidenceCapReceipt?.applied || [],
    review_gates: reviewGates(entry.company, calibrator),
  };
  comparisons.push(compactReplayComparison(entry, v9));
  writeCheckpoint();
}

if (incompleteCompanies().length > 0) {
  writeCheckpoint();
  console.log(`INCOMPLETE ${checkpointPath}: ${incompleteCompanies().join(', ')}`);
  process.exit(0);
}

const failedGates = comparisons.flatMap(comparison =>
  Object.entries(comparison.review_gates)
    .filter(([, passed]) => !passed)
    .map(([gate]) => `${comparison.company}: ${gate}`),
);

atomicWriteJson(resolve(outputDir, 'council-v8-v9-controlled-replay-comparison.json'), {
  generated_at: new Date().toISOString(),
  bundle_hash: bundleHash,
  comparisons,
  attempts,
  passed: failedGates.length === 0,
});
writeFileSync(
  resolve(outputDir, 'council-v8-v9-controlled-replay-comparison.md'),
  renderReplayComparisonMarkdown(comparisons),
  'utf8',
);
console.log(`Controlled replay comparison written to ${outputDir}`);
if (failedGates.length) {
  writeCheckpoint({ passed: false, failures: failedGates });
  throw new Error(`Controlled replay review gates failed: ${failedGates.join('; ')}`);
}
atomicWriteJson(checkpointPath, {
  format_version: 1,
  generated_at: new Date().toISOString(),
  bundle_hash: bundleHash,
  comparisons,
  attempts,
  incomplete_companies: [],
  passed: true,
});
