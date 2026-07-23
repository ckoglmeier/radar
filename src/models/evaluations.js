// Parser + CRUD for deal_evaluations table.
// Reads deal-log markdown files from the investment-grading project and
// imports them into the deal_evaluations table in Neon.

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { query } from '../db/index.js';
import { withSyncRun } from '../db/sync-runs.js';
import { matchCompanyToInvestment, loadInvestmentUniverse } from '../utils/match.js';
import { matchCompanyToPipelineInvite } from './pipeline.js';
import { getRubric } from '../lenses/loader.js';
import { scoreCouncilArtifact } from '../council/scoring.js';

const DEAL_LOG_DIR = process.env.DEAL_LOG_DIR || null;

// --- Parser ---

/**
 * Parse a deal-log markdown file and extract structured fields.
 * Returns null if the file can't be parsed meaningfully.
 */
/**
 * Extract the company name from deal-log markdown content.
 * Formats: "# Deal Log: Company Name" / "# Deal Diagnosis: Company Name"
 * or "# Company Name — Deal Assessment" (and variants).
 * Exported so the one-time backfill (db/backfill-eval-companies.js) uses
 * exactly the import path's logic.
 */
// Strict deal-log heading grammar (the "# Deal Log: X" / "# Investment
// Evaluation: X" prefix family).
const DEAL_LOG_HEADING_RE = /^#\s+(?:Deal\s+(?:Log|Diagnosis|Assessment)|Investment\s+Evaluation|Deal\s+Evaluation|Portfolio\s+Review):\s*(.+?)$/m;

// Trailing em-dash context vocabulary that isn't part of the company's name
// ("Mark — Investment Evaluation" -> "Mark", "Groq — Portfolio Review —
// 2026-04-10" -> "Groq"). Also matches the suffix ("X — Deal Assessment")
// heading form, which has no leading "Deal ...:" prefix to trip
// DEAL_LOG_HEADING_RE — stripDealLogVocabulary() below is how that form gets
// recognized as deal-log grammar too.
const CONTEXT_SUFFIX_RE = new RegExp(
  '\\s*—\\s*(?:' +
  [
    'Deal\\s+(?:Assessment|Log|Diagnosis|Evaluation|Review)',
    'Investment\\s+Evaluation', 'Evaluation',
    'Portfolio\\s+Review(?:\\s*—?\\s*\\d{4}-\\d{2}-\\d{2})?',
    'New\\s+Inbound.*',
    '(?:Deck\\s+)?v?\\d+\\s*Regrade', 'Deck.*Regrade', 'Regrade',
    'Pre-?Seed', 'Seed(?:\\s+Round)?',
    'Series\\s+[A-Z]\\d*\\+?(?:\\s*/\\s*[^—]*)?',
    'Angel(?:\\s+Round)?', 'Growth\\s+Raise', 'Crossover\\s+Round',
    '\\d{4}-\\d{2}-\\d{2}',
  ].join('|') +
  ')\\s*$', 'i'
);
const CONTEXT_PARENTHETICAL_RE = /\s*\((?:Portfolio\s+Review|Deal\s+Evaluation|Investment\s+Evaluation|Regrade)\)\s*$/i;

// Strips trailing eval/round/context vocabulary from a heading-derived name.
// Suffixes stack, so strip repeatedly until stable. Unknown suffixes are
// kept — a genuine em-dash company name ("Sword — Shield Robotics") survives.
function stripDealLogVocabulary(name) {
  let prev;
  do { prev = name; name = name.replace(CONTEXT_SUFFIX_RE, '').trim(); } while (name && name !== prev);
  name = name.replace(CONTEXT_PARENTHETICAL_RE, '').trim();
  return name;
}

