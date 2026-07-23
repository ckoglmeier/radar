// Pure data fetchers for pipeline reports. Thin wrappers over the model layer
// so the CLI and future web GUI consume one stable shape.

import { listInvites, getInviteBySlug, getEventsForInvite } from '../models/pipeline.js';
import { query } from '../db/index.js';

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

  const rows = await query(
    `SELECT
       pi.*,
       latest.id AS latest_eval_id,
       latest.eval_date AS latest_eval_date,
       latest.file_path AS latest_eval_file_path,
       latest.company_name AS latest_eval_company_name,
       latest.thesis_fit_score AS latest_eval_thesis_fit_score,
       latest.viability_score AS latest_eval_viability_score,
       latest.total_score AS latest_eval_total_score,
       latest.verdict AS latest_eval_verdict,
       latest.invested AS latest_eval_invested,
       latest.council_bull_score AS latest_eval_council_bull_score,
       latest.council_bear_score AS latest_eval_council_bear_score,
       latest.council_calibrator_score AS latest_eval_council_calibrator_score,
       latest.council_spread AS latest_eval_council_spread,
       latest.council_consensus AS latest_eval_council_consensus,
       latest.council_divergence AS latest_eval_council_divergence,
       latest.council_cfo_verdict AS latest_eval_council_cfo_verdict,
       latest.eval_mode AS latest_eval_mode,
       latest.council_policy AS latest_eval_council_policy,
       latest.council_policy_version AS latest_eval_council_policy_version,
       latest.council_instruction_hash AS latest_eval_council_instruction_hash,
       latest.council_lens_hash AS latest_eval_council_lens_hash,
       latest.council_calibration_hash AS latest_eval_council_calibration_hash,
       latest.council_input_hash AS latest_eval_council_input_hash,
       latest.council_artifact_hash AS latest_eval_council_artifact_hash,
       latest.council_session_id AS latest_eval_council_session_id,
       latest.council_model_policy AS latest_eval_council_model_policy,
       latest.council_score_adjusted AS latest_eval_council_score_adjusted,
       latest.created_at AS latest_eval_created_at
     FROM pipeline_invites pi
     LEFT JOIN LATERAL (
       SELECT de.*
       FROM deal_evaluations de
       WHERE de.pipeline_invite_id = pi.id
       -- A later evaluation date supersedes an earlier one. On the same date,
       -- the first completed run stays canonical; reruns remain history and
       -- never silently replace the score.
       ORDER BY de.eval_date DESC NULLS LAST, de.created_at ASC, de.id ASC
       LIMIT 1
     ) latest ON TRUE
     ${where}
     ORDER BY pi.email_received_at DESC NULLS LAST, pi.id DESC
     LIMIT $${params.length}`,
    params
  );

  return rows.map(row => {
    const latestEvaluation = row.latest_eval_id == null ? null : {
      id: row.latest_eval_id,
      pipeline_invite_id: row.id,
      eval_date: row.latest_eval_date,
      file_path: row.latest_eval_file_path,
      company_name: row.latest_eval_company_name,
      thesis_fit_score: row.latest_eval_thesis_fit_score,
      viability_score: row.latest_eval_viability_score,
      total_score: row.latest_eval_total_score,
      verdict: row.latest_eval_verdict,
      invested: row.latest_eval_invested,
      council_bull_score: row.latest_eval_council_bull_score,
      council_bear_score: row.latest_eval_council_bear_score,
      council_calibrator_score: row.latest_eval_council_calibrator_score,
      council_spread: row.latest_eval_council_spread,
      council_consensus: row.latest_eval_council_consensus,
      council_divergence: row.latest_eval_council_divergence,
      council_cfo_verdict: row.latest_eval_council_cfo_verdict,
      eval_mode: row.latest_eval_mode,
      council_policy: row.latest_eval_council_policy,
      council_policy_version: row.latest_eval_council_policy_version,
      council_instruction_hash: row.latest_eval_council_instruction_hash,
      council_lens_hash: row.latest_eval_council_lens_hash,
      council_calibration_hash: row.latest_eval_council_calibration_hash,
      council_input_hash: row.latest_eval_council_input_hash,
      council_artifact_hash: row.latest_eval_council_artifact_hash,
      council_session_id: row.latest_eval_council_session_id,
      council_model_policy: row.latest_eval_council_model_policy,
      council_score_adjusted: row.latest_eval_council_score_adjusted,
      created_at: row.latest_eval_created_at,
    };

    for (const key of Object.keys(row)) {
      if (key.startsWith('latest_eval_')) delete row[key];
    }
    row.latest_evaluation = latestEvaluation;
    return row;
  });
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
