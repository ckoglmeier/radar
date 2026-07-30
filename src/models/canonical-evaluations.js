import { query as defaultQuery } from '../db/index.js';

const NON_PROMOTING_RUN_TYPES = new Set(['controlled_replay', 'review_import']);

function exactNormalizedName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function evaluationGroupKey(row) {
  if (row.pipeline_invite_id != null) return `pipeline:${row.pipeline_invite_id}`;
  if (row.investment_id != null) return `investment:${row.investment_id}`;
  return `unlinked:${exactNormalizedName(row.company_name)}`;
}

function completedAt(row) {
  const value = row.run_completed_at || row.created_at || row.eval_date || 0;
  return new Date(value).getTime() || 0;
}

function promotes(row) {
  if (row.run_status && row.run_status !== 'completed') return false;
  if (row.promotes_to_canonical != null) return Boolean(row.promotes_to_canonical);
  return !NON_PROMOTING_RUN_TYPES.has(row.run_type);
}

function newestFirst(a, b) {
  return completedAt(b) - completedAt(a) || Number(b.id) - Number(a.id);
}

function numericDelta(value, prior) {
  if (value == null || prior == null) return null;
  return Number(value) - Number(prior);
}

function sourceIdentity(entry) {
  return `${entry?.document_id || ''}:${entry?.sha256 || ''}`;
}

function sourceDelta(fromManifest, toManifest) {
  if (!Array.isArray(fromManifest) || !Array.isArray(toManifest)) return null;
  const from = new Map(fromManifest.map(entry => [sourceIdentity(entry), entry]));
  const to = new Map(toManifest.map(entry => [sourceIdentity(entry), entry]));
  return {
    added: [...to.entries()]
      .filter(([key]) => !from.has(key))
      .map(([, entry]) => entry.filename || `Document ${entry.document_id}`),
    removed: [...from.entries()]
      .filter(([key]) => !to.has(key))
      .map(([, entry]) => entry.filename || `Document ${entry.document_id}`),
  };
}

export function annotateCanonicalEvaluations(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const key = evaluationGroupKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const annotated = [];
  for (const [groupKey, groupRows] of groups) {
    const ordered = [...groupRows].sort(newestFirst);
    const promotable = ordered.filter(promotes);
    const canonical = promotable[0] || null;
    const priorCanonicalById = new Map();
    for (const [index, row] of promotable.entries()) {
      priorCanonicalById.set(Number(row.id), promotable[index + 1] || null);
    }
    const byId = new Map(ordered.map(row => [Number(row.id), row]));

    for (const row of ordered) {
      const parent = row.parent_evaluation_id == null
        ? null
        : byId.get(Number(row.parent_evaluation_id)) || null;
      const priorCanonical = priorCanonicalById.get(Number(row.id)) || null;
      const isCanonical = canonical != null && Number(canonical.id) === Number(row.id);
      annotated.push({
        ...row,
        canonical_group_key: groupKey,
        is_canonical: isCanonical,
        canonical_evaluation_id: canonical?.id || null,
        parent_evaluation_id: row.parent_evaluation_id || null,
        superseded_by_evaluation_id: isCanonical ? null : canonical?.id || null,
        changed_canonical_assessment: priorCanonical
          ? (
            numericDelta(row.total_score, priorCanonical.total_score) !== 0
            || String(row.verdict || '') !== String(priorCanonical.verdict || '')
          )
          : false,
        score_delta_from_parent: parent
          ? numericDelta(row.total_score, parent.total_score)
          : null,
        score_delta_from_prior_canonical: priorCanonical
          ? numericDelta(row.total_score, priorCanonical.total_score)
          : null,
        source_manifest_changed: parent
          ? row.council_source_manifest_sha256 !== parent.council_source_manifest_sha256
          : null,
        evidence_version_changed: parent
          ? (
            row.council_research_snapshot_sha256 !== parent.council_research_snapshot_sha256
            || row.council_evidence_contract_version !== parent.council_evidence_contract_version
          )
          : null,
        canonical_total_score: canonical?.total_score ?? null,
        canonical_thesis_fit_score: canonical?.thesis_fit_score ?? null,
        canonical_viability_score: canonical?.viability_score ?? null,
        canonical_verdict: canonical?.verdict ?? null,
        score_delta_to_canonical: canonical
          ? numericDelta(row.total_score, canonical.total_score)
          : null,
        thesis_fit_delta_to_canonical: canonical
          ? numericDelta(row.thesis_fit_score, canonical.thesis_fit_score)
          : null,
        viability_delta_to_canonical: canonical
          ? numericDelta(row.viability_score, canonical.viability_score)
          : null,
        source_delta_to_canonical: canonical
          ? sourceDelta(row.source_manifest, canonical.source_manifest)
          : null,
        earlier_evaluation_count: ordered.filter(candidate => candidate.id !== row.id).length,
      });
    }
  }
  return annotated.sort(newestFirst);
}

export async function canonicalEvaluationLedger(options = {}, deps = {}) {
  const query = deps.query || defaultQuery;
  const evaluations = await query(`
    SELECT
      de.*,
      cr.status AS run_status,
      cr.run_type,
      cr.previous_evaluation_id AS parent_evaluation_id,
      cr.completed_at AS run_completed_at,
      cr.source_manifest,
      cr.source_coverage,
      cr.research_snapshot,
      cr.usage_snapshot,
      cr.error_code AS run_error_code,
      cr.error_message AS run_error_message,
      pi.company_name AS pipeline_company_name,
      pi.deal_slug AS pipeline_deal_slug,
      i.company_name AS investment_company_name
    FROM deal_evaluations de
    LEFT JOIN council_runs cr ON cr.id = de.council_run_id
    LEFT JOIN pipeline_invites pi ON pi.id = de.pipeline_invite_id
    LEFT JOIN investments i ON i.id = de.investment_id
  `);
  const rows = annotateCanonicalEvaluations(evaluations);
  if (!options.includeAttempts) return rows;

  const attempts = await query(`
    SELECT
      cr.id AS run_id,
      cr.pipeline_invite_id,
      cr.status AS run_status,
      cr.stage,
      cr.run_type,
      cr.attempt_number,
      cr.previous_evaluation_id AS parent_evaluation_id,
      cr.started_at,
      cr.completed_at AS run_completed_at,
      cr.source_manifest,
      cr.source_coverage,
      cr.error_code AS run_error_code,
      cr.error_message AS run_error_message,
      pi.company_name,
      pi.deal_slug AS pipeline_deal_slug
    FROM council_runs cr
    JOIN pipeline_invites pi ON pi.id = cr.pipeline_invite_id
    WHERE cr.evaluation_id IS NULL
    ORDER BY cr.started_at DESC, cr.id DESC
  `);
  return [
    ...rows,
    ...attempts.map(attempt => ({
      ...attempt,
      record_type: 'attempt',
      is_canonical: false,
      canonical_evaluation_id: null,
    })),
  ];
}

export async function canonicalEvaluationsForInvite(inviteId, deps = {}) {
  const rows = await canonicalEvaluationLedger({}, deps);
  return rows.filter(row => Number(row.pipeline_invite_id) === Number(inviteId));
}
