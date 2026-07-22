// Universal Intake — classify / preview / commit.
// Authoritative spec: docs/INTAKE_BUILD_PLAN.md in radar-app ("Commit
// contract & artifact lifecycle" and "Provenance attachment matrix"). This
// module is glue over existing, already-tested parsers — deterministic, no
// LLM. See the file-level comments on each helper for exactly which parser
// is reused from where.

import { createHash } from 'crypto';
import { query, isPgliteActive } from '../db/index.js';
import {
  createPendingIntake,
  getPendingIntake,
  markPendingCommitted,
  updatePendingRefs,
  sweepExpiredPending,
  MAX_SIZE_BYTES,
} from '../models/documents.js';
import { DocumentStore } from './document-store.js';
import { parseInviteEmail } from '../sync/parsers/angellist-invite.js';
import { upsertInvite, matchCompanyToPipelineInvite } from '../models/pipeline.js';
import { hasDealLogHeading, parseDealLogContent, extractCompanyName } from '../models/evaluations.js';
import { parseUpdateContent } from '../models/updates.js';
import { matchCompanyToInvestment, loadInvestmentUniverse } from '../utils/match.js';
import { parseEml, looksLikeRFC822 } from './parse-eml.js';

// entity_type (documents table enum) a domain type's created row attaches
// as, per the provenance attachment matrix. 'document' has no domain row —
// it attaches to whatever entity the user picks in overrides.
const DOMAIN_ENTITY_TYPE = {
  pipeline_invite: 'pipeline_invite',
  company_update: 'company_update',
  deal_log_eval: 'deal_evaluation',
};

// ---------------------------------------------------------------------------
// withTx — transaction honesty
// ---------------------------------------------------------------------------

/**
 * Runs fn() as a unit, using a real transaction when the active driver
 * supports one.
 *
 * PGlite (local/CLI): a single embedded instance holds session state across
 * separate query() calls, so BEGIN/COMMIT/ROLLBACK behave like a normal
 * Postgres connection — verified empirically (see src/intake/test-intake.js,
 * "withTx: PGlite rolls back on failure"). On any error inside fn(), the
 * ROLLBACK discards every statement fn() issued, including intermediate
 * created_refs bookkeeping — the pending row lands back exactly where it
 * started, no resumption bookkeeping needed.
 *
 * Neon (hosted, until the S1 pg-driver swap): the @neondatabase/serverless
 * HTTP driver issues one HTTP request per query() call with no shared
 * session — a BEGIN in one call has nothing durable to COMMIT/ROLLBACK
 * against in the next, so wrapping fn() in BEGIN/COMMIT here would be a lie.
 * withTx runs fn() directly instead; every statement inside fn() commits
 * immediately as it executes. Safety instead comes from intakeCommit's
 * *ordered writes + progressive created_refs*: each write is recorded into
 * pending_intake.created_refs (via updatePendingRefs) the moment it
 * succeeds, while status stays 'pending'. If a later step throws, the
 * already-written rows are durable AND tracked — nothing is unrecorded — and
 * a retry with the same preview_id resumes from created_refs instead of
 * re-creating them. status only flips to 'committed' after every step (incl.
 * the document) has succeeded.
 */
