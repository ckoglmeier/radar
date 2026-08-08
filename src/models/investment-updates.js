// Source-backed updates shared by every investment type. Source documents are
// authoritative. Interpretation is derived and never applies portfolio facts.

import { query } from '../db/index.js';

const UPDATE_KINDS = new Set([
  'founder_update',
  'fund_update',
  'employment_disclosure',
  'valuation_update',
  'financial_update',
  'general',
]);
const PROCESSING_MODES = new Set(['store_only', 'interpret']);

function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function optionalText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function jsonArray(value) {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

export async function createInvestmentUpdate(fields = {}) {
  const investmentId = Number(fields.investmentId);
  const sourceDocumentId = Number(fields.sourceDocumentId);
  if (!Number.isInteger(investmentId) || investmentId <= 0) throw new Error('Investment is required');
  if (!Number.isInteger(sourceDocumentId) || sourceDocumentId <= 0) throw new Error('Source document is required');
  const updateKind = requiredText(fields.updateKind, 'Update kind');
  const processingMode = requiredText(fields.processingMode, 'Processing mode');
  if (!UPDATE_KINDS.has(updateKind)) throw new Error(`Invalid update kind: ${updateKind}`);
  if (!PROCESSING_MODES.has(processingMode)) throw new Error(`Invalid processing mode: ${processingMode}`);

  const [source] = await query(`
    SELECT d.id
      FROM documents d
      JOIN investments i ON i.id = $1
     WHERE d.id = $2
       AND d.entity_type = 'investment'
       AND d.entity_id = i.id::text
  `, [investmentId, sourceDocumentId]);
  if (!source) throw new Error('Source document must be attached to the same investment');

  const [existing] = await query(`SELECT * FROM investment_updates WHERE source_document_id = $1`, [sourceDocumentId]);
  if (existing) return { update: existing, idempotent_replay: true };

  let previousUpdateId = fields.previousUpdateId || null;
  if (!previousUpdateId) {
    const [previous] = await query(`
      SELECT id FROM investment_updates
       WHERE investment_id = $1 AND update_kind = $2
       ORDER BY received_date DESC, created_at DESC
       LIMIT 1
    `, [investmentId, updateKind]);
    previousUpdateId = previous?.id || null;
  }

  const [update] = await query(`
    INSERT INTO investment_updates
      (investment_id, source_document_id, previous_update_id, update_kind,
       title, received_date, processing_mode, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *
  `, [
    investmentId,
    sourceDocumentId,
    previousUpdateId,
    updateKind,
    optionalText(fields.title),
    fields.receivedDate,
    processingMode,
    processingMode === 'store_only' ? 'stored' : 'pending',
  ]);
  return { update, idempotent_replay: false };
}

export async function completeInvestmentUpdate(updateId, fields = {}) {
  const summary = requiredText(fields.summary, 'Update summary');
  const [update] = await query(`
    UPDATE investment_updates
       SET status = 'complete', summary = $2,
           observed_changes = $3::jsonb, proposed_facts = $4::jsonb,
           evaluation_signals = $5::jsonb, actions = $6::jsonb,
           model = $7, error_message = NULL, interpreted_at = NOW(), updated_at = NOW()
     WHERE id = $1
     RETURNING *
  `, [
    updateId,
    summary,
    jsonArray(fields.observedChanges),
    jsonArray(fields.proposedFacts),
    jsonArray(fields.evaluationSignals),
    jsonArray(fields.actions),
    optionalText(fields.model),
  ]);
  if (!update) throw new Error(`Investment update not found: ${updateId}`);
  return update;
}

export async function failInvestmentUpdate(updateId, errorMessage) {
  const [update] = await query(`
    UPDATE investment_updates
       SET status = 'failed', error_message = $2, interpreted_at = NOW(), updated_at = NOW()
     WHERE id = $1
     RETURNING *
  `, [updateId, requiredText(errorMessage, 'Interpretation error')]);
  if (!update) throw new Error(`Investment update not found: ${updateId}`);
  return update;
}

export async function retryInvestmentUpdate(updateId) {
  const [update] = await query(`
    UPDATE investment_updates
       SET status = 'pending', error_message = NULL, updated_at = NOW()
     WHERE id = $1 AND status = 'failed'
     RETURNING *
  `, [updateId]);
  if (!update) throw new Error(`Failed investment update not found: ${updateId}`);
  return update;
}

export async function getInvestmentUpdate(updateId) {
  const [update] = await query(`
    SELECT u.*, d.filename, d.mime, d.sha256, d.processing_policy,
           p.source_document_id AS previous_source_document_id,
           pd.filename AS previous_filename
      FROM investment_updates u
      JOIN documents d ON d.id = u.source_document_id
      LEFT JOIN investment_updates p ON p.id = u.previous_update_id
      LEFT JOIN documents pd ON pd.id = p.source_document_id
     WHERE u.id = $1
  `, [updateId]);
  return update || null;
}

export async function listInvestmentUpdates(investmentIds, { limit = 50 } = {}) {
  const ids = (Array.isArray(investmentIds) ? investmentIds : [investmentIds])
    .map(Number)
    .filter(id => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return [];
  return query(`
    SELECT u.*, d.filename, d.mime, d.sha256
      FROM investment_updates u
      JOIN documents d ON d.id = u.source_document_id
     WHERE u.investment_id = ANY($1::int[])
     ORDER BY u.received_date DESC, u.created_at DESC
     LIMIT $2
  `, [ids, limit]);
}
