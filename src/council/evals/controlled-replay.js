import { createHash } from 'node:crypto';

export const REQUIRED_CONTROLLED_REPLAYS = Object.freeze([
  'Sourcerer',
  'Standard Bots',
  'Saturn Dynamics',
]);

export function replayHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizedText(value) {
  return JSON.stringify(value || '').toLowerCase();
}

export function controlledReplayReviewGates(company, calibrator) {
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
    const outsideSourceAndPortfolioQuality = Object.entries(dimensionText)
      .filter(([name]) => name !== 'Source quality' && name !== 'Portfolio construction fit')
      .map(([, rationale]) => rationale)
      .join(' ');
    return {
      'source-quality concerns do not leak into unrelated dimensions': !/builders capital|source quality|deal source/.test(outsideSourceAndPortfolioQuality),
    };
  }
  return {};
}

export function validateReplayBundle(bundle) {
  if (!Array.isArray(bundle?.cases)) throw new Error('Controlled replay bundle requires cases');
  const byCompany = new Map(bundle.cases.map(entry => [entry.company, entry]));
  for (const company of REQUIRED_CONTROLLED_REPLAYS) {
    const entry = byCompany.get(company);
    if (!entry) throw new Error(`Controlled replay bundle is missing ${company}`);
    for (const field of ['deal', 'planner_snapshot', 'research_snapshot', 'calibration_snapshot', 'lens_snapshot', 'v8']) {
      if (!entry[field]) throw new Error(`${company} is missing frozen ${field}`);
    }
    for (const [field, value] of [
      ['deal', entry.deal],
      ['planner', entry.planner_snapshot],
      ['research', entry.research_snapshot],
      ['calibration', entry.calibration_snapshot],
      ['lens', entry.lens_snapshot],
      ['source_manifest', entry.source_manifest || []],
    ]) {
      const expected = entry.frozen_hashes?.[field];
      const actual = replayHash(value);
      if (!expected || expected !== actual) {
        throw new Error(`${company} frozen ${field} hash does not match`);
      }
    }
    if (Number(entry.v8.policy_version) !== 8) {
      throw new Error(`${company} baseline must be Council policy v8`);
    }
  }
  return bundle.cases;
}

export function compactReplayComparison(entry, v9) {
  const v9Assessments = new Map(
    (v9.evidence_assessments || []).map(item => [item.name, item]),
  );
  const v9Caps = new Map((v9.caps || []).map(item => [item.dimension, item]));
  const dimensions = Array.from(new Set([
    ...Object.keys(entry.v8.dimensions || {}),
    ...Object.keys(v9.dimensions || {}),
  ])).map(name => {
    const delta = Number(v9.dimensions?.[name] ?? 0) - Number(entry.v8.dimensions?.[name] ?? 0);
    const assessment = v9Assessments.get(name);
    const category = delta === 0
      ? 'no_change'
      : v9Caps.has(name)
        ? 'stage_policy'
        : assessment?.score_effect && assessment.score_effect !== 'none'
          ? 'evidence_policy'
          : 'calibrated_judgment';
    return {
      name,
      v8: entry.v8.dimensions?.[name] ?? null,
      v9: v9.dimensions?.[name] ?? null,
      delta,
      attribution: category,
      v9_rationale: v9.dimension_rationales?.[name] || null,
    };
  });
  return {
    company: entry.company,
    evidence_hashes_match: true,
    v8: {
      total: entry.v8.total,
      verdict: entry.v8.verdict,
      confidence: entry.v8.confidence || {},
      caps: entry.v8.caps || [],
    },
    v9: {
      total: v9.total,
      verdict: v9.verdict,
      confidence: v9.confidence || {},
      caps: v9.caps || [],
    },
    total_delta: Number(v9.total) - Number(entry.v8.total),
    dimensions,
    delta_attribution: dimensions
      .filter(item => item.delta !== 0)
      .map(item => `${item.name}: ${item.delta > 0 ? '+' : ''}${item.delta} Likert — ${item.attribution}`),
    review_gates: v9.review_gates || {},
  };
}

export function renderReplayComparisonMarkdown(comparisons) {
  const sections = comparisons.map(comparison => {
    const dimensions = comparison.dimensions.map(item =>
      `| ${item.name} | ${item.v8 ?? '—'} | ${item.v9 ?? '—'} | ${item.delta >= 0 ? '+' : ''}${item.delta} | ${item.attribution} |`,
    ).join('\n');
    const caps = comparison.v9.caps.length
      ? comparison.v9.caps.map(cap => `- ${cap.cap_id}: ${cap.dimension} ${cap.quality_likert}→${cap.effective_likert}`).join('\n')
      : '- None';
    const attribution = comparison.delta_attribution.length
      ? comparison.delta_attribution.map(item => `- ${item}`).join('\n')
      : '- No score deltas';
    const gates = Object.entries(comparison.review_gates || {}).map(([name, passed]) =>
      `- ${passed ? '✅' : '❌'} ${name}`,
    ).join('\n') || '- None configured';
    return `## ${comparison.company}

Evidence hashes match: **yes**

| Policy | Total | Verdict |
|---|---:|---|
| v8 | ${comparison.v8.total}/50 | ${comparison.v8.verdict} |
| v9 | ${comparison.v9.total}/50 | ${comparison.v9.verdict} |

| Dimension | v8 | v9 | Δ | Attribution |
|---|---:|---:|---:|---|
${dimensions}

### Confidence

- v8: ${JSON.stringify(comparison.v8.confidence)}
- v9: ${JSON.stringify(comparison.v9.confidence)}

### v9 caps

${caps}

### Delta attribution

${attribution}

### Review gates

${gates}`;
  }).join('\n\n');
  return `# Council v8 → v9 Controlled Replay Comparison

These policy-refresh candidates use frozen inputs. They do not overwrite or
promote a canonical evaluation.

${sections}
`;
}