/**
 * Does this content use deal-log heading grammar? True for the strict
 * prefix form ("# Deal Log: X") and for a bare "# X" heading whose trailing
 * segment is recognized eval/round/context vocabulary ("# X — Deal
 * Assessment", "# X (Portfolio Review)") — i.e. exactly the two heading
 * shapes extractCompanyName recognizes as deal-log-specific, as opposed to
 * its generic "any # Heading" fallback (too weak a signal on its own — a
 * plain markdown doc with a top-level heading isn't a deal-log). Exported so
 * callers that need to know "is this deal-log markdown" (src/intake
 * classification) can ask without re-deriving the grammar.
 */
export function hasDealLogHeading(content) {
  if (!content) return false;
  if (DEAL_LOG_HEADING_RE.test(content)) return true;
  const altHeading = content.match(/^#\s+(.+?)$/m);
  if (!altHeading) return false;
  const raw = altHeading[1].trim();
  return stripDealLogVocabulary(raw) !== raw;
}

export function extractCompanyName(content) {
  if (!content) return null;
  let name = null;
  const headingMatch = content.match(DEAL_LOG_HEADING_RE);
  if (headingMatch) name = headingMatch[1].trim();
  if (!name) {
    const altHeading = content.match(/^#\s+(.+?)$/m);
    if (altHeading) name = altHeading[1].trim();
  }
  if (!name) return null;
  name = stripDealLogVocabulary(name);
  return name || null;
}

export function parseDealLogFile(filePath, opts = {}) {
  const content = readFileSync(filePath, 'utf-8');
  const filename = basename(filePath);
  const parsed = parseDealLogContent(content, filename, opts);
  if (!parsed) return null;
  return { ...parsed, file_path: filePath };
}

// Content-only variant of parseDealLogFile — same regex extraction, no
// filesystem read. Exists so callers that already have bytes in hand (the
// intake pipeline parsing an uploaded/pasted artifact) can reuse the exact
// scoring/verdict/council regexes instead of duplicating them. filename is
// optional and only used for the YYYY-MM-DD-company.md date-from-filename
// convention; pass null/undefined to skip it.
export function parseDealLogContent(content, filename, opts = {}) {
  // Extract eval_date from filename (YYYY-MM-DD-company.md) or from content
  let eval_date = null;
  const dateFromFilename = filename && filename.match(/^(\d{4}-\d{2}-\d{2})-/);
  if (dateFromFilename) {
    eval_date = dateFromFilename[1];
  }
  if (!eval_date) {
    // Try "Date evaluated:" or "Date:" line
    const dateLine = content.match(/\*\*Date(?:\s+evaluated)?:\*\*\s*(\d{4}-\d{2}-\d{2})/);
    if (dateLine) eval_date = dateLine[1];
  }

  // Extract company_name from heading (shared with the backfill script)
  let company_name = extractCompanyName(content);

  // Extract thesis_fit_score — look for "Thesis Fit subtotal:" with various formats
  // Formats: "**Thesis Fit subtotal:** ... **21.5/25**"
  //          "| **Thesis Fit subtotal** | **15/25** |"
  //          "**Thesis Fit subtotal: 10/20**"
  let thesis_fit_score = null;
  const thesisFitPatterns = [
    /Thesis\s+Fit\s+subtotal[:\s]*.*?(\d+(?:\.\d+)?)\s*\/\s*\d+/i,
  ];
  for (const pat of thesisFitPatterns) {
    const m = content.match(pat);
    if (m) {
      thesis_fit_score = parseFloat(m[1]);
      break;
    }
  }

  // Extract viability_score — "Viability subtotal:" with various formats
  let viability_score = null;
  const viabilityPatterns = [
    /Viability\s+subtotal[:\s]*.*?(\d+(?:\.\d+)?)\s*\/\s*\d+/i,
  ];
  for (const pat of viabilityPatterns) {
    const m = content.match(pat);
    if (m) {
      viability_score = parseFloat(m[1]);
      break;
    }
  }

  // Extract total_score — formats vary widely:
  // "### Total: **42/50**"
  // "## Total: 25/45"
  // "## Total: 37/50"  (inside code block)
  let total_score = null;
  const totalPatterns = [
    /#+\s*Total:\s*\*{0,2}(\d+(?:\.\d+)?)\s*\/\s*\d+/m,
    /Total:\s*\*{0,2}(\d+(?:\.\d+)?)\s*\/\s*\d+/m,
  ];
  for (const pat of totalPatterns) {
    const m = content.match(pat);
    if (m) {
      total_score = parseFloat(m[1]);
      break;
    }
  }

  // Extract verdict — formats:
  // "### Verdict: **Strong Fit**"
  // "## Verdict: Likely Pass"
  // "## Verdict: Worth Exploring (high end...)"
  let verdict = null;
  const verdictPatterns = [
    /#+\s*Verdict:\s*\*{0,2}([^*\n]+?)\*{0,2}\s*$/m,
    /Verdict:\s*\*{0,2}([^*\n]+?)\*{0,2}\s*$/m,
  ];
  for (const pat of verdictPatterns) {
    const m = content.match(pat);
    if (m) {
      verdict = m[1].trim();
      break;
    }
  }

  let score_validation = null;
  if (opts.rubric) {
    const computed = scoreCouncilArtifact(content, opts.rubric);
    score_validation = {
      adjusted:
        thesis_fit_score !== computed.thesisFitScore ||
        viability_score !== computed.viabilityScore ||
        total_score !== computed.totalScore ||
        verdict !== computed.verdict,
      declared: {
        thesis_fit_score,
        viability_score,
        total_score,
        verdict,
      },
      computed,
    };
    thesis_fit_score = computed.thesisFitScore;
    viability_score = computed.viabilityScore;
    total_score = computed.totalScore;
    verdict = computed.verdict;
  }

  // Extract council scores from Stage 5c synthesis table
  // Format: "| Bull | XX/50 | ... |" or "| **Bull** | **XX/50** | ... |"
  let council_bull = null, council_bear = null, council_calibrator = null;

  const bullMatch = content.match(/\|\s*\*{0,2}Bull\*{0,2}\s*\|\s*\*{0,2}(\d+(?:\.\d+)?)\s*\/\s*50\*{0,2}/i);
  if (bullMatch) council_bull = parseFloat(bullMatch[1]);

  const bearMatch = content.match(/\|\s*\*{0,2}Bear\*{0,2}\s*\|\s*\*{0,2}(\d+(?:\.\d+)?)\s*\/\s*50\*{0,2}/i);
  if (bearMatch) council_bear = parseFloat(bearMatch[1]);

  const calMatch = content.match(/\|\s*\*{0,2}Calibrator\*{0,2}\s*\|\s*\*{0,2}(\d+(?:\.\d+)?)\s*\/\s*50\*{0,2}/i);
  if (calMatch) council_calibrator = parseFloat(calMatch[1]);
  if (score_validation) council_calibrator = total_score;

  // Extract CFO verdict from council output
  // Format: "| CFO | — | Deploy ... |" or "Verdict: Deploy — ..." in CFO section
  let council_cfo_verdict = null;
  const cfoTableMatch = content.match(/\|\s*\*{0,2}CFO\*{0,2}\s*\|\s*[—\-]+\s*\|\s*\*{0,2}(Deploy|Defer|Pass)\*{0,2}/i);
  if (cfoTableMatch) {
    council_cfo_verdict = cfoTableMatch[1];
  } else {
    // Fallback: look for "Verdict: Deploy/Defer/Pass" in CFO section
    const cfoSectionMatch = content.match(/CFO\s*\(Portfolio Construction\)[\s\S]*?Verdict:\s*(Deploy|Defer|Pass)/i);
    if (cfoSectionMatch) council_cfo_verdict = cfoSectionMatch[1];
  }

  // Compute spread and consensus if we have council data
  let council_spread = null, council_consensus = null, council_divergence = null;
  const councilScores = [council_bull, council_bear, council_calibrator].filter(s => s != null);
  if (councilScores.length >= 2) {
    council_spread = Math.max(...councilScores) - Math.min(...councilScores);
    council_consensus = councilScores.reduce((a, b) => a + b, 0) / councilScores.length;
    council_divergence = council_spread > 10 ? 'HIGH' : council_spread > 5 ? 'MODERATE' : 'LOW';
  }

  if (!company_name) return null;

  return {
    eval_date,
    company_name,
    thesis_fit_score,
    viability_score,
    total_score,
    verdict,
    council_bull,
    council_bear,
    council_calibrator,
    council_spread,
    council_consensus,
    council_divergence,
    council_cfo_verdict,
    score_validation,
  };
}

// --- Import ---

/**
 * Import all deal-log markdown files into deal_evaluations.
 * Skips files already imported (by file_path). Links to investments and pipeline invites.
 */
export async function importDealLogs(dir = DEAL_LOG_DIR, opts = {}) {
  if (!dir) {
    throw new Error('DEAL_LOG_DIR is not set. Add it to .env (path to your deal-log markdown directory).');
  }
  return withSyncRun('deal-log:import', `import ${dir}`, async () => {
    return runDealLogImport(dir, opts);
  });
}

async function runDealLogImport(dir, opts = {}) {
  const evalMode = opts.mode || 'standard';
  const requestedFiles = opts.files
    ? new Set(opts.files.map(file => basename(file)))
    : null;
  const files = readdirSync(dir).filter(file =>
    file.endsWith('.md') && (!requestedFiles || requestedFiles.has(file)));
  const rubric = evalMode === 'council' ? getRubric() : null;
  const provenance = opts.provenance || {};
  const results = {
    total: files.length,
    imported: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };

  // Load investments universe once per batch.
  const universe = await loadInvestmentUniverse();

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const raw_content = readFileSync(filePath, 'utf-8');

      // Check if already imported
      const existing = await query(
        `SELECT id FROM deal_evaluations WHERE file_path = $1 LIMIT 1`,
        [filePath]
      );
      if (existing.length > 0) {
        // Backfill raw_content if not yet stored
        await query(
          `UPDATE deal_evaluations SET raw_content = $1 WHERE id = $2 AND raw_content IS NULL`,
          [raw_content, existing[0].id]
        );
        results.skipped++;
        results.details.push({ file, company: null, status: 'skipped' });
        continue;
      }

      const parsed = parseDealLogFile(filePath, { rubric });
      if (!parsed) {
        results.errors++;
        results.details.push({ file, company: null, status: 'parse_error', error: 'Could not parse file' });
        continue;
      }

      // Try to link to an investment
      let investment_id = null;
      const investMatch = await matchCompanyToInvestment(parsed.company_name, { universe });
      if (investMatch.confidence === 'exact' || investMatch.confidence === 'token') {
        investment_id = investMatch.investment_id;
      }

      // Try to link to a pipeline invite (multi-strategy fuzzy match) —
      // shared with src/intake via models/pipeline.js so the two callers
      // can't drift apart.
      const inviteMatch = await matchCompanyToPipelineInvite(parsed.company_name);
      const pipeline_invite_id = inviteMatch.invite_id;
      const pipeline_status = inviteMatch.status;

      // Determine invested flag
      let invested = false;
      if (investment_id) invested = true;
      if (pipeline_status === 'committed' || pipeline_status === 'invested') invested = true;

      // Insert
      await query(
        `INSERT INTO deal_evaluations
           (investment_id, pipeline_invite_id, eval_date, file_path, thesis_fit_score, viability_score, total_score, verdict, invested,
            council_bull_score, council_bear_score, council_calibrator_score, council_spread, council_consensus, council_divergence, council_cfo_verdict,
            eval_mode, raw_content, company_name, council_policy, council_policy_version, council_instruction_hash,
            council_lens_hash, council_calibration_hash, council_input_hash, council_artifact_hash,
            council_session_id, council_model_policy, council_score_adjusted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
                 $20, $21, $22, $23, $24, $25, $26, $27, $28, $29)`,
        [
          investment_id,
          pipeline_invite_id,
          parsed.eval_date,
          parsed.file_path,
          parsed.thesis_fit_score,
          parsed.viability_score,
          parsed.total_score,
          parsed.verdict,
          invested,
          parsed.council_bull,
          parsed.council_bear,
          parsed.council_calibrator,
          parsed.council_spread,
          parsed.council_consensus,
          parsed.council_divergence,
          parsed.council_cfo_verdict,
          evalMode,
          raw_content,
          parsed.company_name,
          provenance.policyId || null,
          provenance.policyVersion || null,
          provenance.instructionHash || null,
          provenance.lensHash || null,
          provenance.calibrationHash || null,
          provenance.inputHash || null,
          provenance.artifactHashes?.[file] || null,
          provenance.sessionId || null,
          provenance.modelPolicy ? JSON.stringify(provenance.modelPolicy) : null,
          Boolean(parsed.score_validation?.adjusted),
        ]
      );

      results.imported++;
      results.details.push({
        file,
        company: parsed.company_name,
        status: 'imported',
        investment_id,
        pipeline_invite_id,
        invested,
        total_score: parsed.total_score,
        verdict: parsed.verdict,
        score_adjusted: Boolean(parsed.score_validation?.adjusted),
      });
    } catch (err) {
      results.errors++;
      results.details.push({ file, company: null, status: 'error', error: err.message });
    }
  }

  // sync_runs fields
  results.records_seen = results.total;
  results.records_new = results.imported;
  results.records_changed = 0;
  results.error_details = results.errors > 0
    ? results.details.filter(d => d.status === 'error' || d.status === 'parse_error')
    : null;

  return results;
}

