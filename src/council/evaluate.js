// evaluate.js — Phase B1: councilEvaluate(), the normalized council path.
//
// Runs the vendored headless investment-grading skill as five explicit sessions:
// research, Bull, Bear, Calibrator, and CFO. Radar deterministically seeds the
// research questions; Sonnet adds and executes up to three deal-specific gaps
// in the same session. Research is frozen before either grader runs, and only
// Radar writes the final artifact.
//
// This module is SDK-free and pure orchestration: the provider is injected, so
// it is fully unit-testable with a fake. The CLI (C1) constructs the real
// AgentSdkProvider + api_key fallback factory and passes them in.

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import {
  getRubric,
  getKillCriteria,
  getGpTiers,
  getTheses,
  getThesisClusters,
  getRoundParams,
} from '../lenses/loader.js';
import { getCalibration } from '../lenses/calibration.js';
import { query } from '../db/index.js';
import { resolveCouncilModels } from '../providers/council-models.js';
import { runWithFallback, resolveFallbackFlag } from '../providers/session-errors.js';
import { resolveAuthMode } from '../providers/auth-mode.js';
import { scoreCouncilChoices } from './scoring.js';

const SKILL_DIR = join(
  dirname(fileURLToPath(String(import.meta.url))),
  '..',
  '..',
  'skills',
  'investment-grading'
);
const SKILL_PATH = join(SKILL_DIR, 'SKILL.md');
const ROLE_PATHS = Object.freeze({
  research: join(SKILL_DIR, 'references', 'research.md'),
  bull: join(SKILL_DIR, 'references', 'bull.md'),
  bear: join(SKILL_DIR, 'references', 'bear.md'),
  calibrator: join(SKILL_DIR, 'references', 'calibrator.md'),
  cfo: join(SKILL_DIR, 'references', 'cfo.md'),
});

let _skill;
function loadSkill() {
  if (_skill == null) _skill = readFileSync(SKILL_PATH, 'utf8');
  return _skill;
}

const _rolePrompts = new Map();
function loadRolePrompt(stage) {
  if (!ROLE_PATHS[stage]) throw new Error(`Unknown Council stage: ${stage}`);
  if (!_rolePrompts.has(stage)) {
    _rolePrompts.set(stage, readFileSync(ROLE_PATHS[stage], 'utf8'));
  }
  return _rolePrompts.get(stage);
}

export const COUNCIL_POLICY_VERSION = 8;
const EXPLICIT_PIPELINE_VERSION = 'sonnet-seeded-research-v1';
const RESEARCH_PLAN_SEED_VERSION = 'baseline-v1';
const inFlightRuns = new Map();

function hash(value) {
  const content = typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : JSON.stringify(value);
  return createHash('sha256').update(content).digest('hex');
}

function structured(result, stage) {
  if (result.structuredOutput) return result.structuredOutput;
  try {
    return JSON.parse(result.text);
  } catch {
    throw new Error(`Council ${stage} stage did not return structured output`);
  }
}

const DIMENSION_ARRAY = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      likert: { type: 'number', minimum: 1, maximum: 5 },
      rationale: { type: 'string' },
    },
    required: ['name', 'likert', 'rationale'],
    additionalProperties: false,
  },
};

const GRADER_SCHEMA = {
  type: 'object',
  properties: {
    dimension_scores: DIMENSION_ARRAY,
    key_argument: { type: 'string' },
  },
  required: ['dimension_scores', 'key_argument'],
  additionalProperties: false,
};

const EVIDENCE_ASSESSMENT_ARRAY = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      sufficiency: { type: 'string', enum: ['strong', 'partial', 'thin'] },
      rationale: { type: 'string' },
      missing_evidence: { type: 'array', items: { type: 'string' } },
    },
    required: ['name', 'sufficiency', 'rationale', 'missing_evidence'],
    additionalProperties: false,
  },
};

const FOLLOWUP_QUESTION_ARRAY = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      question_id: { type: 'string' },
      question: { type: 'string' },
      why_it_matters: { type: 'string' },
      rubric_dimension: { type: 'string' },
      upside_likert: { type: 'number', minimum: 1, maximum: 5 },
      downside_likert: { type: 'number', minimum: 1, maximum: 5 },
      priority: { type: 'string', enum: ['critical', 'helpful'] },
    },
    required: [
      'question_id',
      'question',
      'why_it_matters',
      'rubric_dimension',
      'upside_likert',
      'downside_likert',
      'priority',
    ],
    additionalProperties: false,
  },
};

const CALIBRATOR_SCHEMA = {
  type: 'object',
  properties: {
    dimension_scores: DIMENSION_ARRAY,
    evidence_assessments: EVIDENCE_ASSESSMENT_ARRAY,
    key_argument: { type: 'string' },
    kill_criteria: { type: 'string' },
    primary_thesis: { type: 'string' },
    moves_up: { type: 'array', items: { type: 'string' } },
    moves_down: { type: 'array', items: { type: 'string' } },
    net_assessment: { type: 'string' },
    key_questions: FOLLOWUP_QUESTION_ARRAY,
    email: { type: 'string' },
    linkedin: { type: 'string' },
  },
  required: [
    'dimension_scores', 'evidence_assessments', 'key_argument', 'kill_criteria', 'primary_thesis',
    'moves_up', 'moves_down', 'net_assessment', 'key_questions', 'email', 'linkedin',
  ],
  additionalProperties: false,
};

const CUSTOM_QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    question_id: { type: 'string' },
    coverage_area: {
      type: 'string',
      enum: [
        'identity_status',
        'team',
        'company_financing',
        'traction_economics',
        'product_differentiation',
        'competition',
        'market_external',
        'compounding_portfolio',
        'falsification',
      ],
    },
    question: { type: 'string' },
    rubric_dimensions: { type: 'array', items: { type: 'string' } },
    evidence_target: { type: 'string' },
    preferred_sources: { type: 'array', items: { type: 'string' } },
    recency_requirement: { type: 'string' },
    search_queries: { type: 'array', items: { type: 'string' } },
    required: { type: 'boolean' },
  },
  required: [
    'question_id',
    'coverage_area',
    'question',
    'rubric_dimensions',
    'evidence_target',
    'preferred_sources',
    'recency_requirement',
    'search_queries',
    'required',
  ],
  additionalProperties: false,
};

