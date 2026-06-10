// CRUD + change detection for the pipeline_invites / pipeline_events tables.
import { query } from '../db/index.js';
import { matchCompanyToInvestment } from '../utils/match.js';

// Fields we track for change detection. Keys are pipeline_invites columns,
// values come from the parsed invite object.
const TRACKED_FIELDS = [
  'company_name',
  'lead',
  'co_investors',
  'market',
  'round',
  'allocation_usd',
  'min_investment_usd',
  'carry_pct',
  'syndicate_investment_usd',
  'valuation_text',
  'valuation_usd',
  'gp_message',
  'dataroom_url',
  'detail_url',
  'status',
];

function normalizeValue(v) {
  if (v === undefined || v === null || v === '') return null;
  return v;
}

function valuesDiffer(a, b) {
  const na = normalizeValue(a);
  const nb = normalizeValue(b);
  if (na === null && nb === null) return false;
  if (na === null || nb === null) return true;
  // Numeric comparison tolerant to string/number representation from Postgres
  if (typeof na === 'number' || typeof nb === 'number') {
    return Number(na) !== Number(nb);
  }
  return String(na) !== String(nb);
}

// Upsert an invite. Returns { id, isNew, changes: [{ field, old, new }] }.
//
// Pass `{ universe }` (an array from `loadInvestmentUniverse()`) when batching
// to avoid a SELECT per match call.
export async function upsertInvite(parsed, { universe } = {}) {
  // Dedup primarily on gmail_message_id, fall back to deal_slug for non-email sources.
  let existing = null;
  if (parsed.gmail_message_id) {
    const rows = await query(
      `SELECT * FROM pipeline_invites WHERE gmail_message_id = $1 LIMIT 1`,
      [parsed.gmail_message_id]
    );
    existing = rows[0] || null;
  }
  if (!existing && parsed.deal_slug) {
    const rows = await query(
      `SELECT * FROM pipeline_invites WHERE deal_slug = $1 LIMIT 1`,
      [parsed.deal_slug]
    );
    existing = rows[0] || null;
  }

  if (existing) {
    // Detect changes on tracked fields
    const changes = [];
    for (const field of TRACKED_FIELDS) {
      if (valuesDiffer(existing[field], parsed[field])) {
        changes.push({
          field,
          old: existing[field],
          new: parsed[field] ?? null,
        });
      }
    }

    if (changes.length === 0) {
      // Just bump last_seen_at
      await query(
        `UPDATE pipeline_invites SET last_seen_at = NOW() WHERE id = $1`,
        [existing.id]
      );
      return { id: existing.id, isNew: false, changes: [] };
    }

    // Build dynamic UPDATE for changed fields
    const setClauses = [];
    const params = [];
    let i = 1;
    for (const c of changes) {
      setClauses.push(`${c.field} = $${i++}`);
      params.push(c.new);
    }
    setClauses.push(`last_seen_at = NOW()`);
    setClauses.push(`updated_at = NOW()`);
    params.push(existing.id);

    await query(
      `UPDATE pipeline_invites SET ${setClauses.join(', ')} WHERE id = $${i}`,
      params
    );

    // Emit a pipeline_events row per change
    for (const c of changes) {
      await logEvent(
        existing.id,
        c.field === 'status' ? 'status_change' : 'field_change',
        c.old != null ? String(c.old) : null,
        c.new != null ? String(c.new) : null,
        c.field === 'status' ? null : `field:${c.field}`
      );
    }

    return { id: existing.id, isNew: false, changes };
  }

  // New insert. Attempt to link to an existing investment via fuzzy match.
  const match = await matchCompanyToInvestment(parsed.company_name, { universe });
  const investment_id = match.confidence === 'exact' || match.confidence === 'token'
    ? match.investment_id
    : null;

  const rows = await query(
    `INSERT INTO pipeline_invites (
       gmail_message_id, email_received_at, source, deal_slug,
       company_name, lead, co_investors, market, round,
       allocation_usd, min_investment_usd, carry_pct, syndicate_investment_usd,
       valuation_text, valuation_usd, gp_message,
       dataroom_url, detail_url, status, investment_id
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8, $9,
       $10, $11, $12, $13,
       $14, $15, $16,
       $17, $18, $19, $20
     )
     RETURNING id`,
    [
      parsed.gmail_message_id || null,
      parsed.email_received_at || null,
      parsed.source || 'email',
      parsed.deal_slug || null,
      parsed.company_name,
      parsed.lead || null,
      parsed.co_investors || null,
      parsed.market || null,
      parsed.round || null,
      parsed.allocation_usd ?? null,
      parsed.min_investment_usd ?? null,
      parsed.carry_pct ?? null,
      parsed.syndicate_investment_usd ?? null,
      parsed.valuation_text || null,
      parsed.valuation_usd ?? null,
      parsed.gp_message || null,
      parsed.dataroom_url || null,
      parsed.detail_url || null,
      parsed.status || 'invite',
      investment_id,
    ]
  );

  const id = rows[0].id;
  await logEvent(id, 'invite_received', null, parsed.status || 'invite',
    investment_id ? `matched:investment_id=${investment_id} (${match.confidence})` : `match:${match.confidence}`);

  return { id, isNew: true, changes: [], match };
}

export async function logEvent(inviteId, eventType, oldValue, newValue, notes) {
  await query(
    `INSERT INTO pipeline_events (invite_id, event_type, old_value, new_value, notes)
     VALUES ($1, $2, $3, $4, $5)`,
    [inviteId, eventType, oldValue, newValue, notes || null]
  );
}

export async function listInvites({ status, limit = 100 } = {}) {
  if (status) {
    return query(
      `SELECT * FROM pipeline_invites WHERE status = $1
       ORDER BY email_received_at DESC NULLS LAST, id DESC LIMIT $2`,
      [status, limit]
    );
  }
  return query(
    `SELECT * FROM pipeline_invites
     ORDER BY email_received_at DESC NULLS LAST, id DESC LIMIT $1`,
    [limit]
  );
}

export async function getInviteBySlug(slug) {
  const rows = await query(
    `SELECT * FROM pipeline_invites WHERE deal_slug = $1 LIMIT 1`,
    [slug]
  );
  return rows[0] || null;
}

export async function getEventsForInvite(inviteId) {
  return query(
    `SELECT * FROM pipeline_events WHERE invite_id = $1 ORDER BY event_date ASC, id ASC`,
    [inviteId]
  );
}

/**
 * Manually link a pipeline invite to an investment by ID.
 * Returns true if updated, false if invite not found.
 */
export async function linkInviteToInvestment(inviteId, investmentId) {
  const rows = await query(
    `UPDATE pipeline_invites SET investment_id = $1, updated_at = NOW() WHERE id = $2 RETURNING id`,
    [investmentId, inviteId]
  );
  if (rows.length === 0) return false;
  await logEvent(inviteId, 'manual_link', null, String(investmentId), 'manual link via reconcile command');
  return true;
}

export async function setInviteStatus(inviteId, newStatus, notes) {
  const rows = await query(
    `SELECT status FROM pipeline_invites WHERE id = $1`,
    [inviteId]
  );
  if (rows.length === 0) return false;
  const oldStatus = rows[0].status;
  if (oldStatus === newStatus) return false;
  await query(
    `UPDATE pipeline_invites SET status = $1, updated_at = NOW() WHERE id = $2`,
    [newStatus, inviteId]
  );
  await logEvent(inviteId, 'status_change', oldStatus, newStatus, notes);
  return true;
}