// --- Queries ---

export async function listEvaluations() {
  return query(
    `SELECT de.*,
            i.company_name AS inv_company_name,
            pi.company_name AS pipe_company_name,
            pi.status AS pipe_status
     FROM deal_evaluations de
     LEFT JOIN investments i ON de.investment_id = i.id
     LEFT JOIN pipeline_invites pi ON de.pipeline_invite_id = pi.id
     ORDER BY de.eval_date DESC NULLS LAST, de.id DESC`
  );
}

export async function evaluationHistoryForInvite(inviteId) {
  const rows = await query(
    `SELECT de.*
     FROM deal_evaluations de
     WHERE de.pipeline_invite_id = $1
     ORDER BY de.eval_date DESC NULLS LAST, de.created_at ASC, de.id ASC`,
    [inviteId]
  );
  return rows.map(resolveEvalContent);
}

function resolveEvalContent(row) {
  if (!row) return null;
  let rawText = row.raw_content || null;
  if (!rawText && row.file_path) {
    try { rawText = readFileSync(row.file_path, 'utf-8'); } catch { rawText = null; }
  }
  row.content_markdown = rawText || null;
  return row;
}

export async function getEvaluationByCompany(search) {
  // Try exact file_path match on company slug
  const slug = search.toLowerCase().replace(/\s+/g, '-');
  const byPath = await query(
    `SELECT de.*, i.company_name AS inv_company_name
     FROM deal_evaluations de
     LEFT JOIN investments i ON de.investment_id = i.id
     WHERE de.file_path ILIKE $1
     LIMIT 1`,
    [`%${slug}%`]
  );
  if (byPath.length > 0) return resolveEvalContent(byPath[0]);

  // Own persisted company name (evals for passed deals have no joins to match)
  const byOwnName = await query(
    `SELECT de.*, i.company_name AS inv_company_name
     FROM deal_evaluations de
     LEFT JOIN investments i ON de.investment_id = i.id
     WHERE de.company_name ILIKE $1
     ORDER BY de.eval_date DESC NULLS LAST, de.created_at ASC, de.id ASC
     LIMIT 1`,
    [`%${search}%`]
  );
  if (byOwnName.length > 0) return resolveEvalContent(byOwnName[0]);

  // Try parsing company name from file content
  const all = await listEvaluations();
  const lower = search.toLowerCase();
  const match = all.find(r => {
    // Extract company name from file_path slug
    const fn = basename(r.file_path || '');
    const nameSlug = fn.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
    return nameSlug.includes(lower) || lower.includes(nameSlug);
  });
  return resolveEvalContent(match || null);
}
