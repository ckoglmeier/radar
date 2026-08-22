import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { getRubric } from '../lenses/loader.js';
import { resolveCouncilModels } from '../providers/council-models.js';
import { resolveAuthMode } from '../providers/auth-mode.js';
import { resolveFallbackFlag, runWithFallback } from '../providers/session-errors.js';
import { parseCouncilChoices, scoreCouncilChoices } from './scoring.js';
import { COUNCIL_POLICY_VERSION } from './evaluate.js';
import {
  applyEvidencePolicy,
  capsForStage,
  EVIDENCE_CONTRACT_VERSION,
  normalizeHistoricalAssessment,
  normalizeHistoricalChoice,
} from './evidence-policy.js';

const SKILL_DIR = join(
  dirname(fileURLToPath(String(import.meta.url))),
  '..',
  '..',
  'skills',
  'investment-grading',
);
const FOLLOWUP_CONTRACT = readFileSync(
  join(SKILL_DIR, 'references', 'followup.md'),
  'utf8',
);

const FOLLOWUP_PROMPT =
  'STAGE: founder_followup\nAssess only the supplied founder answers against the frozen base evaluation. ' +
  'Do not search or reconsider unrelated dimensions. Return one assessment for every answer. Return a dimension ' +
  'update only where an answer materially changes quality, confidence, or cap status; an update may preserve the ' +
  'same quality rating. Choose quality before missing-evidence treatment and use only Radar-provided stage caps. ' +
  'Use rubric dimension names exactly as written. Radar preserves untouched ratings and computes effective scores. ' +
  'Use at most two short sentences per rationale and no more than three concrete missing-evidence items. Do not ' +
  'restate the frozen evaluation, rubric, or unrelated facts.';

const FOLLOWUP_SCHEMA = {
  type: 'object',
  properties: {
    dimension_updates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          quality_likert: { type: 'number', minimum: 1, maximum: 5 },
          rationale: { type: 'string', maxLength: 480 },
          evidence_sufficiency: { type: 'string', enum: ['strong', 'partial', 'thin'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          missing_evidence_treatment: {
            type: 'string',
            enum: ['none', 'confidence_only', 'stage_cap'],
          },
          stage_cap_id: { type: ['string', 'null'] },
          missing_evidence: {
            type: 'array',
            maxItems: 3,
            items: { type: 'string', maxLength: 180 },
          },
        },
        required: [
          'name',
          'quality_likert',
          'rationale',
          'evidence_sufficiency',
          'confidence',
          'missing_evidence_treatment',
          'stage_cap_id',
          'missing_evidence',
        ],
        additionalProperties: false,
      },
    },
    answer_assessments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question_id: { type: 'string' },
          assessment: {
            type: 'string',
            enum: ['supports', 'weakens', 'mixed', 'insufficient'],
          },
          rationale: { type: 'string', maxLength: 360 },
        },
        required: ['question_id', 'assessment', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['dimension_updates', 'answer_assessments'],
  additionalProperties: false,
};

function hash(value) {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

function normalizedName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/[^a-z0-9]+/g, '');
}