const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    evidence: { type: 'array', items: { type: 'string' } },
    team_dossier: { type: 'string' },
    company_context: { type: 'string' },
    custom_questions: { type: 'array', items: CUSTOM_QUESTION_SCHEMA },
    critical_unknowns: { type: 'array', items: { type: 'string' } },
    contradictions_to_resolve: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'evidence',
    'team_dossier',
    'company_context',
    'custom_questions',
    'critical_unknowns',
    'contradictions_to_resolve',
  ],
  additionalProperties: false,
};

const BASELINE_RESEARCH_QUESTIONS = Object.freeze([
  {
    question_id: 'baseline-identity-status',
    coverage_area: 'identity_status',
    question: 'Confirm {company} is the correct entity and establish its current operating status, product, location, and any material name ambiguity.',
    rubric_dimensions: ['Source quality', 'Business model clarity'],
    confirming_evidence: 'Current first-party records and authoritative third-party records agree on identity and status.',
    disconfirming_evidence: 'Entity mismatch, stale records, shutdown, pivot, or conflicting company identity.',
    preferred_sources: ['Official company materials', 'Corporate and regulatory records', 'Current reputable reporting'],
    recency_requirement: 'Use the newest available source and flag evidence older than 18 months.',
    search_queries: ['"{company}" company current status', '"{company}" official company founders'],
    required: true,
  },
  {
    question_id: 'baseline-team',
    coverage_area: 'team',
    question: 'Who founded and currently leads {company}, and what verified experience, domain credentials, prior outcomes, or contradictory history bears on team-market fit?',
    rubric_dimensions: ['Team-market fit', 'Source quality'],
    confirming_evidence: 'Verified roles, directly relevant operating history, and demonstrated prior execution.',
    disconfirming_evidence: 'Role ambiguity, unsupported biographies, material turnover, or weak relevant experience.',
    preferred_sources: ['Company and founder profiles', 'Professional profiles', 'Prior-company records', 'Reputable reporting'],
    recency_requirement: 'Confirm current leadership; historical evidence may be older when clearly dated.',
    search_queries: ['"{company}" founders leadership', '"{company}" founder background prior company'],
    required: true,
  },
  {
    question_id: 'baseline-financing',
    coverage_area: 'company_financing',
    question: 'What can be established about {company}’s current offered round, valuation, deal source or syndicate, cumulative financing, and the quality of this access?',
    rubric_dimensions: ['Capital efficiency', 'Source quality', 'Portfolio construction fit'],
    confirming_evidence: 'The submitted current offering establishes the terms being offered; primary or reputable independent sources may corroborate the company and historical financing.',
    disconfirming_evidence: 'An explicit same-round incompatibility, weak source connection, or unexplained capitalization—not mere absence from public records.',
    preferred_sources: ['Financing announcements', 'Regulatory filings', 'Lead investor materials', 'Reputable databases and reporting'],
    recency_requirement: 'Prioritize the active or most recent financing.',
    search_queries: ['"{company}" funding round valuation investors', '"{company}" financing lead investor'],
    required: true,
  },
  {
    question_id: 'baseline-traction-economics',
    coverage_area: 'traction_economics',
    question: 'What stage-appropriate evidence exists for {company}’s adoption, revenue, retention, margins, burn, unit economics, and capital required to reach the next proof point?',
    rubric_dimensions: ['Capital efficiency', 'Business model clarity', 'Compounding structure'],
    confirming_evidence: 'Current quantified operating evidence with a clear denominator, period, and source.',
    disconfirming_evidence: 'Unverified vanity metrics, weak retention, poor margins, high burn, or no credible path to the next milestone.',
    preferred_sources: ['Company disclosures', 'Customer evidence', 'Financial or regulatory records', 'Reputable interviews and reporting'],
    recency_requirement: 'Prefer evidence from the last 18 months and date every metric.',
    search_queries: ['"{company}" revenue customers retention', '"{company}" unit economics burn margins'],
    required: true,
  },
  {
    question_id: 'baseline-product-moat',
    coverage_area: 'product_differentiation',
    question: 'How does {company}’s product work, what is actually differentiated, and what IP, data, regulation, distribution, switching cost, or technical evidence makes that advantage durable?',
    rubric_dimensions: ['Differentiation', 'Domain match', 'Business model clarity'],
    confirming_evidence: 'Specific technical, customer, IP, regulatory, or distribution evidence supports a hard-to-replicate advantage.',
    disconfirming_evidence: 'The claimed moat is generic, easily replicated, unsupported, or dependent on a temporary feature lead.',
    preferred_sources: ['Technical documentation', 'Patents and regulatory records', 'Customer evidence', 'Independent technical reporting'],
    recency_requirement: 'Use current product evidence; older foundational IP is acceptable when still relevant.',
    search_queries: ['"{company}" product technology differentiation patents', '"{company}" customer case study technical'],
    required: true,
  },
  {
    question_id: 'baseline-competition',
    coverage_area: 'competition',
    question: 'Which direct competitors, incumbents, and substitutes constrain {company}, and how do their products, traction, capitalization, and distribution compare?',
    rubric_dimensions: ['Differentiation', 'Structural tailwind', 'Business model clarity'],
    confirming_evidence: 'Independent comparisons show a meaningful advantage against the strongest realistic alternative.',
    disconfirming_evidence: 'Better-capitalized or better-distributed alternatives offer equivalent value or customers can avoid the category.',
    preferred_sources: ['Competitor primary materials', 'Customer and industry sources', 'Financing records', 'Independent comparisons'],
    recency_requirement: 'Prefer competitive evidence from the last 18 months.',
    search_queries: ['"{company}" competitors alternatives', '"{company}" versus competitor market'],
    required: true,
  },
  {
    question_id: 'baseline-market-external',
    coverage_area: 'market_external',
    question: 'What independent evidence supports the market need and durable tailwind for {company}, and what regulatory, policy, procurement, or macro forces could accelerate or impair adoption?',
    rubric_dimensions: ['Structural tailwind', 'Domain match'],
    confirming_evidence: 'Independent demand, budget, policy, or adoption evidence supports a durable timing advantage.',
    disconfirming_evidence: 'Market estimates rely on vendor claims or adoption faces material policy, procurement, or macro headwinds.',
    preferred_sources: ['Government and regulatory sources', 'Industry data', 'Customer budgets and procurement records', 'Independent research'],
    recency_requirement: 'Use current market and policy evidence, normally within 24 months.',
    search_queries: ['"{company}" market regulation demand', '"{company}" industry adoption procurement'],
    required: true,
  },
  {
    question_id: 'baseline-compounding-portfolio',
    coverage_area: 'compounding_portfolio',
    question: 'What evidence shows {company} can compound through retention, expansion, data, network, workflow, or distribution effects, and does this deal add or duplicate current portfolio, GP, stage, and concentration exposure?',
    rubric_dimensions: ['Compounding structure', 'Portfolio construction fit'],
    confirming_evidence: 'Observed retention or expansion mechanics and a distinct role in the portfolio support durable compounding.',
    disconfirming_evidence: 'The model is transactional, retention is weak, or the exposure materially duplicates existing concentration.',
    preferred_sources: ['Customer and operating evidence', 'Product documentation', 'Portfolio records', 'Lead investor materials'],
    recency_requirement: 'Use current operating and portfolio context.',
    search_queries: ['"{company}" retention expansion customers', '"{company}" business model recurring revenue'],
    required: true,
  },
  {
    question_id: 'baseline-falsification',
    coverage_area: 'falsification',
    question: 'What is the strongest current evidence against the investment case for {company}, including material litigation, regulatory action, customer loss, layoffs, failed milestones, adverse technical evidence, or recent negative change?',
    rubric_dimensions: ['Source quality', 'Team-market fit', 'Capital efficiency', 'Differentiation'],
    confirming_evidence: 'Independent current evidence fails to surface a material undisclosed contradiction after targeted checks.',
    disconfirming_evidence: 'A credible adverse event or contradiction weakens a load-bearing claim in the deal materials.',
    preferred_sources: ['Court and regulatory records', 'Company disclosures', 'Customer evidence', 'Reputable investigative and trade reporting'],
    recency_requirement: 'Prioritize events from the last 24 months while retaining older unresolved matters.',
    search_queries: ['"{company}" lawsuit regulatory layoffs customer loss', '"{company}" controversy failed milestone'],
    required: true,
  },
]);

