/**
 * Calibration accessor — derives council calibration from live deal_evaluations
 * data instead of a hand-authored calibration-examples.md file.
 *
 * Cold start (0 scored deals): pure defaults from the active lens's rubric
 * (verdict_bands + per-dimension weights), examples: []. No synthetic examples —
 * shipping fake calibration is the `_template` trap (see lenses/_template):
 * empty-but-honest beats fake-but-populated.
 *
 * As scored deals accumulate, calibration evolves toward the user's own data via
 * shrinkage (see SHRINKAGE_K below) — thresholds drift toward the revealed
 * yes/no boundary, examples become real deal_evaluations rows. Dimension
 * reweighting from real exit outcomes is a later refinement (see
 * reweightDimensions() below) — v1 always returns the lens default weights.
 *
 * getCalibration() must run inside the same lens/tenant context as the other
 * report accessors (see loader.js withLens / db/index.js withTenant) — it calls
 * getRubric() and query() directly, same as evaluations.js and thesis.js.
 */

import { query } from '../db/index.js';
import { getRubric } from './loader.js';

// Shrinkage pseudo-count. w = N / (N + k) is the personal weight once N deals
// are scored; k is the number of "phantom" default-only deals the blend starts
// with. k=15 means: at 15 scored deals you're already half-personal (w=0.5),
// and it takes ~45 deals to reach w=0.75. That matches the plan's guidance
// (k ~= 10-20) and this repo's actual pace — CK scores on the order of a
// handful of deals a month, so k=15 reaches "partial" trust within a
// realistic first year without overreacting to 2-3 early data points.
const SHRINKAGE_K = 15;

// Maturity band boundaries, in scored-deal count. Matches the plan's
// default -> partial (N deals) -> personal surface.
const PARTIAL_AT = 1;   // any real signal at all moves off pure "default"
const PERSONAL_AT = 30; // w = 30/(30+15) = 0.67 — clearly personal, not a cliff

/**
 * Default verdict thresholds, read from the active lens rubric's verdict_bands.
 * Shape: { strong: 40, exploring: 30, likely_pass: 20 } — the score at/above
 * which each band starts. (< likely_pass is "clear pass".)
 */
function defaultThresholds(rubric) {
  const bands = rubric?.verdict_bands || [];
  // verdict_bands are ordered high-to-low in the template; sort defensively.
  const sorted = [...bands].sort((a, b) => b.range[0] - a.range[0]);
  return {
    strong: sorted[0]?.range[0] ?? 40,
    exploring: sorted[1]?.range[0] ?? 30,
    likely_pass: sorted[2]?.range[0] ?? 20,
  };
}

/**
 * Default dimension weights, flattened from the rubric's sections/dimensions
 * into { "Section > Dimension": weight_pct }. v1 — always the lens default.
 *
 * Seam for later outcome-driven reweighting: once real exit data exists
 * (multiples/marks on invested deals with enough sample size to attribute
 * which rubric dimensions predicted good outcomes), this is where that blend
 * would plug in — swap the return value for a shrinkage blend of these
 * defaults against learned weights, the same way thresholds are blended
 * below. Gated off for now: exit outcomes are sparse early (see N3 caveat
 * in the plan doc), so reweighting on noise would be worse than the default.
 */
function defaultDimensionWeights(rubric) {
  const weights = {};
  for (const section of rubric?.sections || []) {
    for (const dim of section.dimensions || []) {
      weights[`${section.name} > ${dim.name}`] = dim.weight_pct;
    }
  }
  return weights;
}

/**
 * reweightDimensions() — LATER refinement, not implemented in v1.
 * Once real exit outcomes exist in sufficient volume, this would learn which
 * rubric dimensions actually predicted good exits and blend that signal in
 * (same shrinkage pattern as thresholds). Currently a no-op passthrough so
 * the seam is explicit and callers don't need to change when it lands.
 */
function reweightDimensions(defaults /*, outcomeSignal */) {
  return defaults;
}

/**
 * Fetch every scored deal_evaluations row with enough context to determine
 * a real yes/no outcome: invested (via investments/pipeline_invites) or
 * explicitly passed (pipeline_invites.status = 'passed'). This is the same
 * underlying join evalReconcile() uses, generalized to the full population
 * of scored deals rather than just the >= threshold slice — we need the
 * whole distribution to estimate a boundary, not just the divergent cases.
 */
async function fetchScoredDeals() {
  const rows = await query(`
    SELECT
      de.id,
      de.total_score,
      de.verdict,
      de.invested,
      de.eval_date,
      de.file_path,
      COALESCE(i.company_name, pi.company_name) AS company_name,
      pi.status AS pipeline_status
    FROM deal_evaluations de
    LEFT JOIN investments i ON de.investment_id = i.id
    LEFT JOIN pipeline_invites pi ON de.pipeline_invite_id = pi.id
    WHERE de.total_score IS NOT NULL
    ORDER BY de.total_score DESC
  `);

  return rows.map(r => ({
    id: r.id,
    company_name: r.company_name || companyFromFilePath(r.file_path),
    total_score: Number(r.total_score),
    verdict: r.verdict,
    invested: Boolean(r.invested),
    passed: r.pipeline_status === 'passed',
    eval_date: r.eval_date ? (r.eval_date.toISOString?.().slice(0, 10) || String(r.eval_date).slice(0, 10)) : null,
  }));
}

/** Fallback company label from the deal-log filename slug when no DB link exists. */
function companyFromFilePath(filePath) {
  if (!filePath) return 'Unknown';
  const filename = filePath.split('/').pop() || filePath;
  return filename.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/(-review)?\.md$/, '');
}

