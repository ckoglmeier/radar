// evaluate.js — Phase B1: councilEvaluate(), the normalized council path.
//
// Runs the vendored headless investment-grading skill as ONE agentic session
// (skill text = systemPrompt; lens + calibration + deal facts = injected
// context), with the four council personas as per-tier subagents. The session
// writes the deal-log artifact; B2 ingests it into deal_evaluations via the
// existing parse/compute/store pipeline.
//
// This module is SDK-free and pure orchestration: the provider is injected, so
// it is fully unit-testable with a fake. The CLI (C1) constructs the real
// AgentSdkProvider + api_key fallback factory and passes them in.

import { existsSync, readFileSync, readdirSync } from 'fs';
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

const SKILL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'skills',
  'investment-grading',
  'SKILL.md'
);

let _skill;
function loadSkill() {
  if (_skill == null) _skill = readFileSync(SKILL_PATH, 'utf8');
  return _skill;
}

export const COUNCIL_POLICY_VERSION = 2;

function hash(value) {
  const content = typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : JSON.stringify(value);
  return createHash('sha256').update(content).digest('hex');
}

function artifactSnapshot(dir) {
  if (!dir || !existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir)
      .filter(file => file.endsWith('.md'))
      .map(file => [file, hash(readFileSync(join(dir, file)))]),
  );
}

function fmtValue(v) {
  if (v == null || v === '') return 'Not provided';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * Build the single injected context block: DEAL + LENS (authoritative) +
 * CALIBRATION. Lens/calibration are emitted as JSON — precise and lossless for
 * the model to read, versus prose transcription which could drift.
 */
export function assembleContext(deal, lens, calibration, provenance = {}) {
  const dealLines =
    Object.entries(deal || {})
      .map(([k, v]) => `  ${k}: ${fmtValue(v)}`)
      .join('\n') || '  (no fields provided)';

  return [
    'COUNCIL RUN CONTRACT',
    `  Policy version: ${provenance.policyVersion || COUNCIL_POLICY_VERSION}`,
    `  Instruction hash: ${provenance.instructionHash || hash(loadSkill())}`,
    `  Lens hash: ${provenance.lensHash || hash(lens)}`,
    `  Calibration hash: ${provenance.calibrationHash || hash(calibration)}`,
    `  Input hash: ${provenance.inputHash || hash(deal || {})}`,
    '  Research produces one shared Evidence Ledger. Bull, Bear, Calibrator, and CFO must use only that ledger.',
    '  The model chooses 1–5 dimension values. Radar computes weighted points and verdict bands in code.',
    '',
    'DEAL',
    dealLines,
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
 * The council personas as SDK subagent definitions, keyed by name, each pinned
 * to its model tier. The generic scaffolding lives here (OSS); the calibrated
 * judgment they score against arrives in the injected context.
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
 * @param {string} [opts.dealLogDir]  informational; the real provider's cwd is
 *   where the Write tool lands the artifact (set when constructing the provider).
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
  const instructionHash = hash(loadSkill());
  const policy = resolveCouncilModels(models);
  const provenance = {
    policyId,
    policyVersion: COUNCIL_POLICY_VERSION,
    instructionHash,
    lensHash: hash(lens),
    calibrationHash: hash(calibration),
    inputHash: hash(deal || {}),
  };
  provenance.runKey = hash({ ...provenance, modelPolicy: policy });
  const context = assembleContext(deal, lens, calibration, provenance);
  const agents = buildCouncilAgents(policy);
  const authMode = resolveAuthMode(env);

  const req = {
    prompt:
      'Grade the opportunity in your context. Run the council per your ' +
      'instructions and write the deal-log diagnosis to the deal-log directory.',
    systemPrompt: loadSkill(),
    context,
    model: policy.orchestrator,
    tools: ['Write'],
    agents,
    maxTurns,
  };

  // Dry run: assemble everything and return it without spawning the SDK — lets
  // the CLI preview exactly what would be sent (and what it would cost) without
  // a credential. No provider required.
  if (dryRun) {
    return {
      dryRun: true,
      request: req,
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

  const beforeArtifacts = artifactSnapshot(dealLogDir);
  const { result, usedFallback, primaryErrorKind } = await runWithFallback(req, {
    primary: provider,
    currentMode: authMode,
    fallbackEnabled: resolveFallbackFlag(env),
    buildFallback,
    env,
  });
  const afterArtifacts = artifactSnapshot(dealLogDir);
  const writtenFiles = Object.keys(afterArtifacts).filter(
    file => beforeArtifacts[file] !== afterArtifacts[file],
  );
  if (dealLogDir && writtenFiles.length === 0) {
    throw new Error('Council completed without writing a new or changed deal-log artifact');
  }

  return {
    result,
    usedFallback: Boolean(usedFallback),
    primaryErrorKind,
    calibrationMaturity: calibration.maturity,
    modelPolicy: policy,
    writtenFiles,
    provenance: {
      ...provenance,
      sessionId: result.sessionId || null,
      modelPolicy: policy,
      artifactHashes: Object.fromEntries(
        writtenFiles.map(file => [file, afterArtifacts[file]]),
      ),
    },
  };
}