function jsonValue(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function structured(result) {
  if (result.structuredOutput) return result.structuredOutput;
  try { return JSON.parse(result.text); } catch {
    throw new Error('Council founder follow-up did not return structured output');
  }
}

function baseEvidenceAssessments(baseEvaluation, choices) {
  const saved = jsonValue(baseEvaluation.council_evidence_assessments, null);
  if (Array.isArray(saved) && saved.length > 0) return saved.map(normalizeHistoricalAssessment);
  return choices.map(choice => ({
    name: choice.name,
    sufficiency: 'thin',
    rationale: 'Evidence sufficiency was not recorded in the base evaluation.',
    missing_evidence: ['Reconfirm the evidence supporting this dimension.'],
    confidence: 'low',
    score_effect: 'confidence_only',
    stage_cap_id: null,
  }));
}

function validateOutput(output, answers, choices, rubric) {
  const expectedByName = new Map(
    rubric.sections
      .flatMap(section => section.dimensions || [])
      .map(dimension => [normalizedName(dimension.name), dimension.name]),
  );
  const hasUnscopedQuestion = answers.some(answer => !answer.rubric_dimension);
  const scopedNames = new Set(
    answers
      .map(answer => normalizedName(answer.rubric_dimension))
      .filter(Boolean),
  );
  const updates = [];
  const seenUpdates = new Set();
  for (const update of output.dimension_updates || []) {
    const key = normalizedName(update.name);
    const canonicalName = expectedByName.get(key);
    if (!canonicalName || seenUpdates.has(key)) {
      throw new Error(`Founder follow-up returned an unknown or repeated dimension: ${update.name}`);
    }
    if (!hasUnscopedQuestion && scopedNames.size > 0 && !scopedNames.has(key)) {
      throw new Error(`Founder follow-up changed an unrelated dimension: ${canonicalName}`);
    }
    seenUpdates.add(key);
    updates.push({ ...update, name: canonicalName });
  }
  const expectedQuestionIds = new Set(answers.map(answer => String(answer.id)));
  const seenAnswers = new Set();
  for (const assessment of output.answer_assessments || []) {
    const id = String(assessment.question_id);
    if (!expectedQuestionIds.has(id) || seenAnswers.has(id)) {
      throw new Error(`Founder follow-up returned an unknown or repeated question id: ${id}`);
    }
    seenAnswers.add(id);
  }
  if (seenAnswers.size !== expectedQuestionIds.size) {
    throw new Error('Founder follow-up must assess every supplied answer');
  }

  const updateByName = new Map(updates.map(update => [normalizedName(update.name), update]));
  const dimensionScores = choices.map(choice => {
    const update = updateByName.get(normalizedName(choice.name));
    return update
      ? {
        ...choice,
        name: choice.name,
        quality_likert: update.quality_likert,
        rationale: update.rationale,
        missing_evidence_treatment: update.missing_evidence_treatment,
        stage_cap_id: update.stage_cap_id,
      }
      : choice;
  });
  return { ...output, dimension_updates: updates, dimension_scores: dimensionScores };
}

function mergedEvidenceAssessments(base, updates) {
  const updateByName = new Map(updates.map(update => [normalizedName(update.name), update]));
  return base.map(assessment => {
    const update = updateByName.get(normalizedName(assessment.name));
    return update
      ? {
        name: assessment.name,
        sufficiency: update.evidence_sufficiency,
        rationale: update.rationale,
        missing_evidence: update.missing_evidence,
        confidence: update.confidence,
        score_effect: update.missing_evidence_treatment,
        stage_cap_id: update.stage_cap_id,
      }
      : assessment;
  });
}

function slug(value) {
  return String(value || 'deal')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function renderArtifact({
  company,
  baseEvaluation,
  answers,
  output,
  evidenceAssessments,
  rubric,
  inputHash,
}) {
  const canonical = scoreCouncilChoices(output.dimension_scores, rubric);
  const rationaleByName = new Map(
    output.dimension_scores.map(choice => [normalizedName(choice.name), choice.rationale]),
  );
  const sections = canonical.sections.map(section => [
    `## ${section.name}`,
    ...section.dimensions.map(dimension =>
      `- ${dimension.name}: ${dimension.likert}/5 — ${rationaleByName.get(normalizedName(dimension.name)) || ''}`),
    `- **${section.name} subtotal: ${section.points}/25**`,
  ].join('\n')).join('\n\n');
  const assessmentById = new Map(
    output.answer_assessments.map(assessment => [String(assessment.question_id), assessment]),
  );
  const answerText = answers.map(answer => {
    const assessment = assessmentById.get(String(answer.id));
    return [
      `### ${answer.question}`,
      `**Founder answer:** ${answer.answer}`,
      `**Assessment:** ${assessment.assessment} — ${assessment.rationale}`,
    ].join('\n');
  }).join('\n\n');
  const sufficiencyText = evidenceAssessments.map(assessment => {
    const missing = assessment.missing_evidence?.length
      ? ` Missing: ${assessment.missing_evidence.join('; ')}.`
      : '';
    const effect = assessment.score_effect === 'stage_cap'
      ? `Stage cap: ${assessment.stage_cap_id}`
      : 'No score effect';
    return `- **${assessment.name}: ${assessment.confidence} confidence** — ${effect}. ${assessment.rationale}${missing}`;
  }).join('\n');
  const timestamp = new Date().toISOString();
  const date = timestamp.slice(0, 10);
  return {
    filename: `${date}-${slug(company)}-founder-followup-${inputHash.slice(0, 8)}-${timestamp.slice(11, 23).replace(/\D/g, '')}.md`,
    canonical,
    content: `# Deal Log: ${company}

**Date:** ${date} · targeted founder follow-up · base evaluation: ${baseEvaluation.id}

## Founder Follow-up
${answerText}

## Evidence Confidence
${sufficiencyText}

${sections}

## Total: ${canonical.totalScore}/50
## Verdict: ${canonical.verdict}

## Council Evaluation

| Voice | Score | Key argument |
|---|---|---|
| Calibrator | ${canonical.totalScore}/50 | Targeted reassessment of founder answers; untouched dimensions preserve the base evaluation. |
`,
  };
}

export async function councilFollowupEvaluate({
  baseEvaluation,
  answers,
  company,
}, opts = {}) {
  if (!baseEvaluation?.id) throw new Error('Founder follow-up requires a base evaluation');
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new Error('Founder follow-up requires at least one answered question');
  }
  const {
    provider,
    buildFallback,
    models,
    env = process.env,
    policyId = baseEvaluation.council_policy || 'balanced',
    dealLogDir,
    maxTurns = 2,
    model,
    effort,
  } = opts;
  if (!provider) throw new Error('Founder follow-up requires a provider');
  if (!dealLogDir) throw new Error('Founder follow-up requires dealLogDir');

  const rubric = jsonValue(baseEvaluation.council_rubric_snapshot, null) || getRubric();
  const baseContent = baseEvaluation.raw_content || baseEvaluation.content_markdown;
  if (!baseContent) throw new Error('Founder follow-up requires the base evaluation artifact');
  const savedChoices = jsonValue(baseEvaluation.council_dimension_scores, null);
  const choices = (Array.isArray(savedChoices) && savedChoices.length > 0
    ? savedChoices
    : parseCouncilChoices(baseContent, rubric)).map(normalizeHistoricalChoice);
  scoreCouncilChoices(choices, rubric);

  const policy = resolveCouncilModels(models);
  const followupModel = model
    || env.RADAR_COUNCIL_FOLLOWUP_MODEL
    || 'claude-sonnet-4-6';
  const followupEffort = effort
    || env.RADAR_COUNCIL_FOLLOWUP_EFFORT
    || 'low';
  const followupModelPolicy = {
    ...policy,
    calibrator: followupModel,
    followup_effort: followupEffort,
  };
  const input = {
    base_evaluation_id: baseEvaluation.id,
    questions: answers.map(answer => ({
      question_id: String(answer.id),
      question: answer.question,
      why_it_matters: answer.why_it_matters,
      rubric_dimension: answer.rubric_dimension,
      answer: answer.answer,
      answer_source: answer.answer_source,
    })),
  };
  const inputHash = hash(input);
  const instructionHash = hash({
    contract: FOLLOWUP_CONTRACT,
    prompt: FOLLOWUP_PROMPT,
    schema: FOLLOWUP_SCHEMA,
  });
  const provenance = {
    policyId,
    policyVersion: COUNCIL_POLICY_VERSION,
    evidenceContractVersion: EVIDENCE_CONTRACT_VERSION,
    instructionHash,
    lensHash: baseEvaluation.council_lens_hash || hash(rubric),
    calibrationHash: baseEvaluation.council_calibration_hash || null,
    inputHash,
    parentEvaluationId: baseEvaluation.id,
    rubricSnapshot: rubric,
    runType: 'founder_followup',
  };
  provenance.runKey = hash({
    ...provenance,
    answerIds: answers.map(answer => answer.id),
    model: followupModel,
  });

  const request = {
    prompt: FOLLOWUP_PROMPT,
    systemPrompt: FOLLOWUP_CONTRACT,
    context: [
      'AUTHORITATIVE RUBRIC',
      JSON.stringify(rubric),
      'FROZEN BASE DIMENSION SCORES',
      JSON.stringify(choices),
      'FROZEN BASE EVIDENCE SUFFICIENCY',
      JSON.stringify(baseEvidenceAssessments(baseEvaluation, choices)),
      'VALID STAGE CAPS (only these IDs may be proposed)',
      JSON.stringify(capsForStage(baseEvaluation.stage || baseEvaluation.round || baseEvaluation.deal_stage)),
      'FOUNDER QUESTIONS AND ANSWERS',
      JSON.stringify(input.questions),
    ].join('\n\n'),
    model: followupModel,
    tools: [],
    outputFormat: { type: 'json_schema', schema: FOLLOWUP_SCHEMA },
    maxTurns,
    effort: followupEffort,
  };
  const outcome = await runWithFallback(request, {
    primary: provider,
    currentMode: resolveAuthMode(env),
    fallbackEnabled: resolveFallbackFlag(env),
    buildFallback,
    env,
  });
  const output = validateOutput(structured(outcome.result), answers, choices, rubric);
  let evidenceAssessments = mergedEvidenceAssessments(
    baseEvidenceAssessments(baseEvaluation, choices),
    output.dimension_updates,
  );
  const policyResult = applyEvidencePolicy({
    stage: baseEvaluation.stage || baseEvaluation.round || baseEvaluation.deal_stage,
    dimensionChoices: output.dimension_scores,
    evidenceAssessments,
  });
  output.dimension_scores = policyResult.dimensionChoices;
  output.cap_receipt = policyResult.capReceipt;
  evidenceAssessments = policyResult.evidenceAssessments;
  const artifact = renderArtifact({
    company,
    baseEvaluation,
    answers,
    output,
    evidenceAssessments,
    rubric,
    inputHash,
  });
  mkdirSync(dealLogDir, { recursive: true });
  writeFileSync(join(dealLogDir, artifact.filename), artifact.content, 'utf8');
  provenance.dimensionScores = output.dimension_scores;
  provenance.evidenceAssessments = evidenceAssessments;
  provenance.evidenceCapReceipt = policyResult.capReceipt;
  provenance.followupQuestions = [];
  provenance.artifactHashes = { [artifact.filename]: hash(artifact.content) };
  provenance.sessionId = outcome.result.sessionId || null;
  provenance.modelPolicy = followupModelPolicy;

  return {
    result: {
      text: `Founder follow-up applied: ${artifact.canonical.totalScore}/50 · ${artifact.canonical.verdict}`,
      structuredOutput: output,
      sessionId: outcome.result.sessionId || null,
      model: followupModel,
      apiKeySource: outcome.result.apiKeySource || null,
      usage: outcome.result.usage || {},
    },
    usage: outcome.result.usage || {},
    usedFallback: outcome.usedFallback,
    primaryErrorKind: outcome.primaryErrorKind,
    modelPolicy: followupModelPolicy,
    effort: followupEffort,
    writtenFiles: [artifact.filename],
    provenance,
  };
}