function templateForDeal(value, company) {
  return String(value).replaceAll('{company}', company);
}

export function buildBaselineResearchPlan(deal = {}) {
  const company = String(deal.company || deal.company_name || 'the company').trim() || 'the company';
  return {
    seed_version: RESEARCH_PLAN_SEED_VERSION,
    deal_identity: company,
    decision_frame: `Test the supplied case for ${company} against the active Radar rubric using current, decision-relevant evidence.`,
    priority_question_ids: BASELINE_RESEARCH_QUESTIONS.map(question => question.question_id),
    questions: BASELINE_RESEARCH_QUESTIONS.map(question => ({
      ...question,
      question: templateForDeal(question.question, company),
      confirming_evidence: templateForDeal(question.confirming_evidence, company),
      disconfirming_evidence: templateForDeal(question.disconfirming_evidence, company),
      search_queries: question.search_queries.map(query => templateForDeal(query, company)),
    })),
    critical_unknowns: [],
    contradictions_to_resolve: [],
    stop_conditions: [
      'Every required question is answered with sourced evidence or explicitly marked unavailable.',
      'Material supplied claims are labeled verified, conflicting, or unavailable.',
      'Additional retrieval is unlikely to change a rubric choice or resolve a named contradiction.',
    ],
  };
}

function mergeResearchPlan(baseline, adaptation) {
  const baselineIds = new Set(baseline.questions.map(question => question.question_id));
  const priorityQuestionIds = [...new Set(adaptation.priority_question_ids || [])]
    .filter(questionId => baselineIds.has(questionId));
  const customQuestions = (adaptation.custom_questions || []).slice(0, 3).map((question, index) => ({
    question_id: question.question_id || `custom-${index + 1}`,
    coverage_area: question.coverage_area,
    question: question.question,
    rubric_dimensions: question.rubric_dimensions,
    confirming_evidence: question.evidence_target,
    disconfirming_evidence: question.evidence_target,
    preferred_sources: question.preferred_sources,
    recency_requirement: question.recency_requirement,
    search_queries: question.search_queries,
    required: question.required,
  }));
  return {
    ...baseline,
    deal_identity: adaptation.deal_identity || baseline.deal_identity,
    decision_frame: adaptation.decision_frame || baseline.decision_frame,
    priority_question_ids: [
      ...priorityQuestionIds,
      ...baseline.priority_question_ids.filter(questionId => !priorityQuestionIds.includes(questionId)),
      ...customQuestions.map(question => question.question_id),
    ],
    questions: [...baseline.questions, ...customQuestions],
    critical_unknowns: adaptation.critical_unknowns || [],
    contradictions_to_resolve: adaptation.contradictions_to_resolve || [],
  };
}

const CFO_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['Deploy', 'Defer', 'Pass'] },
    reason: { type: 'string' },
  },
  required: ['verdict', 'reason'],
  additionalProperties: false,
};