export async function withTx(fn) {
  const pglite = await isPgliteActive();
  if (!pglite) {
    return fn();
  }
  await query('BEGIN');
  try {
    const result = await fn();
    await query('COMMIT');
    return result;
  } catch (err) {
    try {
      await query('ROLLBACK');
    } catch {
      // Connection may already be unusable; the original error is what matters.
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// classifyArtifact
// ---------------------------------------------------------------------------

function bufferToTextOrNull(buf) {
  if (!buf || buf.length === 0) return null;
  const text = buf.toString('utf-8');
  // Invalid UTF-8 byte sequences decode to U+FFFD — a reliable "this is
  // binary, not text" signal for content that didn't already contain the
  // character on purpose (vanishingly unlikely for the artifact families
  // this pipeline handles).
  if (text.includes('�')) return null;
  // Binary content that happens to be valid UTF-8 byte-for-byte (rare, but
  // possible for small random buffers) still reads as mostly control bytes.
  // eslint-disable-next-line no-control-regex
  const controlChars = (text.match(/[\x00-\x08\x0E-\x1F]/g) || []).length;
  if (text.length > 0 && controlChars / text.length > 0.02) return null;
  return text;
}

/**
 * Deterministic, no-LLM classification of a dropped/pasted artifact.
 *
 * Returns { type, confidence, parsed } where `parsed` is classifier-internal
 * (the full object the underlying parser returned — richer than the wire
 * `fields` shape) so intakePreview/intakeCommit can build both the trimmed
 * preview and the full domain-row insert from one classification call.
 */
export function classifyArtifact(content, filename, mime) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const lowerName = (filename || '').toLowerCase();

  // --- PDF: stored, not parsed (v1) ---
  if (mime === 'application/pdf' || lowerName.endsWith('.pdf')) {
    return { type: 'document', confidence: 'high', parsed: null };
  }

  const text = bufferToTextOrNull(buf);

  // --- RFC822 email: reuse the EXISTING AngelList invite parser ---
  const looksLikeEmail = lowerName.endsWith('.eml') || mime === 'message/rfc822' || (text && looksLikeRFC822(text));
  if (looksLikeEmail && text) {
    const eml = parseEml(buf);
    try {
      const invite = parseInviteEmail({
        subject: eml.subject,
        from: eml.from,
        receivedAt: eml.receivedAt,
        text: eml.text,
        html: eml.html,
        messageId: eml.messageId,
      });
      return { type: 'pipeline_invite', confidence: 'high', parsed: invite };
    } catch {
      // A real email, but not one the invite parser recognizes — the
      // residual class per the build plan: a founder-update email.
      return { type: 'company_update', confidence: 'low', parsed: null };
    }
  }

  if (!text) {
    return { type: 'unknown', confidence: 'low', parsed: null };
  }

  // --- deal-log markdown grammar: reuse extractCompanyName + the
  // migration-027 score-parsing entry point (models/evaluations.js) ---
  if (hasDealLogHeading(text)) {
    const parsedEval = parseDealLogContent(text, filename);
    if (parsedEval) {
      return { type: 'deal_log_eval', confidence: 'high', parsed: parsedEval };
    }
  }

  // --- structured company-update markdown (YAML frontmatter): reuse the
  // company-updates markdown parser (models/updates.js) ---
  const parsedUpdate = parseUpdateContent(text);
  if (parsedUpdate) {
    return { type: 'company_update', confidence: 'high', parsed: parsedUpdate };
  }

  // --- residual text/markdown: company_update candidate, low confidence.
  // No frontmatter, no deal-log heading — best-effort company name only
  // (reuses extractCompanyName's generic "# Heading" fallback branch; most
  // freeform prose won't have one, and that's fine — fields stay null and
  // the user resolves it via the required entity override). ---
  const fallbackName = extractCompanyName(text);
  return {
    type: 'company_update',
    confidence: 'low',
    parsed: fallbackName ? { company_name: fallbackName } : null,
  };
}

// ---------------------------------------------------------------------------
// intakePreview
// ---------------------------------------------------------------------------

function isUnsupportedBinaryMime(mime) {
  if (!mime) return false;
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return true;
  if (m === 'application/zip' || m === 'application/x-zip-compressed') return true;
  if (m === 'application/octet-stream') return true;
  return false;
}

// Applies matchCompanyToInvestment + (for types that link to pipeline_invites)
// matchCompanyToPipelineInvite, and returns the wire `company` block plus any
// warnings the match itself produces. Mutates nothing — pure read.
async function matchCompany(companyName, { withInvite, universe }) {
  const company = { matched_investment_id: null, matched_invite_id: null, name: companyName || null, match_basis: null };
  const warnings = [];
  if (!companyName) return { company, warnings };

  const invMatch = await matchCompanyToInvestment(companyName, { universe });
  company.matched_investment_id = invMatch.investment_id;
  if (invMatch.confidence === 'exact') company.match_basis = 'exact';
  else if (invMatch.confidence === 'token') company.match_basis = 'token';
  if (invMatch.confidence === 'ambiguous') warnings.push('AMBIGUOUS_COMPANY_MATCH');
  else if (invMatch.confidence === 'unmatched') warnings.push('NO_COMPANY_MATCH');

  if (withInvite) {
    const inviteMatch = await matchCompanyToPipelineInvite(companyName);
    company.matched_invite_id = inviteMatch.invite_id;
    if (!company.match_basis && inviteMatch.match_basis) company.match_basis = inviteMatch.match_basis;
  }

  return { company, warnings };
}

/**
 * intakePreview({ content, filename, mime }) -> preview | { error }
 * Contract shape: docs/INTAKE_BUILD_PLAN.md "Commit contract & artifact
 * lifecycle". INVARIANT (tested): performs ZERO writes to domain tables —
 * its only write is the pending_intake staging row.
 */
export async function intakePreview({ content, filename, mime }) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);

  if (buf.length > MAX_SIZE_BYTES) {
    return { error: 'FILE_TOO_LARGE' };
  }

  // Opportunistic housekeeping — never blocks the preview on its own error
  // path beyond the natural "DB is down" case, which would fail every other
  // call here too.
  await sweepExpiredPending();

  const classified = classifyArtifact(buf, filename, mime);

  if (classified.type === 'unknown' && isUnsupportedBinaryMime(mime)) {
    return { error: 'UNSUPPORTED_MIME' };
  }

  const sha256 = createHash('sha256').update(buf).digest('hex');
  const universe = await loadInvestmentUniverse();

  let fields = {};
  let company = { matched_investment_id: null, matched_invite_id: null, name: null, match_basis: null };
  const warnings = [];
  const required_overrides = [];

  if (classified.type === 'pipeline_invite') {
    const p = classified.parsed;
    fields = {
      company_name: p.company_name ?? null,
      lead: p.lead ?? null,
      round: p.round ?? null,
      market: p.market ?? null,
      allocation_usd: p.allocation_usd ?? null,
      min_investment_usd: p.min_investment_usd ?? null,
      carry_pct: p.carry_pct ?? null,
      valuation_usd: p.valuation_usd ?? null,
      email_received_at: p.email_received_at ?? null,
    };
    const m = await matchCompany(fields.company_name, { withInvite: true, universe });
    company = m.company;
    warnings.push(...m.warnings);
    if (!fields.email_received_at) warnings.push('MISSING_DATE');
    const structuredCount = [fields.allocation_usd, fields.min_investment_usd, fields.valuation_usd].filter(v => v != null).length;
    if (structuredCount === 0) warnings.push('PARSE_PARTIAL');
  } else if (classified.type === 'deal_log_eval') {
    const p = classified.parsed;
    fields = {
      company_name: p.company_name ?? null,
      eval_date: p.eval_date ?? null,
      total_score: p.total_score ?? null,
      thesis_fit_score: p.thesis_fit_score ?? null,
      viability_score: p.viability_score ?? null,
      verdict: p.verdict ?? null,
      has_council: !!(p.council_bull != null || p.council_bear != null || p.council_calibrator != null || p.council_cfo_verdict != null),
    };
    const m = await matchCompany(fields.company_name, { withInvite: true, universe });
    company = m.company;
    warnings.push(...m.warnings);
    if (!fields.eval_date) warnings.push('MISSING_DATE');
    if (fields.total_score == null) warnings.push('PARSE_PARTIAL');
  } else if (classified.type === 'company_update') {
    const p = classified.parsed;
    fields = {
      company_name: p?.company_name ?? null,
      update_date: p?.update_date ?? null,
      quarter: p?.quarter ?? null,
      revenue_arr: p?.revenue_arr ?? null,
      burn_rate: p?.burn_rate ?? null,
      runway_months: p?.runway_months ?? null,
      headcount: p?.headcount ?? null,
      has_review: p?.has_review ?? null,
    };
    const m = await matchCompany(fields.company_name, { withInvite: false, universe });
    company = m.company;
    warnings.push(...m.warnings);
    if (!fields.company_name) warnings.push('NO_COMPANY_MATCH'); // no name at all to even attempt a match
    if (!fields.update_date) warnings.push('MISSING_DATE');
    if (classified.confidence === 'low') warnings.push('PARSE_PARTIAL');
    if (company.matched_investment_id == null) required_overrides.push('entity');
  } else if (classified.type === 'document') {
    fields = {};
    required_overrides.push('entity');
  } else {
    // unknown
    fields = {};
    required_overrides.push('type');
  }

  const dupes = await DocumentStore.findBySha(sha256);
  if (dupes.length > 0 && !warnings.includes('DUPLICATE_SUSPECTED')) warnings.push('DUPLICATE_SUSPECTED');

  const preview = {
    type: classified.type,
    confidence: classified.confidence,
    company,
    fields,
    warnings,
    required_overrides,
    artifact: { filename: filename ?? null, mime: mime ?? null, sha256, bytes: buf.length },
  };

  const pendingRow = await createPendingIntake({
    filename: filename ?? null,
    mime: mime ?? null,
    sha256,
    content: buf,
    preview,
  });

  return { preview_id: pendingRow.id, ...preview };
}

