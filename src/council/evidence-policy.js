// Deterministic Council evidence policy.
//
// Models judge substantive quality and identify missing evidence. Radar owns
// the finite stage-cap registry, validates proposed cap use, and computes the
// effective Likert used by the canonical 50-point rubric.

export const EVIDENCE_POLICY_VERSION = 9;
export const EVIDENCE_CONTRACT_VERSION = 2;

const STAGE_CAPS = Object.freeze([
  Object.freeze({
    id: 'series_a_actual_revenue_missing',
    stages: Object.freeze(['series-a']),
    dimension: 'Business model clarity',
    maximum: 3,
    requirement: 'Actual revenue evidence must be supplied or verified.',
    trigger: 'No actual revenue evidence was supplied or verified.',
  }),
  Object.freeze({
    id: 'series_b_unit_economics_missing',
    stages: Object.freeze(['series-b-plus']),
    dimension: 'Business model clarity',
    maximum: 1,
    requirement: 'Proven unit-economics evidence must be supplied or verified.',
    trigger: 'No proven unit-economics evidence was supplied or verified.',
  }),
]);

function normalizedName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/[^a-z0-9]+/g, '');
}

export function normalizeCouncilStage(value) {
  const stage = String(value || '').trim().toLowerCase().replace(/[–—_]/g, '-').replace(/\s+/g, ' ');
  if (['pre-seed', 'pre seed', 'preseed'].includes(stage)) return 'pre-seed';
  if (['seed', 'seed+', 'seed extension', 'seed-extension', 'seed ext'].includes(stage)) return 'seed';
  if (['series a', 'series a+', 'series-a', 'series-a+'].includes(stage)) return 'series-a';
  if (/^series [b-z]\+?$/.test(stage) || /^series-[b-z]\+?$/.test(stage)) return 'series-b-plus';
  if (['growth', 'late stage', 'late-stage', 'growth equity'].includes(stage)) return 'series-b-plus';
  return 'unknown';
}

export function capsForStage(stage) {
  const normalizedStage = normalizeCouncilStage(stage);
  return STAGE_CAPS
    .filter(cap => cap.stages.includes(normalizedStage))
    .map(cap => ({ ...cap, stages: [...cap.stages] }));
}

export function normalizeHistoricalChoice(choice) {
  const likert = Number(choice?.likert);
  return {
    ...choice,
    likert,
    quality_likert: choice?.quality_likert == null ? likert : Number(choice.quality_likert),
    missing_evidence_treatment: choice?.missing_evidence_treatment || 'confidence_only',
    stage_cap_id: choice?.stage_cap_id || null,
  };
}

export function normalizeHistoricalAssessment(assessment) {
  return {
    ...assessment,
    confidence: assessment?.confidence || 'low',
    score_effect: assessment?.score_effect || 'confidence_only',
    stage_cap_id: assessment?.stage_cap_id || null,
  };
}

export function applyEvidencePolicy({ stage, dimensionChoices, evidenceAssessments }) {
  const normalizedStage = normalizeCouncilStage(stage);
  const assessmentsByName = new Map();
  for (const assessment of evidenceAssessments || []) {
    const key = normalizedName(assessment.name);
    if (!key || assessmentsByName.has(key)) {
      throw new Error(`Council evidence assessment has a missing or repeated dimension: ${assessment.name}`);
    }
    assessmentsByName.set(key, assessment);
  }
  if ((dimensionChoices || []).length !== assessmentsByName.size) {
    throw new Error('Council dimension choices and evidence assessments must correspond exactly');
  }

  const applied = [];
  const seenChoices = new Set();
  const enrichedChoices = (dimensionChoices || []).map(choice => {
    const key = normalizedName(choice.name);
    if (!key || seenChoices.has(key)) {
      throw new Error(`Council output has a missing or repeated dimension: ${choice.name}`);
    }
    seenChoices.add(key);
    const assessment = assessmentsByName.get(key);
    if (!assessment) throw new Error(`Council output is missing evidence assessment for ${choice.name}`);

    const qualityLikert = Number(choice.quality_likert);
    if (!Number.isFinite(qualityLikert) || qualityLikert < 1 || qualityLikert > 5) {
      throw new Error(`Council quality Likert for ${choice.name} must be 1–5`);
    }
    const treatment = choice.missing_evidence_treatment;
    if (!['none', 'confidence_only', 'stage_cap'].includes(treatment)) {
      throw new Error(`Council output has unsupported missing-evidence treatment for ${choice.name}`);
    }
    if (assessment.score_effect !== treatment) {
      throw new Error(`Council evidence treatment disagrees for ${choice.name}`);
    }
    if (!['high', 'medium', 'low'].includes(assessment.confidence)) {
      throw new Error(`Council evidence confidence for ${choice.name} must be high, medium, or low`);
    }
    const choiceCapId = choice.stage_cap_id || null;
    const assessmentCapId = assessment.stage_cap_id || null;
    if (choiceCapId !== assessmentCapId) {
      throw new Error(`Council stage cap disagrees for ${choice.name}`);
    }
    if (treatment !== 'stage_cap' && choiceCapId) {
      throw new Error(`Council output provided a stage cap without stage_cap treatment for ${choice.name}`);
    }
    if (treatment === 'stage_cap' && !choiceCapId) {
      throw new Error(`Council output omitted the stage cap ID for ${choice.name}`);
    }

    let likert = qualityLikert;
    if (choiceCapId) {
      const cap = STAGE_CAPS.find(candidate => candidate.id === choiceCapId);
      if (!cap) throw new Error(`Unknown stage cap: ${choiceCapId}`);
      if (!cap.stages.includes(normalizedStage) || normalizedName(cap.dimension) !== key) {
        throw new Error(`Stage cap ${choiceCapId} does not apply to ${choice.name} at ${stage || 'unknown stage'}`);
      }
      likert = Math.min(qualityLikert, cap.maximum);
      applied.push({
        cap_id: cap.id,
        stage: normalizedStage,
        dimension: cap.dimension,
        requirement: cap.requirement,
        trigger: cap.trigger,
        quality_likert: qualityLikert,
        configured_cap: cap.maximum,
        effective_likert: likert,
      });
    }
    return {
      ...choice,
      quality_likert: qualityLikert,
      likert,
      stage_cap_id: choiceCapId,
    };
  });

  return {
    dimensionChoices: enrichedChoices,
    evidenceAssessments: (evidenceAssessments || []).map(assessment => ({
      ...assessment,
      stage_cap_id: assessment.stage_cap_id || null,
    })),
    capReceipt: {
      policy_version: EVIDENCE_POLICY_VERSION,
      evidence_contract_version: EVIDENCE_CONTRACT_VERSION,
      normalized_stage: normalizedStage,
      applied,
    },
  };
}