const STAGE_PROMPTS = {
  research:
    'STAGE: research\nUse Radar’s deterministic baseline as the research plan. Before searching, identify zero to three ' +
    'material deal-specific questions that the baseline does not cover, then research those gaps in this same session. ' +
    'Build one shared factual evidence packet for the deal. ' +
    'Use web search when useful. Return at least one evidence line for every required question ID. Format each line as ' +
    '[question_id] STATUS | narrowly stated fact | event date | source title and publication date | URL. STATUS must be ' +
    'supplied, verified, conflicting, or unavailable. Current private-offering facts in the DEAL block are authoritative as terms ' +
    'being offered and must remain SUPPLIED even when they are not public. The DEAL lead identifies the source or syndicate ' +
    'presenting access unless the materials explicitly call it the company round lead. Do not turn a prior public round or the ' +
    'absence of a public announcement into a conflict with a current private offering. Verify entity and date before recording a ' +
    'claim; reserve CONFLICTING for an explicit, mutually incompatible claim about the same entity, event, and time period. When credible sources ' +
    'conflict, record both claims instead of choosing silently. Never infer that something did not happen merely because a ' +
    'search did not find it. Keep the team dossier and company context neutral and sourced—no scoring, risk conclusions, or ' +
    'guilt by association. Cover every required baseline and custom question, merge exact duplicates, and stop when further retrieval is unlikely ' +
    'to resolve a named conflict or change the factual packet. Do not score the deal or simulate another Council voice.',
  bull:
    'STAGE: bull\nPerform only the Bull evaluation. Use only the frozen research packet in context; ' +
    'do not search or add facts. Return exactly one 1–5 Likert choice for every rubric dimension, ' +
    'using each dimension name exactly as written in the rubric, plus the strongest credible upside argument.',
  bear:
    'STAGE: bear\nPerform only the Bear evaluation. Use only the frozen research packet in context; ' +
    'do not search or add facts. Return exactly one 1–5 Likert choice for every rubric dimension, ' +
    'using each dimension name exactly as written in the rubric, plus the strongest credible skeptical argument.',
  calibrator:
    'STAGE: calibrator\nPerform only calibration. Reconcile the frozen Bull and Bear outputs against ' +
    'the authoritative rubric and calibration examples. Do not search or add facts. Return exactly one ' +
    '1–5 Likert choice for every rubric dimension, using each dimension name exactly as written. ' +
    'Separately rate evidence sufficiency for every dimension as strong, partial, or thin; do not use ' +
    'evidence sufficiency as a synonym for investment quality. Return no more than five founder follow-up ' +
    'questions. Each question must name one primary rubric dimension and the plausible 1–5 score if the ' +
    'founder answer confirms or weakens the current case. Ask for concrete facts, not opinions. ' +
    'Radar—not you—will calculate weighted points and the verdict.',
  cfo:
    'STAGE: cfo\nPerform only the portfolio-construction decision. Do not re-score or add facts. ' +
    'Using the frozen research packet and Radar-computed canonical score in context, return Deploy, Defer, or Pass.',
};

function stageRequest(stage, { model, context, schema, maxTurns }) {
  return {
    prompt: STAGE_PROMPTS[stage],
    systemPrompt: loadRolePrompt(stage),
    context,
    model,
    tools: stage === 'research' ? ['WebSearch'] : [],
    outputFormat: { type: 'json_schema', schema },
    maxTurns,
  };
}

async function runStage(stage, request, runtime) {
  const outcome = await runWithFallback(request, runtime);
  return {
    ...outcome,
    stage,
    data: structured(outcome.result, stage),
  };
}

function frozenPlannerStage(snapshot) {
  if (
    !snapshot
    || typeof snapshot.deal_identity !== 'string'
    || typeof snapshot.decision_frame !== 'string'
    || !Array.isArray(snapshot.questions)
    || !Array.isArray(snapshot.critical_unknowns)
    || !Array.isArray(snapshot.contradictions_to_resolve)
    || !Array.isArray(snapshot.stop_conditions)
  ) {
    throw new Error('Council planner snapshot does not match the research-plan contract');
  }
  return {
    stage: 'planner',
    data: snapshot,
    result: {
      model: null,
      numTurns: 0,
      sessionId: null,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
      },
    },
    usedFallback: false,
  };
}

function frozenResearchStage(snapshot) {
  if (
    !snapshot
    || !Array.isArray(snapshot.evidence)
    || typeof snapshot.team_dossier !== 'string'
    || typeof snapshot.company_context !== 'string'
  ) {
    throw new Error('Council research snapshot does not match the research contract');
  }
  return {
    stage: 'research',
    data: {
      ...snapshot,
      custom_questions: snapshot.custom_questions || [],
      critical_unknowns: snapshot.critical_unknowns || [],
      contradictions_to_resolve: snapshot.contradictions_to_resolve || [],
    },
    result: {
      model: null,
      numTurns: 0,
      sessionId: null,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
      },
    },
    usedFallback: false,
  };
}

function decisionResearchPacket(research) {
  return {
    evidence: research.evidence,
    team_dossier: research.team_dossier,
    company_context: research.company_context,
  };
}

function normalizedDimensionName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/[^a-z0-9]+/g, '');
}

function enrichCalibratorData(data, rubric) {
  const expected = rubric.sections.flatMap(section => section.dimensions || []);
  const expectedByName = new Map(
    expected.map(dimension => [normalizedDimensionName(dimension.name), dimension.name]),
  );
  const choicesByName = new Map(
    data.dimension_scores.map(choice => [normalizedDimensionName(choice.name), choice]),
  );
  const assessments = data.evidence_assessments || [];
  if (assessments.length !== expected.length) {
    throw new Error(`Council output must assess evidence for exactly ${expected.length} dimensions`);
  }
  const seenAssessments = new Set();
  const evidenceAssessments = assessments.map(assessment => {
    const key = normalizedDimensionName(assessment.name);
    const canonicalName = expectedByName.get(key);
    if (!canonicalName || seenAssessments.has(key)) {
      throw new Error(`Council evidence assessment has an unknown or repeated dimension: ${assessment.name}`);
    }
    seenAssessments.add(key);
    return { ...assessment, name: canonicalName };
  });

  if ((data.key_questions || []).length > 5) {
    throw new Error('Council output must contain no more than five founder follow-up questions');
  }
  const canonical = scoreCouncilChoices(data.dimension_scores, rubric);
  const seenQuestions = new Set();
  const followupQuestions = (data.key_questions || []).map(question => {
    const key = normalizedDimensionName(question.rubric_dimension);
    const canonicalName = expectedByName.get(key);
    if (!canonicalName) {
      throw new Error(`Council follow-up question names an unknown dimension: ${question.rubric_dimension}`);
    }
    if (!question.question_id || seenQuestions.has(question.question_id)) {
      throw new Error(`Council follow-up question has a missing or repeated id: ${question.question_id}`);
    }
    seenQuestions.add(question.question_id);
    const currentLikert = Number(choicesByName.get(key)?.likert);
    const scoreAt = likert => scoreCouncilChoices(
      data.dimension_scores.map(choice => (
        normalizedDimensionName(choice.name) === key ? { ...choice, likert } : choice
      )),
      rubric,
    ).totalScore;
    return {
      ...question,
      rubric_dimension: canonicalName,
      current_likert: currentLikert,
      upside_points: scoreAt(Number(question.upside_likert)) - canonical.totalScore,
      downside_points: scoreAt(Number(question.downside_likert)) - canonical.totalScore,
    };
  });

  return {
    ...data,
    evidence_assessments: evidenceAssessments,
    key_questions: followupQuestions,
  };
}

