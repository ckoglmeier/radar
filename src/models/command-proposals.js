import { query, withAtomicWrite, writeCapabilities } from '../db/index.js';
import { NORMALIZER_VERSION } from '../commands/canonical.js';
import { CommandError } from '../commands/errors.js';

const ORIGINS = new Set(['ask_radar', 'investment_update', 'mcp', 'api', 'manual_ui', 'import']);

function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function optionalText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function json(value) {
  return JSON.stringify(value);
}

export async function assertProposalWriteAvailable() {
  const capabilities = await writeCapabilities();
  if (capabilities.proposalApply !== 'transactional' || !capabilities.serializedWrites) {
    throw new CommandError(
      'COMMAND_WRITE_UNAVAILABLE',
      'Recording changes requires Radar Desktop.',
      capabilities,
    );
  }
  return capabilities;
}

export async function createCommandProposal(fields = {}) {
  await assertProposalWriteAvailable();
  const originSurface = requiredText(fields.originSurface, 'Origin surface');
  if (!ORIGINS.has(originSurface)) throw new TypeError(`invalid origin surface: ${originSurface}`);
  if (!Array.isArray(fields.commands) || fields.commands.length === 0) {
    throw new TypeError('Proposal requires at least one command');
  }
  if (!Array.isArray(fields.previews)) throw new TypeError('Proposal previews must be an array');
  const commandSetHash = requiredText(fields.commandSetHash, 'Command-set hash');
  const idempotencyKey = requiredText(fields.idempotencyKey, 'Idempotency key');

  const inserted = await query(`
    INSERT INTO command_proposals
      (schema_version, normalizer_version, registry_version, origin_surface,
       actor_type, actor_id, intent_text, source_document_id, source_update_id,
       commands, previews, command_set_hash, idempotency_key,
       supersedes_proposal_id, planner_provider, planner_model, planner_run_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING *
  `, [
    fields.schemaVersion || 1,
    fields.normalizerVersion || NORMALIZER_VERSION,
    requiredText(fields.registryVersion, 'Registry version'),
    originSurface,
    requiredText(fields.actorType, 'Actor type'),
    optionalText(fields.actorId),
    optionalText(fields.intentText),
    fields.sourceDocumentId || null,
    fields.sourceUpdateId || null,
    json(fields.commands),
    json(fields.previews),
    commandSetHash,
    idempotencyKey,
    fields.supersedesProposalId || null,
    optionalText(fields.plannerProvider),
    optionalText(fields.plannerModel),
    optionalText(fields.plannerRunKey),
  ]);
  if (inserted[0]) return { proposal: inserted[0], idempotent_replay: false };

  const [existing] = await query(`
    SELECT * FROM command_proposals WHERE idempotency_key = $1
  `, [idempotencyKey]);
  if (!existing || existing.command_set_hash !== commandSetHash) {
    throw new CommandError('PROPOSAL_IDEMPOTENCY_CONFLICT', 'Proposal idempotency key conflicts with another command set.');
  }
  return { proposal: existing, idempotent_replay: true };
}

export async function getCommandProposal(proposalId, { lock = false } = {}) {
  const [proposal] = await query(`
    SELECT * FROM command_proposals WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}
  `, [proposalId]);
  return proposal || null;
}

export async function listCommandProposals({ status = null, limit = 50 } = {}) {
  return query(`
    SELECT * FROM command_proposals
     WHERE ($1::text IS NULL OR status = $1)
     ORDER BY created_at DESC
     LIMIT $2
  `, [status, Math.max(1, Math.min(200, Number(limit) || 50))]);
}

async function transition(proposalId, expectedHash, status, fields = {}) {
  const [proposal] = await query(`
    UPDATE command_proposals
       SET status = $3,
           result = $4::jsonb,
           error_code = $5,
           error_message = $6,
           reviewed_by = $7,
           reviewed_at = $8,
           applied_at = $9
     WHERE id = $1 AND command_set_hash = $2 AND status = 'proposed'
     RETURNING *
  `, [
    proposalId,
    expectedHash,
    status,
    fields.result == null ? null : json(fields.result),
    optionalText(fields.errorCode),
    optionalText(fields.errorMessage),
    optionalText(fields.reviewedBy),
    fields.reviewedAt || null,
    fields.appliedAt || null,
  ]);
  return proposal || null;
}

export function markCommandProposalApplied(proposalId, expectedHash, fields) {
  const now = fields.reviewedAt || new Date();
  return transition(proposalId, expectedHash, 'applied', {
    result: fields.result,
    reviewedBy: requiredText(fields.reviewedBy, 'Reviewer'),
    reviewedAt: now,
    appliedAt: fields.appliedAt || now,
  });
}

export function rejectCommandProposal(proposalId, expectedHash, fields = {}) {
  return transition(proposalId, expectedHash, 'rejected', {
    reviewedBy: requiredText(fields.reviewedBy, 'Reviewer'),
    reviewedAt: fields.reviewedAt || new Date(),
    errorMessage: optionalText(fields.reason),
  });
}

export function markCommandProposalStale(proposalId, expectedHash, fields = {}) {
  return transition(proposalId, expectedHash, 'stale', {
    errorCode: fields.errorCode || 'PROPOSAL_STALE',
    errorMessage: fields.errorMessage || 'Proposal preconditions changed.',
  });
}

export function markCommandProposalFailed(proposalId, expectedHash, fields = {}) {
  return transition(proposalId, expectedHash, 'failed', {
    errorCode: requiredText(fields.errorCode, 'Error code'),
    errorMessage: optionalText(fields.errorMessage),
  });
}

export async function supersedeCommandProposal(proposalId, expectedHash, replacementFields) {
  return withAtomicWrite(async () => {
    const current = await getCommandProposal(proposalId, { lock: true });
    if (!current || current.status !== 'proposed' || current.command_set_hash !== expectedHash) {
      return { proposal: current, replacement: null };
    }
    const replacement = await createCommandProposal({
      ...replacementFields,
      supersedesProposalId: proposalId,
    });
    const proposal = await transition(proposalId, expectedHash, 'superseded');
    if (!proposal) throw new CommandError('PROPOSAL_CONCURRENT_TRANSITION', 'Proposal changed while it was being superseded.');
    return { proposal, replacement: replacement.proposal };
  });
}
