// Pure data fetchers for pipeline reports. Thin wrappers over the model layer
// so the CLI and future web GUI consume one stable shape.

import { listInvites, getInviteBySlug, getEventsForInvite } from '../models/pipeline.js';
import { query } from '../db/index.js';
import { canonicalEvaluationLedger } from '../models/canonical-evaluations.js';

export async function pipelineList({ status, limit } = {}) {
  return listInvites({ status, limit });
}

/**
 * Pipeline rows with their latest explicitly-linked evaluation.
 *
 * The foreign key is the only join condition. Company names and file paths
 * are intentionally not consulted here: fuzzy matches are repair hints, not
 * evidence that an evaluation belongs to a deal.
 */
export async function pipelineListWithLatestEval({ status, limit = 100 } = {}) {
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = `WHERE pi.status = $${params.length}`;
  }
  params.push(limit);

  const [rows, evaluations] = await Promise.all([
    query(
      `SELECT pi.*
       FROM pipeline_invites pi
       ${where}
       ORDER BY pi.email_received_at DESC NULLS LAST, pi.id DESC
       LIMIT $${params.length}`,
      params,
    ),
    canonicalEvaluationLedger(),
  ]);
  const currentByInvite = new Map(
    evaluations
      .filter(row => row.is_canonical && row.pipeline_invite_id != null)
      .map(row => [Number(row.pipeline_invite_id), row]),
  );
  return rows.map(row => ({
    ...row,
    latest_evaluation: currentByInvite.get(Number(row.id)) || null,
  }));
}

export async function pipelineDetail(slug) {
  return getInviteBySlug(slug);
}

export async function pipelineEvents(slug) {
  const invite = await getInviteBySlug(slug);
  if (!invite) return { invite: null, events: [] };
  const events = await getEventsForInvite(invite.id);
  return { invite, events };
}