// ---------------------------------------------------------------------------
// intakeCommit — domain writers (one per type in the attachment matrix)
// ---------------------------------------------------------------------------

// pipeline_invite: reuses the sync importer's insert path (upsertInvite),
// which does its own investment matching, dedup by gmail_message_id/
// deal_slug, and pipeline_events logging — exactly the path a Gmail-synced
// invite goes through.
async function insertPipelineInvite(parsed, overrides = {}) {
  const universe = await loadInvestmentUniverse();
  // New-deal override: the artifact didn't parse as an invite (founder
  // email, pitch PDF, plain text) — synthesize a minimal invite from the
  // user-supplied company name. deal_slug is required for the app's
  // /pipeline/[slug] linking; keep it unique + readable.
  let invite = parsed;
  if (overrides.company_name && typeof overrides.company_name === 'string') {
    const name = overrides.company_name.trim();
    const slugBase = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const stamp = new Date().toISOString().slice(0, 10);
    invite = {
      ...(parsed && parsed.company_name ? parsed : {}),
      company_name: name,
      deal_slug: `${slugBase}-intake-${stamp}`,
      status: 'invite',
    };
  }
  const result = await upsertInvite({ ...invite, source: 'intake' }, { universe });
  return { table: 'pipeline_invites', id: result.id };
}