/**
 * Estimate the user's revealed yes/no threshold from scored deals: the score
 * that best separates "invested" from "explicitly passed" decisions. This is
 * the same divergence evalReconcile() surfaces (scored high but passed) —
 * here we use it to locate a boundary rather than just list the outliers.
 *
 * Method: take the lowest score among invested deals and the highest score
 * among passed deals. If passed deals score *below* invested deals (the
 * expected case), the revealed threshold is the midpoint between them. If
 * they overlap (CK passed on something that scored as high as something he
 * funded), there's no clean separating line — fall back to null and let the
 * caller keep the default threshold for that band.
 */
function estimateRevealedThreshold(deals) {
  const investedScores = deals.filter(d => d.invested).map(d => d.total_score);
  const passedScores = deals.filter(d => d.passed && !d.invested).map(d => d.total_score);

  if (investedScores.length === 0 || passedScores.length === 0) return null;

  const minInvested = Math.min(...investedScores);
  const maxPassed = Math.max(...passedScores);

  if (maxPassed >= minInvested) return null; // overlapping — no clean boundary
  return (minInvested + maxPassed) / 2;
}

/**
 * Blend a default threshold toward an observed/revealed one by shrinkage
 * weight w. Returns the default unchanged if no revealed value is available.
 */
function blendThreshold(defaultValue, revealedValue, w) {
  if (revealedValue == null) return defaultValue;
  return Math.round((defaultValue * (1 - w) + revealedValue * w) * 10) / 10;
}

/**
 * Pick up to 3 representative real examples from scored deals: one invested,
 * one passed, one borderline (closest score to the revealed/default
 * threshold among deals not already chosen). Never synthesized — every
 * example traces to a real deal_evaluations row (via its id).
 */
function pickExamples(deals, thresholdForBorderline) {
  const examples = [];
  const used = new Set();

  const invested = deals.filter(d => d.invested).sort((a, b) => b.total_score - a.total_score)[0];
  if (invested) { examples.push({ ...invested, role: 'invested' }); used.add(invested.id); }

  const passed = deals
    .filter(d => d.passed && !d.invested && !used.has(d.id))
    .sort((a, b) => b.total_score - a.total_score)[0];
  if (passed) { examples.push({ ...passed, role: 'passed' }); used.add(passed.id); }

  const borderline = deals
    .filter(d => !used.has(d.id))
    .sort((a, b) => Math.abs(a.total_score - thresholdForBorderline) - Math.abs(b.total_score - thresholdForBorderline))[0];
  if (borderline) { examples.push({ ...borderline, role: 'borderline' }); used.add(borderline.id); }

  return examples;
}

/**
 * getCalibration() — the accessor a headless council skill run consumes as
 * context, replacing the skill's old "read calibration-examples.md" step.
 *
 * Returns:
 *   maturity          'default' | 'partial' | 'personal'
 *   confidence        shrinkage weight w = N/(N+k), 0 at cold start
 *   dealsScored       N — count of deal_evaluations rows with a total_score
 *   examples          [] at cold start; up to 3 real rows (invested/passed/borderline) after
 *   thresholds        { strong, exploring, likely_pass } — shrinkage-blended toward the
 *                      revealed yes/no boundary as deals accumulate
 *   dimensionWeights  lens rubric defaults (v1 — see reweightDimensions() seam above)
 *   note              human-readable maturity/trust indicator for the skill's
 *                      old "tuned to general criteria" line
 */
export async function getCalibration() {
  const rubric = getRubric();
  const defaultTh = defaultThresholds(rubric);
  const defaultWeights = reweightDimensions(defaultDimensionWeights(rubric));

  const deals = await fetchScoredDeals();
  const dealsScored = deals.length;
  const w = dealsScored / (dealsScored + SHRINKAGE_K);

  if (dealsScored === 0) {
    return {
      maturity: 'default',
      confidence: 0,
      dealsScored: 0,
      examples: [],
      thresholds: defaultTh,
      dimensionWeights: defaultWeights,
      note: 'No scored deals yet — scoring from generic rubric anchors, not tuned to your judgment.',
    };
  }

  const revealed = estimateRevealedThreshold(deals);
  const thresholds = {
    strong: blendThreshold(defaultTh.strong, revealed, w),
    exploring: blendThreshold(defaultTh.exploring, revealed, w),
    likely_pass: blendThreshold(defaultTh.likely_pass, revealed, w),
  };

  const examples = pickExamples(deals, thresholds.exploring).map(({ id, company_name, total_score, verdict, invested, passed, eval_date, role }) => ({
    deal_evaluation_id: id,
    company_name,
    total_score,
    verdict,
    invested,
    passed,
    eval_date,
    role,
  }));

  const maturity = dealsScored >= PERSONAL_AT ? 'personal' : dealsScored >= PARTIAL_AT ? 'partial' : 'default';
  const note = maturity === 'personal'
    ? `Tuned to your judgment (${dealsScored} scored deals) — thresholds and examples reflect your actual yes/no decisions.`
    : `Evolving from general criteria toward your judgment (${dealsScored} scored deal${dealsScored === 1 ? '' : 's'}, confidence ${Math.round(w * 100)}%) — still leaning on rubric defaults where your data is thin.`;

  return {
    maturity,
    confidence: Math.round(w * 1000) / 1000,
    dealsScored,
    examples,
    thresholds,
    dimensionWeights: defaultWeights,
    note,
  };
}
