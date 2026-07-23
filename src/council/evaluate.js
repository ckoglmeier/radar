// evaluate.js — Phase B1: councilEvaluate(), the normalized council path.
//
// Runs the vendored headless investment-grading skill as five explicit sessions:
// research, Bull, Bear, Calibrator, and CFO. Research is frozen before either
// grader runs, and only Radar writes the final artifact. This makes the actual
// execution match the Council shown to users instead of relying on optional
// subagent definitions that the orchestrator may never invoke.
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

export const COUNCIL_POLICY_VERSION = 4;
const EXPLICIT_PIPELINE_VERSION = 'scoped-role-context-v2';
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
      rationale: { type: 'string', maxLength: 600 },
    },
    required: ['name', 'likert', 'rationale'],
    additionalProperties: false,
  },
};

const GRADER_SCHEMA = {
  type: 'object',
  properties: {
    dimension_scores: DIMENSION_ARRAY,
    key_argument: { type: 'string', maxLength: 1600 },
  },
  required: ['dimension_scores', 'key_argument'],
  additionalProperties: false,
};

const CALIBRATOR_SCHEMA = {
  type: 'object',
  properties: {
    dimension_scores: DIMENSION_ARRAY,
    key_argument: { type: 'string', maxLength: 1600 },
    kill_criteria: { type: 'string', maxLength: 1000 },
    primary_thesis: { type: 'string', maxLength: 500 },
    moves_up: {
      type: 'array',
      maxItems: 5,
      items: { type: 'string', maxLength: 700 },
    },
    moves_down: {
      type: 'array',
      maxItems: 5,
      items: { type: 'string', maxLength: 700 },
    },
    net_assessment: { type: 'string', maxLength: 1200 },
    key_questions: {
      type: 'array',
      maxItems: 5,
      items: { type: 'string', maxLength: 500 },
    },
    email: { type: 'string', maxLength: 1200 },
    linkedin: { type: 'string', maxLength: 700 },
  },
  required: [
    'dimension_scores', 'key_argument', 'kill_criteria', 'primary_thesis',
    'moves_up', 'moves_down', 'net_assessment', 'key_questions', 'email', 'linkedin',
  ],
  additionalProperties: false,
};

const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    evidence: {
      type: 'array',
      items: { type: 'string', maxLength: 900 },
    },
    team_dossier: { type: 'string', maxLength: 6000 },
    company_context: { type: 'string', maxLength: 5000 },
  },
  required: ['evidence', 'team_dossier', 'company_context'],
  additionalProperties: false,
};

const CFO_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['Deploy', 'Defer', 'Pass'] },
    reason: { type: 'string', maxLength: 900 },
  },
  required: ['verdict', 'reason'],
  additionalProperties: false,
};

const STAGE_PROMPTS = {
  research:
    'STAGE: research\nPerform only retrieval. Build one shared factual evidence packet for the deal. ' +
    'Use web search when useful. Label every item as supplied, verified, conflicting, or unavailable, ' +
    'and include its source in the string. Do not score the deal or simulate another Council voice.',
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

function slug(value) {
  return String(value || 'deal').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function renderArtifact({ deal, research, bull, bear, calibrator, cfo, rubric, inputHash }) {
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
  const list = items => (items || []).map(item => `- ${item}`).join('\n');
  const timestamp = new Date().toISOString();
  const date = timestamp.slice(0, 10);
  return {
    filename: `${date}-${slug(deal.company)}-${inputHash.slice(0, 8)}-${timestamp.slice(11, 23).replace(/\D/g, '')}.md`,
    content: `# Deal Log: ${deal.company}

**Date:** ${date} · headless council run · calibration: deterministic

| Field | Value |
|---|---|
${fields}

## Evidence Ledger
${evidence}

## Team Dossier
${research.team_dossier}

## Company Context
${research.company_context}

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
${list(calibrator.key_questions)}

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
      description: 'Retrieval leg: produce the shared sourced Evidence Ledger.',
      model: models.research,
      prompt:
        'You gather public facts — LinkedIn history, prior companies and outcomes, ' +
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
  } = opts;

  const lens = {
    rubric: getRubric(),
    kill: getKillCriteria(),
    gpTiers: getGpTiers(),
    theses: getTheses(),
    clusters: getThesisClusters(),
    roundParams: getRoundParams(),
  };
  const calibration = await getCalibration();
  const instructionHash = hash({
    skill: loadSkill(),
    roles: Object.fromEntries(
      Object.keys(ROLE_PATHS).map(stage => [stage, loadRolePrompt(stage)]),
    ),
    pipeline: EXPLICIT_PIPELINE_VERSION,
    prompts: STAGE_PROMPTS,
    schemas: { research: RESEARCH_SCHEMA, grader: GRADER_SCHEMA, calibrator: CALIBRATOR_SCHEMA, cfo: CFO_SCHEMA },
  });
  const policy = resolveCouncilModels(models);
  const provenance = {
    policyId,
    policyVersion: COUNCIL_POLICY_VERSION,
    instructionHash,
    lensHash: hash(lens),
    calibrationHash: hash(calibration),
    inputHash: hash(deal || {}),
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
  const stageTurns = Math.max(6, Math.ceil(maxTurns / 4));
  const requests = {
    research: stageRequest('research', {
      model: policy.research,
      context: researchContext,
      schema: RESEARCH_SCHEMA,
      maxTurns: stageTurns,
    }),
    bull: stageRequest('bull', {
      model: policy.bull,
      context: `${graderBaseContext}\n\nFROZEN RESEARCH PACKET\n  (produced by the research stage)`,
      schema: GRADER_SCHEMA,
      maxTurns: stageTurns,
    }),
    bear: stageRequest('bear', {
      model: policy.bear,
      context: `${graderBaseContext}\n\nFROZEN RESEARCH PACKET\n  (produced by the research stage)`,
      schema: GRADER_SCHEMA,
      maxTurns: stageTurns,
    }),
    calibrator: stageRequest('calibrator', {
      model: policy.calibrator,
      context: `${context}\n\nFROZEN RESEARCH, BULL, AND BEAR OUTPUTS\n  (produced by prior stages)`,
      schema: CALIBRATOR_SCHEMA,
      maxTurns: stageTurns,
    }),
    cfo: stageRequest('cfo', {
      model: policy.cfo,
      context: `${cfoBaseContext}\n\nCALIBRATED DECISION SUMMARY AND RADAR-COMPUTED SCORE\n  (produced by prior stages)`,
      schema: CFO_SCHEMA,
      maxTurns: stageTurns,
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
    const research = await runStage('research', requests.research, runtime);
    const frozenResearch = JSON.stringify(research.data);
    const graderContext = `${graderBaseContext}\n\nFROZEN RESEARCH PACKET\n${frozenResearch}`;

    await notifyStage('bull_bear');
    const [bull, bear] = await Promise.all([
      runStage('bull', stageRequest('bull', {
        model: policy.bull,
        context: graderContext,
        schema: GRADER_SCHEMA,
        maxTurns: stageTurns,
      }), runtime),
      runStage('bear', stageRequest('bear', {
        model: policy.bear,
        context: graderContext,
        schema: GRADER_SCHEMA,
        maxTurns: stageTurns,
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
      maxTurns: stageTurns,
    }), runtime);
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
      maxTurns: stageTurns,
    }), runtime);

    await notifyStage('finalizing');
    const artifact = renderArtifact({
      deal,
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

    const stages = [research, bull, bear, calibrator, cfo];
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