// deal_log_eval: mirrors models/evaluations.js's runDealLogImport insert
// exactly (same columns, same investment/invite matching calls), minus the
// filesystem-only file_path (no file backs an intake artifact — the
// documents table holds the real bytes).
async function insertDealLogEval(parsed, content) {
  const universe = await loadInvestmentUniverse();
  const investMatch = await matchCompanyToInvestment(parsed.company_name, { universe });
  const investment_id = (investMatch.confidence === 'exact' || investMatch.confidence === 'token') ? investMatch.investment_id : null;

  const inviteMatch = await matchCompanyToPipelineInvite(parsed.company_name);
  const pipeline_invite_id = inviteMatch.invite_id;

  let invested = false;
  if (investment_id) invested = true;
  if (inviteMatch.status === 'committed' || inviteMatch.status === 'invested') invested = true;

  const rows = await query(
    `INSERT INTO deal_evaluations
       (investment_id, pipeline_invite_id, eval_date, file_path, thesis_fit_score, viability_score, total_score, verdict, invested,
        council_bull_score, council_bear_score, council_calibrator_score, council_spread, council_consensus, council_divergence, council_cfo_verdict,
        eval_mode, raw_content, company_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING id`,
    [
      investment_id,
      pipeline_invite_id,
      parsed.eval_date,
      null,
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
      'standard',
      content.toString('utf-8'),
      parsed.company_name,
    ]
  );
  return { table: 'deal_evaluations', id: rows[0].id };
}

