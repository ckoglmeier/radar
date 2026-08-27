import { isPgliteActive, query, withAtomicWrite } from '../db/index.js';

const EVENT_TYPES = new Set([
  'partial_liquidity', 'full_exit', 'dissolution', 'write_off', 'abandonment',
]);
const REMAINING_INTEREST = new Set(['yes', 'no', 'unknown']);

function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}
function optionalText(value) {
  if (value == null || String(value).trim() === '') return null;
  return String(value).trim();
}

function isoDate(value, label) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new TypeError(`${label} must be an ISO date (YYYY-MM-DD)`);
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new TypeError(`${label} must be an ISO date (YYYY-MM-DD)`);
  }
  return date;
}

function enumValue(value, allowed, label) {
  if (!allowed.has(value)) throw new TypeError(`invalid ${label}: ${value}`);
  return value;
}

function dateOnly(value) {
  return value == null ? null : String(value instanceof Date ? value.toISOString() : value).slice(0, 10);
}

function comparable(row) {
  return {
    investmentId: Number(row.investment_id),
    date: dateOnly(row.event_date),
    eventType: row.event_type,
    remainingInterest: row.remaining_interest,
    cashFlowId: row.cash_flow_id == null ? null : Number(row.cash_flow_id),
    sourceDocumentId: row.source_document_id == null ? null : Number(row.source_document_id),
    evidenceNote: row.evidence_note || null,
  };
}

async function withLifecycleWrite(fn) {
  if (!(await isPgliteActive())) {
    throw new Error('Direct lifecycle writes require local PGlite transaction support');
  }
  return withAtomicWrite(fn);
}

async function directPosition(investmentId, { lock = false } = {}) {
  const [row] = await query(`
    SELECT id, company_name, asset_class, status, updated_at
      FROM investments WHERE id = $1
      ${lock ? 'FOR UPDATE' : ''}
  `, [investmentId]);
  if (!row) throw new Error(`investment not found: ${investmentId}`);
  if (row.asset_class !== 'direct') throw new Error('Direct lifecycle operation requires a Direct position');
  return row;
}

export async function getDirectLifecycleEvent(eventId, { lock = false } = {}) {
  const [row] = await query(`
    SELECT * FROM direct_position_lifecycle_events WHERE id = $1
    ${lock ? 'FOR UPDATE' : ''}
  `, [eventId]);
  return row || null;
}

export async function recordDirectLifecycleEvent(investmentId, fields = {}) {
  const date = isoDate(fields.date, 'Lifecycle event date');
  const eventType = enumValue(fields.eventType, EVENT_TYPES, 'lifecycle event type');
  const remainingInterest = enumValue(
    fields.remainingInterest,
    REMAINING_INTEREST,
    'remaining-interest state',
  );
  const idempotencyKey = requiredText(fields.idempotencyKey, 'Idempotency key');
  const normalized = {
    investmentId: Number(investmentId),
    date,
    eventType,
    remainingInterest,
    cashFlowId: fields.cashFlowId == null ? null : Number(fields.cashFlowId),
    sourceDocumentId: fields.sourceDocumentId == null ? null : Number(fields.sourceDocumentId),
    evidenceNote: optionalText(fields.evidenceNote),
  };
  if (!Number.isInteger(normalized.investmentId) || normalized.investmentId <= 0) {
    throw new TypeError('Investment ID must be a positive integer');
  }
  if (normalized.cashFlowId != null && (!Number.isInteger(normalized.cashFlowId) || normalized.cashFlowId <= 0)) {
    throw new TypeError('Cash-flow ID must be a positive integer');
  }
  if (normalized.sourceDocumentId != null && (!Number.isInteger(normalized.sourceDocumentId) || normalized.sourceDocumentId <= 0)) {
    throw new TypeError('Source-document ID must be a positive integer');
  }

  return withLifecycleWrite(async () => {
    await directPosition(normalized.investmentId, { lock: true });
    const [existing] = await query(`
      SELECT * FROM direct_position_lifecycle_events WHERE idempotency_key = $1
    `, [idempotencyKey]);
    if (existing) {
      if (JSON.stringify(comparable(existing)) !== JSON.stringify(normalized)) {
        throw new Error('Direct lifecycle idempotency key conflicts with another event');
      }
      return { event: existing, idempotent_replay: true };
    }
    const [event] = await query(`
      INSERT INTO direct_position_lifecycle_events
        (investment_id, event_date, event_type, remaining_interest, cash_flow_id,
         source_document_id, evidence_note, idempotency_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `, [
      normalized.investmentId,
      normalized.date,
      normalized.eventType,
      normalized.remainingInterest,
      normalized.cashFlowId,
      normalized.sourceDocumentId,
      normalized.evidenceNote,
      idempotencyKey,
    ]);
    return { event, idempotent_replay: false };
  });
}

export async function voidDirectLifecycleEvent(eventId, fields = {}) {
  const reason = requiredText(fields.reason, 'Void reason');
  const replacementEventId = fields.replacementEventId == null
    ? null
    : requiredText(fields.replacementEventId, 'Replacement event ID');
  return withLifecycleWrite(async () => {
    const event = await getDirectLifecycleEvent(eventId, { lock: true });
    if (!event) throw new Error(`Direct lifecycle event not found: ${eventId}`);
    await directPosition(event.investment_id, { lock: true });
    if (event.voided_at) {
      if ((event.void_reason || '') === reason && (event.replacement_event_id || null) === replacementEventId) {
        return { event, idempotent_replay: true };
      }
      throw new Error('Direct lifecycle event is already voided');
    }
    if (replacementEventId) {
      const replacement = await getDirectLifecycleEvent(replacementEventId, { lock: true });
      if (!replacement || Number(replacement.investment_id) !== Number(event.investment_id)) {
        throw new Error('Replacement lifecycle event must exist on the same Direct position');
      }
      if (replacement.voided_at) throw new Error('Replacement lifecycle event is voided');
    }
    const [voided] = await query(`
      UPDATE direct_position_lifecycle_events
         SET voided_at = NOW(), void_reason = $2, replacement_event_id = $3
       WHERE id = $1 AND voided_at IS NULL
       RETURNING *
    `, [eventId, reason, replacementEventId]);
    return { event: voided, idempotent_replay: false };
  });
}