function slug(value) {
  return String(value || 'deal').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function renderArtifact({ deal, planner, research, bull, bear, calibrator, cfo, rubric, inputHash }) {
  const bullScore = scoreCouncilChoices(bull.dimension_scores, rubric);
  const bearScore = scoreCouncilChoices(bear.dimension_scores, rubric);
  const canonical = scoreCouncilChoices(calibrator.dimension_scores, rubric);
  const rationale = new Map(
    calibrator.dimension_scores.map(item => [item.name.toLowerCase(), item.rationale]),
  );
  const sectionText = canonical.sections.map(section => [
    `## ${section.name}`,
    ...section.dimensions.map(dimension =>
      `- ${dimension.name}: ${dimension.likert}/5 — ${rationale.get(dimension.name.toLowerCase()) || ''}`),
    `- **${section.name} subtotal: ${section.points}/25**`,
  ].join('\n')).join('\n\n');
  const fields = Object.entries(deal || {})
    .map(([name, value]) => `| ${name} | ${value == null || value === '' ? 'Not provided' : value} |`)
    .join('\n');
  const evidence = (research.evidence || []).map(item => `- ${item}`).join('\n');
  const researchQuestions = (planner.questions || []).map(question => {
    const dimensions = (question.rubric_dimensions || []).join(', ') || 'general';
    return `- **${question.question_id}** [${question.coverage_area}; ${dimensions}] ${question.question}`;
  }).join('\n');
  const list = items => (items || []).map(item => `- ${item}`).join('\n');
  const evidenceSufficiency = (calibrator.evidence_assessments || []).map(assessment => {
    const missing = (assessment.missing_evidence || []).length > 0
      ? ` Missing: ${assessment.missing_evidence.join('; ')}.`
      : '';
    return `- **${assessment.name}: ${assessment.sufficiency}** — ${assessment.rationale}${missing}`;
  }).join('\n');
  const founderQuestions = (calibrator.key_questions || []).map(question => {
    const upside = Number(question.upside_points || 0);
    const downside = Number(question.downside_points || 0);
    const impact = [
      `${question.current_likert}→${question.upside_likert} (${upside >= 0 ? '+' : ''}${upside} points)`,
      `${question.current_likert}→${question.downside_likert} (${downside >= 0 ? '+' : ''}${downside} points)`,
    ].join(' / ');
    return `- **${question.question_id}** [${question.priority}; ${question.rubric_dimension}; ${impact}] ${question.question} — ${question.why_it_matters}`;
  }).join('\n');
  const timestamp = new Date().toISOString();
  const date = timestamp.slice(0, 10);
  return {
    filename: `${date}-${slug(deal.company)}-${inputHash.slice(0, 8)}-${timestamp.slice(11, 23).replace(/\D/g, '')}.md`,
    content: `# Deal Log: ${deal.company}

**Date:** ${date} · headless council run · calibration: deterministic

| Field | Value |
|---|---|
${fields}

## Research Plan
**Decision frame:** ${planner.decision_frame}

${researchQuestions}

### Critical unknowns
${list(planner.critical_unknowns)}

### Contradictions to resolve
${list(planner.contradictions_to_resolve)}

## Evidence Ledger
${evidence}

## Team Dossier
${research.team_dossier}

## Company Context
${research.company_context}

## Evidence Sufficiency
${evidenceSufficiency}

## Gates
Kill criteria: ${calibrator.kill_criteria}
Primary thesis: ${calibrator.primary_thesis}

${sectionText}

## Total: ${canonical.totalScore}/50
## Verdict: ${canonical.verdict}

## Council Evaluation

| Voice | Score | Key argument |
|---|---|---|
| Bull | ${bullScore.totalScore}/50 | ${bull.key_argument} |
| Bear | ${bearScore.totalScore}/50 | ${bear.key_argument} |
| Calibrator | ${canonical.totalScore}/50 | ${calibrator.key_argument} |
| CFO | — | ${cfo.verdict} — ${cfo.reason} |

## What Would Change This Analysis
### Moves this up
${list(calibrator.moves_up)}
### Moves this down
${list(calibrator.moves_down)}
### Net assessment
${calibrator.net_assessment}

## Key Questions
${founderQuestions}

## Draft Response
**Email:** ${calibrator.email}
**LinkedIn:** ${calibrator.linkedin}
`,
    scores: { bull: bullScore, bear: bearScore, canonical },
  };
}

function fmtValue(v) {
  if (v == null || v === '') return 'Not provided';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function contractBlock(
  deal,
  lens,
  calibration,
  provenance = {},
  { includeLens = true, includeCalibration = true } = {},
) {
  const lines = [
    'COUNCIL RUN CONTRACT',
    `  Policy version: ${provenance.policyVersion || COUNCIL_POLICY_VERSION}`,
    `  Instruction hash: ${provenance.instructionHash || hash(loadSkill())}`,
    `  Input hash: ${provenance.inputHash || hash(deal || {})}`,
    '  Research produces one shared Evidence Ledger. Later roles cannot add facts.',
    '  Models choose 1–5 dimension values. Radar computes points and verdicts.',
    '  Current DEAL fields are first-party intake evidence and authoritative as the terms presently offered.',
    '  The DEAL lead is the source or syndicate presenting access unless explicitly identified as the company round lead.',
    '  Public silence or an older public round does not contradict a current private offering; only an explicit same-event incompatibility does.',
  ];
  if (includeLens) lines.splice(3, 0, `  Lens hash: ${provenance.lensHash || hash(lens || {})}`);
  if (includeCalibration) {
    const insertAt = includeLens ? 4 : 3;
    lines.splice(insertAt, 0, `  Calibration hash: ${provenance.calibrationHash || hash(calibration || {})}`);
  }
  return lines.join('\n');
}

function dealBlock(deal) {
  const lines =
    Object.entries(deal || {})
      .map(([k, v]) => `  ${k}: ${fmtValue(v)}`)
      .join('\n') || '  (no fields provided)';
  return `DEAL\n${lines}`;
}

function assembleResearchContext(deal, lens, calibration, provenance) {
  return [
    contractBlock(deal, lens, calibration, provenance, {
      includeLens: false,
      includeCalibration: false,
    }),
    '',
    dealBlock(deal),
  ].join('\n');
}

function assembleGraderContext(deal, lens, calibration, provenance) {
  return [
    contractBlock(deal, lens, calibration, provenance, {
      includeCalibration: false,
    }),
    '',
    dealBlock(deal),
    '',
    'SCORING LENS',
    `  Rubric: ${JSON.stringify(lens.rubric)}`,
    `  Kill criteria: ${JSON.stringify(lens.kill)}`,
    `  GP tiers: ${JSON.stringify(lens.gpTiers)}`,
    `  Theses: ${JSON.stringify(lens.theses)}`,
    `  Thesis clusters: ${JSON.stringify(lens.clusters)}`,
  ].join('\n');
}

function assembleCfoContext(deal, lens, calibration, provenance) {
  return [
    contractBlock(deal, lens, calibration, provenance, {
      includeCalibration: false,
    }),
    '',
    dealBlock(deal),
    '',
    'PORTFOLIO POLICY',
    `  GP tiers: ${JSON.stringify(lens.gpTiers)}`,
    `  Round params: ${JSON.stringify(lens.roundParams)}`,
  ].join('\n');
}

/**
 * Build the single injected context block: DEAL + LENS (authoritative) +
 * CALIBRATION. Lens/calibration are emitted as JSON — precise and lossless for
 * the model to read, versus prose transcription which could drift.
 */
export function assembleContext(deal, lens, calibration, provenance = {}) {
  return [
    contractBlock(deal, lens, calibration, provenance),
    '',
    dealBlock(deal),
    '',
    'LENS (authoritative — score against THIS, not general knowledge)',
    `  Rubric: ${JSON.stringify(lens.rubric)}`,
    `  Kill criteria: ${JSON.stringify(lens.kill)}`,
    `  GP tiers: ${JSON.stringify(lens.gpTiers)}`,
    `  Theses: ${JSON.stringify(lens.theses)}`,
    `  Thesis clusters: ${JSON.stringify(lens.clusters)}`,
    `  Round params: ${JSON.stringify(lens.roundParams)}`,
    '',
    'CALIBRATION (how this investor actually decides)',
    `  ${JSON.stringify(calibration)}`,
  ].join('\n');
}

/**
 * Legacy persona metadata retained for API compatibility. councilEvaluate()
 * executes each stage directly instead of passing optional SDK subagents.
 * @param {Record<string,string>} models resolved council model policy
 */
export function buildCouncilAgents(models) {
  return {
    research: {
      description: 'Research leg: adapt Radar’s seed questions and produce the shared sourced Evidence Ledger.',
      model: models.research,
      prompt:
        'You identify up to three deal-specific gaps, then gather public facts — LinkedIn history, prior companies and outcomes, ' +
        'domain credentials, press, funding, competitors — and report them plainly ' +
        'with sources in one Evidence Ledger. Label supplied, verified, conflicting, ' +
        'and unavailable facts. No judgment, just sourced facts.',
      tools: ['WebSearch'],
    },
    bull: {
      description: 'Council Bull: argue the strongest credible upside and score /50.',
      model: models.bull,
      prompt:
        'You are the Bull voice of the investment council. Argue the strongest ' +
        'credible upside case and score the deal /50 against the rubric in your ' +
        'context. Ground every claim only in the shared Evidence Ledger.',
    },
    bear: {
      description: 'Council Bear: argue the skeptical case and score /50.',
      model: models.bear,
      prompt:
        'You are the Bear voice of the investment council. Argue the skeptical ' +
        'case — what breaks, what is unconfirmed — and score /50 against the rubric ' +
        'in your context. Ground every claim only in the shared Evidence Ledger.',
    },
    calibrator: {
      description: 'Council Calibrator: reconcile Bull and Bear into the canonical score.',
      model: models.calibrator,
      prompt:
        'You are the Calibrator of the investment council. Reconcile the Bull and ' +
        'Bear against the CALIBRATION examples and personalized invest line in your ' +
        'context. Use only the shared Evidence Ledger. Produce the canonical 1–5 ' +
        'dimension choices; state which voice you weight where they diverge. Radar ' +
        'will compute weighted points and the verdict deterministically.',
    },
    cfo: {
      description: 'Council CFO: portfolio-construction verdict Deploy/Defer/Pass.',
      model: models.cfo,
      prompt:
        'You are the Personal CFO of the investment council. You do not re-score. ' +
        'Give a Deploy/Defer/Pass verdict and, if Deploy, a check-size tier — judged ' +
        'against the GP tiers, round params, and the consensus score in your context.',
    },
  };
}

function aggregateStageUsage(stages) {
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: 0,
    byModel: {},
  };
  const perStage = stages.map(stage => {
    const usage = stage.result.usage || {};
    total.inputTokens += Number(usage.inputTokens || 0);
    total.outputTokens += Number(usage.outputTokens || 0);
    total.totalCostUsd += Number(usage.totalCostUsd || 0);
    for (const [model, modelUsage] of Object.entries(usage.byModel || {})) {
      if (!total.byModel[model]) {
        total.byModel[model] = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      }
      total.byModel[model].inputTokens += Number(modelUsage.inputTokens || 0);
      total.byModel[model].outputTokens += Number(modelUsage.outputTokens || 0);
      total.byModel[model].costUsd += Number(modelUsage.costUsd || 0);
    }
    return {
      stage: stage.stage,
      model: stage.result.model || null,
      numTurns: Number(stage.result.numTurns || 0),
      usage: {
        inputTokens: Number(usage.inputTokens || 0),
        outputTokens: Number(usage.outputTokens || 0),
        totalCostUsd: Number(usage.totalCostUsd || 0),
      },
    };
  });
  if (Object.keys(total.byModel).length === 0) delete total.byModel;
  return { total, perStage };
}

/**
 * Grade one opportunity through the council and write its deal-log diagnosis.
 *
 * @param {Record<string, any>} deal  parsed deal facts (from a pipeline invite
 *   or an ad-hoc inbound). Rendered into the DEAL block.
 * @param {Object} opts
 * @param {import('../providers/model-provider.js').ModelProvider} opts.provider
 *   REQUIRED. Injected so this stays SDK-free/testable.
 * @param {() => import('../providers/model-provider.js').ModelProvider} [opts.buildFallback]
 *   builds an api_key provider for RADAR_FALLBACK_TO_API (only used on a
 *   credit/rate-limit failure in subscription mode).
 * @param {string} opts.dealLogDir  directory where Radar writes the artifact.
 * @param {Record<string,string>} [opts.models]  council model-policy override.
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @param {number} [opts.maxTurns=40]
 * @param {string} [opts.policyId=balanced]
 * @param {object} [opts.calibrationSnapshot] exact historical calibration for
 *   a controlled replay; normal runs derive calibration from Radar.
 * @param {object} [opts.plannerSnapshot] exact frozen merged research plan for
 *   a controlled replay; normal runs seed Sonnet with Radar's baseline.
 * @param {object} [opts.researchSnapshot] exact frozen evidence packet for a
 *   controlled replay; normal runs perform fresh retrieval.
 * @returns {Promise<{result: object, usedFallback: boolean, primaryErrorKind?: string, calibrationMaturity: string, modelPolicy: object}>}
 */
export async function councilEvaluate(deal, opts = {}) {
  const {
    provider,
    buildFallback,
    models,
    env = process.env,
    maxTurns = 40,
    dryRun = false,
    policyId = 'balanced',
    dealLogDir,
    reuse = true,
    findExisting,
    executionId,
    onStage,
    calibrationSnapshot,
    plannerSnapshot,
    researchSnapshot,
  } = opts;

  const lens = {
    rubric: getRubric(),
    kill: getKillCriteria(),
    gpTiers: getGpTiers(),
    theses: getTheses(),
    clusters: getThesisClusters(),
    roundParams: getRoundParams(),
  };
  const calibration = calibrationSnapshot || await getCalibration();
  const baselineResearchPlan = buildBaselineResearchPlan(deal);
  const turnPolicy = {
    research: Math.max(16, Math.ceil(maxTurns / 2)),
    judgment: Math.max(4, Math.ceil(maxTurns / 8)),
  };
  const instructionHash = hash({
    skill: loadSkill(),
    roles: Object.fromEntries(
      Object.keys(ROLE_PATHS).map(stage => [stage, loadRolePrompt(stage)]),
    ),
    pipeline: EXPLICIT_PIPELINE_VERSION,
    researchPlanSeedVersion: RESEARCH_PLAN_SEED_VERSION,
    baselineResearchQuestions: BASELINE_RESEARCH_QUESTIONS,
    prompts: STAGE_PROMPTS,
    schemas: {
      research: RESEARCH_SCHEMA,
      grader: GRADER_SCHEMA,
      calibrator: CALIBRATOR_SCHEMA,
      cfo: CFO_SCHEMA,
    },
    turnPolicy,
  });
  const policy = resolveCouncilModels(models);
  const provenance = {
    policyId,
    policyVersion: COUNCIL_POLICY_VERSION,
    instructionHash,
    lensHash: hash(lens),
    calibrationHash: hash(calibration),
    inputHash: hash(deal || {}),
    researchPlanSeedVersion: RESEARCH_PLAN_SEED_VERSION,
    researchPlanSeedHash: hash(baselineResearchPlan),
    plannerSnapshotHash: plannerSnapshot ? hash(plannerSnapshot) : null,
    researchSnapshotHash: researchSnapshot ? hash(researchSnapshot) : null,
  };
  provenance.runKey = hash({
    ...provenance,
    modelPolicy: policy,
    executionId: executionId || null,
  });
  const context = assembleContext(deal, lens, calibration, provenance);
  const researchContext = assembleResearchContext(deal, lens, calibration, provenance);
  const graderBaseContext = assembleGraderContext(deal, lens, calibration, provenance);
  const cfoBaseContext = assembleCfoContext(deal, lens, calibration, provenance);
  const authMode = resolveAuthMode(env);
  const requests = {
    research: stageRequest('research', {
      model: policy.research,
      context: `${researchContext}\n\nRADAR RESEARCH PLAN\n${JSON.stringify(plannerSnapshot || baselineResearchPlan)}`,
      schema: RESEARCH_SCHEMA,
      maxTurns: turnPolicy.research,
    }),
    bull: stageRequest('bull', {
      model: policy.bull,
      context: `${graderBaseContext}\n\nFROZEN RESEARCH PACKET\n  (produced by the research stage)`,
      schema: GRADER_SCHEMA,
      maxTurns: turnPolicy.judgment,
    }),
    bear: stageRequest('bear', {
      model: policy.bear,
      context: `${graderBaseContext}\n\nFROZEN RESEARCH PACKET\n  (produced by the research stage)`,
      schema: GRADER_SCHEMA,
      maxTurns: turnPolicy.judgment,
    }),
    calibrator: stageRequest('calibrator', {
      model: policy.calibrator,
      context: `${context}\n\nFROZEN RESEARCH, BULL, AND BEAR OUTPUTS\n  (produced by prior stages)`,
      schema: CALIBRATOR_SCHEMA,
      maxTurns: turnPolicy.judgment,
    }),
    cfo: stageRequest('cfo', {
      model: policy.cfo,
      context: `${cfoBaseContext}\n\nCALIBRATED DECISION SUMMARY AND RADAR-COMPUTED SCORE\n  (produced by prior stages)`,
      schema: CFO_SCHEMA,
      maxTurns: turnPolicy.judgment,
    }),
  };

  // Dry run previews every enforced session without a credential or model call.
  if (dryRun) {
    return {
      dryRun: true,
      requests,
      authMode,
      calibrationMaturity: calibration.maturity,
      modelPolicy: policy,
      provenance: { ...provenance, modelPolicy: policy },
    };
  }

  if (reuse) {
    const lookup = findExisting || (runKey => query(
      `SELECT id FROM deal_evaluations WHERE council_run_key = $1 LIMIT 1`,
      [runKey],
    ));
    const existing = await lookup(provenance.runKey);
    if (existing?.[0]) {
      return {
        reused: true,
        evaluationId: existing[0].id,
        usedFallback: false,
        calibrationMaturity: calibration.maturity,
        modelPolicy: policy,
        writtenFiles: [],
        provenance: { ...provenance, modelPolicy: policy },
      };
    }
  }

  if (!provider) throw new Error('councilEvaluate requires a provider (inject a ModelProvider)');
  if (!dealLogDir) throw new Error('councilEvaluate requires dealLogDir to write the Council artifact');

  // A second click in the same Radar process joins the first run instead of
  // starting another set of model sessions before the DB fingerprint exists.
  const running = inFlightRuns.get(provenance.runKey);
  if (running) {
    const completed = await running;
    return {
      ...completed,
      reused: true,
      reusedInFlight: true,
      writtenFiles: [],
    };
  }

  const execution = (async () => {
    const runtime = {
      primary: provider,
      currentMode: authMode,
      fallbackEnabled: resolveFallbackFlag(env),
      buildFallback,
      env,
    };

    const notifyStage = async stage => {
      if (onStage) await onStage(stage);
    };

    await notifyStage('research');
    const research = researchSnapshot
      ? frozenResearchStage(researchSnapshot)
      : await runStage('research', stageRequest('research', {
        model: policy.research,
        context: `${researchContext}\n\nRADAR RESEARCH PLAN\n${JSON.stringify(plannerSnapshot || baselineResearchPlan)}`,
        schema: RESEARCH_SCHEMA,
        maxTurns: turnPolicy.research,
      }), runtime);
    const researchPlan = plannerSnapshot || mergeResearchPlan(baselineResearchPlan, {
      deal_identity: baselineResearchPlan.deal_identity,
      decision_frame: baselineResearchPlan.decision_frame,
      priority_question_ids: baselineResearchPlan.priority_question_ids,
      custom_questions: research.data.custom_questions,
      critical_unknowns: research.data.critical_unknowns,
      contradictions_to_resolve: research.data.contradictions_to_resolve,
    });
    const planner = frozenPlannerStage(researchPlan);
    provenance.researchPlanHash = hash(researchPlan);
    provenance.researchPlan = researchPlan;
    const frozenResearch = JSON.stringify(decisionResearchPacket(research.data));
    const graderContext = `${graderBaseContext}\n\nFROZEN RESEARCH PACKET\n${frozenResearch}`;

    await notifyStage('bull_bear');
    const [bull, bear] = await Promise.all([
      runStage('bull', stageRequest('bull', {
        model: policy.bull,
        context: graderContext,
        schema: GRADER_SCHEMA,
        maxTurns: turnPolicy.judgment,
      }), runtime),
      runStage('bear', stageRequest('bear', {
        model: policy.bear,
        context: graderContext,
        schema: GRADER_SCHEMA,
        maxTurns: turnPolicy.judgment,
      }), runtime),
    ]);

    // Validate both graders before calibration so a malformed or incomplete
    // dimension list fails closed instead of silently changing the weighting.
    scoreCouncilChoices(bull.data.dimension_scores, lens.rubric);
    scoreCouncilChoices(bear.data.dimension_scores, lens.rubric);

    const calibratorContext = [
      context,
      'FROZEN RESEARCH PACKET',
      frozenResearch,
      'FROZEN BULL OUTPUT',
      JSON.stringify(bull.data),
      'FROZEN BEAR OUTPUT',
      JSON.stringify(bear.data),
    ].join('\n\n');
    await notifyStage('calibrator');
    const calibrator = await runStage('calibrator', stageRequest('calibrator', {
      model: policy.calibrator,
      context: calibratorContext,
      schema: CALIBRATOR_SCHEMA,
      maxTurns: turnPolicy.judgment,
    }), runtime);
    calibrator.data = enrichCalibratorData(calibrator.data, lens.rubric);
    const canonical = scoreCouncilChoices(calibrator.data.dimension_scores, lens.rubric);

    const cfoDecisionSummary = {
      key_argument: calibrator.data.key_argument,
      primary_thesis: calibrator.data.primary_thesis,
      net_assessment: calibrator.data.net_assessment,
    };
    const cfoContext = [
      cfoBaseContext,
      'CALIBRATED DECISION SUMMARY',
      JSON.stringify(cfoDecisionSummary),
      'RADAR-COMPUTED CANONICAL SCORE',
      JSON.stringify(canonical),
    ].join('\n\n');
    await notifyStage('cfo');
    const cfo = await runStage('cfo', stageRequest('cfo', {
      model: policy.cfo,
      context: cfoContext,
      schema: CFO_SCHEMA,
      maxTurns: turnPolicy.judgment,
    }), runtime);

    await notifyStage('finalizing');
    const artifact = renderArtifact({
      deal,
      planner: planner.data,
      research: research.data,
      bull: bull.data,
      bear: bear.data,
      calibrator: calibrator.data,
      cfo: cfo.data,
      rubric: lens.rubric,
      inputHash: provenance.inputHash,
    });
    mkdirSync(dealLogDir, { recursive: true });
    writeFileSync(join(dealLogDir, artifact.filename), artifact.content, 'utf8');

    const stages = [planner, research, bull, bear, calibrator, cfo];
    const usage = aggregateStageUsage(stages);
    const sessionIds = stages.map(stage => stage.result.sessionId).filter(Boolean);
    const result = {
      text: `Council complete: ${artifact.scores.canonical.totalScore}/50 · ${artifact.scores.canonical.verdict}`,
      structuredOutput: Object.fromEntries(stages.map(stage => [stage.stage, stage.data])),
      sessionId: sessionIds.join(',') || null,
      model: policy.calibrator,
      apiKeySource: calibrator.result.apiKeySource || null,
      usage: usage.total,
      stageMetrics: usage.perStage,
    };
    return {
      result,
      usage: usage.total,
      stageMetrics: usage.perStage,
      usedFallback: stages.some(stage => stage.usedFallback),
      primaryErrorKind: stages.find(stage => stage.primaryErrorKind)?.primaryErrorKind,
      calibrationMaturity: calibration.maturity,
      modelPolicy: policy,
      writtenFiles: [artifact.filename],
      provenance: {
        ...provenance,
        sessionId: result.sessionId,
        modelPolicy: policy,
        dimensionScores: calibrator.data.dimension_scores,
        evidenceAssessments: calibrator.data.evidence_assessments,
        followupQuestions: calibrator.data.key_questions,
        rubricSnapshot: lens.rubric,
        artifactHashes: { [artifact.filename]: hash(artifact.content) },
      },
    };
  })();

  inFlightRuns.set(provenance.runKey, execution);
  try {
    return await execution;
  } finally {
    inFlightRuns.delete(provenance.runKey);
  }
}
