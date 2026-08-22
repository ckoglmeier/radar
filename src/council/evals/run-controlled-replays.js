import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { councilEvaluate } from '../evaluate.js';
import { withLens } from '../../lenses/loader.js';
import { AgentSdkProvider } from '../../providers/agent-sdk-provider.js';
import { resolveAuthMode } from '../../providers/auth-mode.js';
import {
  compactReplayComparison,
  renderReplayComparisonMarkdown,
  validateReplayBundle,
} from './controlled-replay.js';

const bundlePath = resolve(process.argv[2] || '');
const outputDir = resolve(process.argv[3] || '');
if (!bundlePath || !existsSync(bundlePath) || !process.argv[3]) {
  throw new Error('Usage: node run-controlled-replays.js <frozen-bundle.json> <isolated-output-dir>');
}
mkdirSync(outputDir, { recursive: true });
const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
const cases = validateReplayBundle(bundle);
const provider = new AgentSdkProvider({ authMode: resolveAuthMode(process.env), cwd: outputDir });
const comparisons = [];

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
  const output = await withLens(entry.lens_snapshot, () => councilEvaluate(entry.deal, {
    provider,
    env: process.env,
    dealLogDir: outputDir,
    policyId: entry.policy_id || 'balanced',
    executionId: `policy-v9-controlled-replay-${entry.company}`,
    calibrationSnapshot: entry.calibration_snapshot,
    plannerSnapshot: entry.planner_snapshot,
    researchSnapshot: entry.research_snapshot,
    sourceManifest: entry.source_manifest || [],
    evidenceContractVersion: 2,
    reuse: false,
  }));
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
}

const failedGates = comparisons.flatMap(comparison =>
  Object.entries(comparison.review_gates)
    .filter(([, passed]) => !passed)
    .map(([gate]) => `${comparison.company}: ${gate}`),
);

writeFileSync(
  resolve(outputDir, 'council-v8-v9-controlled-replay-comparison.json'),
  `${JSON.stringify({ generated_at: new Date().toISOString(), comparisons }, null, 2)}\n`,
  'utf8',
);
writeFileSync(
  resolve(outputDir, 'council-v8-v9-controlled-replay-comparison.md'),
  renderReplayComparisonMarkdown(comparisons),
  'utf8',
);
console.log(`Controlled replay comparison written to ${outputDir}`);
if (failedGates.length) {
  throw new Error(`Controlled replay review gates failed: ${failedGates.join('; ')}`);
}