// company_update: mirrors models/updates.js's runUpdatesImport upsert-by-
// (company_name, quarter) pattern (same columns, same UPDATE-if-existing
// branch) so re-committing an artifact that collides on that unique
// constraint updates in place instead of erroring. Two v1-specific defaults
// that only apply to intake (the file-backed importer never hits either):
//  - update_date defaults to today when no date parsed (a founder-update
//    email/paste with no frontmatter has no date to extract; NOT NULL).
//  - file_path becomes `intake:<preview_id>` (a marker, not a real path —
//    NOT NULL; the actual bytes live in the documents table).
async function insertCompanyUpdate(parsed, content, preview_id, overrides) {
  let investment_id = null;
  let company_name = parsed?.company_name || null;

  if (overrides.entity_type === 'investment' && overrides.entity_id) {
    investment_id = overrides.entity_id;
    if (!company_name) {
      const rows = await query(`SELECT company_name FROM investments WHERE id = $1`, [investment_id]);
      company_name = rows[0]?.company_name || null;
    }
  } else if (company_name) {
    const universe = await loadInvestmentUniverse();
    const match = await matchCompanyToInvestment(company_name, { universe });
    if (match.confidence === 'exact' || match.confidence === 'token') investment_id = match.investment_id;
  }

  if (!company_name) {
    // Unreachable in practice: required_overrides forces an entity override
    // whenever no company_name/match exists, and that override resolves one
    // via the investments lookup above.
    throw new Error('intakeCommit: company_update has no company_name and no entity override resolved one');
  }

  const update_date = parsed?.update_date || new Date().toISOString().slice(0, 10);
  const quarter = parsed?.quarter || null;
  const raw_content = content.toString('utf-8');
  const file_path = `intake:${preview_id}`;

  const existing = await query(
    `SELECT id FROM company_updates WHERE company_name = $1 AND quarter = $2 LIMIT 1`,
    [company_name, quarter]
  );

  if (existing.length > 0) {
    await query(
      `UPDATE company_updates SET
         investment_id = $1, update_date = $2,
         revenue_arr = $3, burn_rate = $4, runway_months = $5,
         headcount = $6, cash_on_hand = $7,
         source = $8, attachment_ref = $9, file_path = $10,
         has_review = $11, has_feedback = $12,
         raw_content = $13,
         updated_at = NOW()
       WHERE id = $14`,
      [
        investment_id, update_date,
        parsed?.revenue_arr ?? null, parsed?.burn_rate ?? null, parsed?.runway_months ?? null,
        parsed?.headcount ?? null, parsed?.cash_on_hand ?? null,
        'intake', null, file_path,
        parsed?.has_review ?? false, false,
        raw_content,
        existing[0].id,
      ]
    );
    return { table: 'company_updates', id: existing[0].id };
  }

  const rows = await query(
    `INSERT INTO company_updates
       (company_name, investment_id, update_date, quarter,
        revenue_arr, burn_rate, runway_months, headcount, cash_on_hand,
        source, attachment_ref, file_path, has_review, has_feedback, raw_content)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id`,
    [
      company_name, investment_id, update_date, quarter,
      parsed?.revenue_arr ?? null, parsed?.burn_rate ?? null, parsed?.runway_months ?? null,
      parsed?.headcount ?? null, parsed?.cash_on_hand ?? null,
      'intake', null, file_path,
      parsed?.has_review ?? false, false,
      raw_content,
    ]
  );
  return { table: 'company_updates', id: rows[0].id };
}

async function writeDomainRow(effectiveType, parsed, content, preview_id, overrides) {
  if (effectiveType === 'pipeline_invite') return insertPipelineInvite(parsed, overrides);
  if (effectiveType === 'deal_log_eval') return insertDealLogEval(parsed, content);
  if (effectiveType === 'company_update') return insertCompanyUpdate(parsed, content, preview_id, overrides);
  throw new Error(`intakeCommit: no domain writer for type '${effectiveType}'`);
}

// ---------------------------------------------------------------------------
// intakeCommit
// ---------------------------------------------------------------------------

/**
 * intakeCommit({ preview_id, overrides }) -> { created, document_id, idempotent_replay }
 * Contract: docs/INTAKE_BUILD_PLAN.md "Commit contract & artifact lifecycle".
 *
 * Server-trust: re-reads the server's stored artifact bytes + stored preview
 * from pending_intake — nothing client-supplied beyond preview_id and
 * overrides is trusted. Domain-row fields are re-derived from the stored raw
 * bytes via classifyArtifact (deterministic — same bytes, same result) rather
 * than the trimmed wire `fields` on the stored preview, so intake doesn't
 * lose columns (co_investors, gp_message, dataroom_url, council scores, ...)
 * that exist on the domain row but aren't part of the discriminated preview
 * `fields` shape.
 */
export async function intakeCommit({ preview_id, overrides = {} }) {
  const pending = await getPendingIntake(preview_id);
  if (!pending) {
    throw new Error(`intakeCommit: no pending intake for preview_id=${preview_id} (missing or expired)`);
  }

  if (pending.status === 'committed') {
    const refs = pending.created_refs || {};
    return { created: refs.created ?? null, document_id: refs.document_id ?? null, idempotent_replay: true };
  }

  const preview = pending.preview;
  const effectiveType = overrides.type || preview.type;

  if (overrides.type && overrides.type !== preview.type) {
    const toDocument = preview.type === 'unknown' && overrides.type === 'document';
    // New-deal escape hatch: ANY artifact may become a new pipeline deal —
    // a founder email that isn't an AngelList invite, a pitch-deck PDF, an
    // unclassifiable pitch. Requires overrides.company_name (there is no
    // existing row to match). The artifact rides along as provenance.
    const toNewDeal = overrides.type === 'pipeline_invite';
    if (!toDocument && !toNewDeal) {
      throw new Error(
        `intakeCommit: type override to '${overrides.type}' is not supported ` +
        `(overrides: 'document' for unclassified artifacts, or 'pipeline_invite' with company_name for new deals)`
      );
    }
  }

  const missing = [];
  if (preview.type === 'unknown' && !overrides.type) missing.push('type');
  if (overrides.type === 'pipeline_invite' && overrides.type !== preview.type
      && !(typeof overrides.company_name === 'string' && overrides.company_name.trim())) {
    missing.push('company_name');
  }
  if (effectiveType === 'document' && !(overrides.entity_type && overrides.entity_id)) missing.push('entity');
  if (effectiveType === 'company_update' && preview.company?.matched_investment_id == null && !(overrides.entity_type && overrides.entity_id)) {
    missing.push('entity');
  }
  if (missing.length > 0) {
    throw new Error(`intakeCommit: required overrides unmet: ${missing.join(', ')}`);
  }

  const content = Buffer.isBuffer(pending.content) ? pending.content : Buffer.from(pending.content);

  const result = await withTx(async () => {
    let refs = pending.created_refs || {};
    let created = refs.created ?? null;

    if (effectiveType !== 'document' && !created) {
      const classified = classifyArtifact(content, pending.filename, pending.mime);
      created = await writeDomainRow(effectiveType, classified.parsed, content, preview_id, overrides);
      refs = { ...refs, created };
      await updatePendingRefs(pending.id, refs);
    }

    const entity_type = effectiveType === 'document' ? overrides.entity_type : DOMAIN_ENTITY_TYPE[effectiveType];
    const entity_id = effectiveType === 'document' ? overrides.entity_id : created.id;

    let document_id = refs.document_id ?? null;
    if (!document_id) {
      const doc = await DocumentStore.put({
        entity_type,
        entity_id,
        filename: pending.filename,
        mime: pending.mime,
        sha256: pending.sha256,
        content,
        source: 'intake',
      });
      document_id = doc.id;
      refs = { ...refs, document_id };
      await updatePendingRefs(pending.id, refs);
    }

    await markPendingCommitted(pending.id, refs);

    return { created, document_id };
  });

  return { ...result, idempotent_replay: false };
}
