import { randomUUID } from 'node:crypto';
import { query } from '../db/index.js';
import { CommandError } from '../commands/errors.js';
import { assertDate, buildReport, GivingError } from '../giving/report.js';
import { assertRequestTransition, pledgeOutstanding, requestPaymentState } from '../giving/lifecycle.js';
import { forwardPlan, validateBudget } from '../giving/budget.js';
import { groupLikelySameGift, suggestGiftMatches, normalizeEin } from '../giving/matching.js';
import { lensHash, sameLens, validateLens } from '../giving/lens.js';
import { canonicalJson, snapshotHash } from '../angel/personal-context.js';
import { dateOnly } from '../utils/date-only.js';

// Giving persistence. Every function takes a workspaceId and filters by it; a row in
// another workspace is indistinguishable from a missing one. Paid money lives only in
// giving_gifts; requests and pledges never count as paid.

export const DEFAULT_WORKSPACE_ID = 'local';

function ws(workspaceId) {
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) throw new CommandError('WORKSPACE_REQUIRED', 'A workspace is required.');
  return workspaceId;
}
const json = value => (typeof value === 'string' ? JSON.parse(value) : value);
const num = value => (value == null ? null : Number(value));
// DATE columns arrive at local midnight; dateOnly never shifts them a day (see utils/date-only.js).
const day = dateOnly;
const id = () => randomUUID();
const invalid = (message, field) => new CommandError('PRECONDITION_FAILED', message, field ? { field } : undefined);

export function givingProblem(error) {
  if (error instanceof GivingError) return invalid(error.message, error.field);
  return error;
}

function cents(value, field, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw invalid(`${field} must be a positive amount in cents.`, field);
  return value;
}
function optionalDate(value, field) {
  if (value == null) return null;
  try { return assertDate(value, field); } catch (error) { throw givingProblem(error); }
}
const optionalText = (value, max = 300) => (value == null || String(value).trim() === '' ? null : String(value).trim().slice(0, max));

async function transition(workspaceId, subjectType, subjectId, action, { from = null, to = null, detail = {} } = {}) {
  await query(`
    INSERT INTO giving_transitions (id, workspace_id, subject_type, subject_id, action, from_status, to_status, detail)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
  `, [id(), workspaceId, subjectType, subjectId, action, from, to, JSON.stringify(detail)]);
}

// ── Rows ───────────────────────────────────────────────────────────────

const orgRow = row => row && ({ ...row, aliases: json(row.aliases), registry_snapshot: row.registry_snapshot == null ? null : json(row.registry_snapshot) });
const giftRow = row => row && ({
  ...row, amount_cents: num(row.amount_cents), paid_on: day(row.paid_on), refunded_cents: num(row.refunded_cents) || 0,
  voided: row.voided_at != null,
});
const requestRow = row => row && ({ ...row, requested_cents: num(row.requested_cents), decided_cents: num(row.decided_cents), deadline: day(row.deadline) });
const pledgeRow = row => row && ({ ...row, total_cents: num(row.total_cents), pledged_on: day(row.pledged_on) });
const itemRow = row => row && ({ ...row, seq: num(row.seq), proposed: json(row.proposed), issues: json(row.issues) });
const sourceRow = row => row && ({ ...row, seq: num(row.seq), metadata: json(row.metadata) });
const budgetRow = row => row && ({ ...row, version: num(row.version), amount_cents: num(row.amount_cents), starts_on: day(row.starts_on), ends_on: day(row.ends_on), planned: json(row.planned) });
const snapshotRow = row => row && ({ ...row, seq: num(row.seq), as_of: day(row.as_of), payload: json(row.payload) });

// ── Members and organizations ──────────────────────────────────────────

export async function ensureMember({ workspaceId, displayName }) {
  const workspace = ws(workspaceId);
  const name = optionalText(displayName, 80);
  if (!name) throw invalid('A household member name is required.', 'member');
  const [existing] = await query('SELECT * FROM giving_household_members WHERE workspace_id = $1 AND display_name = $2', [workspace, name]);
  if (existing) return existing;
  const [row] = await query('INSERT INTO giving_household_members (id, workspace_id, display_name) VALUES ($1, $2, $3) RETURNING *', [id(), workspace, name]);
  return row;
}

export async function listMembers({ workspaceId }) {
  return query('SELECT * FROM giving_household_members WHERE workspace_id = $1 ORDER BY display_name', [ws(workspaceId)]);
}

export async function getOrganization({ workspaceId, organizationId }) {
  const [row] = await query('SELECT * FROM giving_organizations WHERE id = $1 AND workspace_id = $2', [String(organizationId), ws(workspaceId)]);
  return orgRow(row);
}

export async function listOrganizations({ workspaceId }) {
  return (await query('SELECT * FROM giving_organizations WHERE workspace_id = $1 ORDER BY name', [ws(workspaceId)])).map(orgRow);
}

// Creates an organization, or returns the existing one with the same EIN. Names alone never merge.
export async function saveOrganization({ workspaceId, organizationId = null, name, ein = null, website = null, registrySnapshot = null }) {
  const workspace = ws(workspaceId);
  const cleanName = optionalText(name, 300);
  if (!cleanName) throw invalid('Organization name is required.', 'name');
  const cleanEin = ein == null || ein === '' ? null : normalizeEin(ein);
  if (ein && !cleanEin) throw invalid('EIN must have nine digits.', 'ein');
  if (organizationId) {
    const current = await getOrganization({ workspaceId: workspace, organizationId });
    if (!current) throw new CommandError('TARGET_NOT_FOUND', 'Organization not found.');
    const aliases = current.name !== cleanName && !current.aliases.includes(current.name) ? [...current.aliases, current.name] : current.aliases;
    const [row] = await query(`
      UPDATE giving_organizations SET name = $3, ein = COALESCE($4, ein), website = COALESCE($5, website), aliases = $6::jsonb,
        registry_snapshot = COALESCE($7::jsonb, registry_snapshot),
        registry_checked_at = CASE WHEN $7::jsonb IS NULL THEN registry_checked_at ELSE NOW() END, updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2 RETURNING *
    `, [current.id, workspace, cleanName, cleanEin, optionalText(website), JSON.stringify(aliases), registrySnapshot ? JSON.stringify(registrySnapshot) : null]);
    await transition(workspace, 'organization', current.id, 'updated', { detail: { name: cleanName, ein: cleanEin } });
    return orgRow(row);
  }
  if (cleanEin) {
    const [existing] = await query('SELECT * FROM giving_organizations WHERE workspace_id = $1 AND ein = $2', [workspace, cleanEin]);
    if (existing) return orgRow(existing);
  }
  const [row] = await query(`
    INSERT INTO giving_organizations (id, workspace_id, name, ein, website, registry_snapshot, registry_checked_at)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, CASE WHEN $6::jsonb IS NULL THEN NULL ELSE NOW() END) RETURNING *
  `, [id(), workspace, cleanName, cleanEin, optionalText(website), registrySnapshot ? JSON.stringify(registrySnapshot) : null]);
  await transition(workspace, 'organization', row.id, 'created', { detail: { name: cleanName, ein: cleanEin } });
  return orgRow(row);
}

async function resolveOrganization(workspaceId, organization) {
  if (!organization) throw invalid('Choose or add the organization.', 'organization');
  if (organization.id) {
    const found = await getOrganization({ workspaceId, organizationId: organization.id });
    if (!found) throw new CommandError('TARGET_NOT_FOUND', 'Organization not found.');
    return found;
  }
  return saveOrganization({ workspaceId, name: organization.name, ein: organization.ein, website: organization.website });
}

async function memberId(workspaceId, value) {
  if (value == null) return null;
  const [row] = await query('SELECT id FROM giving_household_members WHERE id = $1 AND workspace_id = $2', [value, workspaceId]);
  if (!row) throw new CommandError('TARGET_NOT_FOUND', 'Household member not found.');
  return row.id;
}

// ── Sources and proposed items ─────────────────────────────────────────

// source: {kind, label, member_display_name, metadata, file_name, file_sha256}
// items: [{external_key, kind, excerpt, proposed, issues}] (from parseGivingImport or upload extraction)
// Items whose external_key is already known are skipped, so re-imports never multiply records.
export async function importSource({ workspaceId, source, items }) {
  const workspace = ws(workspaceId);
  const member = source.member_display_name ? await ensureMember({ workspaceId: workspace, displayName: source.member_display_name }) : null;
  const keys = items.map(item => item.external_key);
  const known = new Set(keys.length
    ? (await query('SELECT external_key FROM giving_source_items WHERE workspace_id = $1 AND external_key = ANY($2::text[])', [workspace, keys])).map(row => row.external_key)
    : []);
  const fresh = items.filter(item => !known.has(item.external_key));
  // Nothing new: no empty source row for a file or scan that was already imported.
  if (!fresh.length) return { source: null, added: 0, skipped: items.length };
  const [sourceRecord] = await query(`
    INSERT INTO giving_sources (id, workspace_id, member_id, kind, label, file_name, file_sha256, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING *
  `, [id(), workspace, member?.id || null, source.kind, optionalText(source.label, 300) || 'Import', source.file_name || null, source.file_sha256 || null,
    JSON.stringify({ ...(source.metadata || {}), skipped_known_items: items.length - fresh.length })]);
  for (const item of fresh) {
    await query(`
      INSERT INTO giving_source_items (id, workspace_id, source_id, external_key, kind, excerpt, proposed, issues)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
    `, [id(), workspace, sourceRecord.id, item.external_key, item.kind, item.excerpt, JSON.stringify(item.proposed), JSON.stringify(item.issues || [])]);
  }
  await transition(workspace, 'source', sourceRecord.id, 'imported', { detail: { kind: source.kind, added: fresh.length, skipped: items.length - fresh.length } });
  return { source: sourceRow(sourceRecord), added: fresh.length, skipped: items.length - fresh.length };
}

export async function listSources({ workspaceId }) {
  return (await query(`
    SELECT s.*, m.display_name AS member_name,
      (SELECT COUNT(*)::int FROM giving_source_items i WHERE i.source_id = s.id) AS item_count,
      (SELECT COUNT(*)::int FROM giving_source_items i WHERE i.source_id = s.id AND i.status = 'proposed') AS pending_count
      FROM giving_sources s LEFT JOIN giving_household_members m ON m.id = s.member_id
     WHERE s.workspace_id = $1 ORDER BY s.seq DESC
  `, [ws(workspaceId)])).map(sourceRow);
}

export async function getSource({ workspaceId, sourceId }) {
  const [row] = await query('SELECT * FROM giving_sources WHERE id = $1 AND workspace_id = $2', [String(sourceId), ws(workspaceId)]);
  return sourceRow(row);
}

// Proposals with live review aids: possible matching gifts (computed now, so a gift confirmed
// after import is still suggested) and sibling proposals that probably describe the same gift.
export async function listItems({ workspaceId, status = null, sourceId = null }) {
  const workspace = ws(workspaceId);
  const items = (await query(`
    SELECT * FROM giving_source_items
     WHERE workspace_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR source_id = $3)
     ORDER BY seq
  `, [workspace, status, sourceId])).map(itemRow);
  const pending = items.filter(item => item.status === 'proposed');
  if (!pending.length) return items;
  const gifts = await giftsWithOrgs(workspace);
  const facts = item => ({
    id: item.id, kind: item.kind, organization_name: item.proposed.organization?.name, ein: item.proposed.organization?.ein,
    amount_cents: item.proposed.amount?.cents ?? null, date: item.proposed.date?.value ?? null,
  });
  const siblings = new Map();
  for (const group of groupLikelySameGift(pending.map(facts))) for (const itemId of group) siblings.set(itemId, group.filter(other => other !== itemId));
  return items.map(item => (item.status !== 'proposed' ? item : {
    ...item,
    suggested_gifts: suggestGiftMatches(facts(item), gifts),
    likely_same_gift_as: siblings.get(item.id) || [],
  }));
}

export async function getItem({ workspaceId, itemId }) {
  const [row] = await query('SELECT * FROM giving_source_items WHERE id = $1 AND workspace_id = $2', [String(itemId), ws(workspaceId)]);
  return itemRow(row);
}

// Removing a source withdraws its undecided proposals. Confirmed records are never deleted
// silently: records whose only evidence came from this source are returned for review.
export async function removeSource({ workspaceId, sourceId }) {
  const workspace = ws(workspaceId);
  const source = await getSource({ workspaceId: workspace, sourceId });
  if (!source) throw new CommandError('TARGET_NOT_FOUND', 'Source not found.');
  if (source.removed_at) throw invalid('This source was already removed.');
  await query('UPDATE giving_sources SET removed_at = NOW() WHERE id = $1', [source.id]);
  const withdrawn = await query(`UPDATE giving_source_items SET status = 'withdrawn', decided_at = NOW() WHERE source_id = $1 AND status = 'proposed' RETURNING id`, [source.id]);
  const orphaned = await query(`
    SELECT DISTINCT i.gift_id FROM giving_source_items i
     WHERE i.source_id = $1 AND i.gift_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM giving_source_items other JOIN giving_sources os ON os.id = other.source_id
          WHERE other.gift_id = i.gift_id AND other.source_id <> $1 AND os.removed_at IS NULL)
  `, [source.id]);
  await transition(workspace, 'source', source.id, 'removed', { detail: { withdrawn: withdrawn.length, records_needing_review: orphaned.length } });
  return { source_id: source.id, withdrawn: withdrawn.length, gifts_needing_review: orphaned.map(row => row.gift_id) };
}

// ── Gifts, refunds, DAF contributions ──────────────────────────────────

async function giftsWithOrgs(workspaceId) {
  return (await query(`
    SELECT g.*, o.name AS organization_name, o.ein,
      COALESCE((SELECT SUM(r.amount_cents) FROM giving_refunds r WHERE r.gift_id = g.id), 0) AS refunded_cents
      FROM giving_gifts g JOIN giving_organizations o ON o.id = g.organization_id
     WHERE g.workspace_id = $1 ORDER BY g.paid_on NULLS LAST, g.confirmed_at
  `, [workspaceId])).map(giftRow);
}

export async function listGifts({ workspaceId }) {
  return giftsWithOrgs(ws(workspaceId));
}

export async function getGift({ workspaceId, giftId }) {
  const [row] = await query(`
    SELECT g.*, COALESCE((SELECT SUM(r.amount_cents) FROM giving_refunds r WHERE r.gift_id = g.id), 0) AS refunded_cents
      FROM giving_gifts g WHERE g.id = $1 AND g.workspace_id = $2
  `, [String(giftId), ws(workspaceId)]);
  return giftRow(row);
}

const VEHICLES = ['direct', 'daf_grant', 'employer_match', 'unknown'];

export async function createGift({ workspaceId, organization, gift }) {
  const workspace = ws(workspaceId);
  const org = await resolveOrganization(workspace, organization);
  const vehicle = gift.vehicle || 'unknown';
  if (!VEHICLES.includes(vehicle)) throw invalid(`Unknown giving vehicle: ${vehicle}`, 'vehicle');
  let pledgeId = gift.pledge_id || null;
  let requestId = gift.request_id || null;
  let purpose = optionalText(gift.purpose);
  if (requestId) {
    const request = await getRequest({ workspaceId: workspace, requestId });
    if (!request) throw new CommandError('TARGET_NOT_FOUND', 'Request not found.');
    if (!['approved', 'pledged'].includes(request.status)) throw invalid('Only an approved or pledged request can receive a payment.');
    if (request.organization_id !== org.id) throw invalid('The payment organization does not match the request.');
    // Snapshot the approved request's purpose when the payment has no override.
    // Subsequent request edits must not rewrite the paid gift's history.
    purpose = purpose || optionalText(request.purpose);
    if (!pledgeId && request.status === 'pledged') pledgeId = (await query('SELECT id FROM giving_pledges WHERE request_id = $1', [request.id]))[0]?.id || null;
  }
  if (pledgeId) {
    const pledge = await getPledge({ workspaceId: workspace, pledgeId });
    if (!pledge) throw new CommandError('TARGET_NOT_FOUND', 'Pledge not found.');
    if (pledge.organization_id !== org.id) throw invalid('The payment organization does not match the pledge.');
    purpose = purpose || optionalText(pledge.purpose);
    requestId = requestId || pledge.request_id || null;
  }
  const [row] = await query(`
    INSERT INTO giving_gifts (id, workspace_id, organization_id, member_id, purpose, restriction, amount_cents, currency, paid_on, vehicle, daf_provider, pledge_id, request_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *
  `, [id(), workspace, org.id, await memberId(workspace, gift.member_id), purpose, optionalText(gift.restriction),
    cents(gift.amount_cents, 'amount_cents'), gift.currency || 'USD', optionalDate(gift.paid_on, 'paid_on'), vehicle,
    vehicle === 'daf_grant' ? optionalText(gift.daf_provider, 80) || 'Daffy' : null, pledgeId, requestId]);
  await transition(workspace, 'gift', row.id, 'confirmed_paid', { to: 'paid', detail: { amount_cents: num(row.amount_cents), paid_on: day(row.paid_on), request_id: requestId, pledge_id: pledgeId } });
  return giftRow({ ...row, refunded_cents: 0 });
}

const CORRECTABLE = ['purpose', 'restriction', 'amount_cents', 'paid_on', 'vehicle', 'member_id', 'organization_id'];

export async function correctGift({ workspaceId, giftId, changes }) {
  const workspace = ws(workspaceId);
  const current = await getGift({ workspaceId: workspace, giftId });
  if (!current) throw new CommandError('TARGET_NOT_FOUND', 'Gift not found.');
  if (current.voided) throw invalid('A voided gift cannot be corrected.');
  const next = { ...current };
  for (const [key, value] of Object.entries(changes || {})) {
    if (!CORRECTABLE.includes(key)) throw invalid(`${key} cannot be corrected here.`, key);
    next[key] = value;
  }
  cents(next.amount_cents, 'amount_cents');
  if (next.amount_cents < current.refunded_cents) throw invalid('The amount cannot be less than what was already refunded.', 'amount_cents');
  optionalDate(next.paid_on, 'paid_on');
  if (!VEHICLES.includes(next.vehicle)) throw invalid(`Unknown giving vehicle: ${next.vehicle}`, 'vehicle');
  if (next.organization_id !== current.organization_id && !(await getOrganization({ workspaceId: workspace, organizationId: next.organization_id }))) {
    throw new CommandError('TARGET_NOT_FOUND', 'Organization not found.');
  }
  const [row] = await query(`
    UPDATE giving_gifts SET purpose = $3, restriction = $4, amount_cents = $5, paid_on = $6, vehicle = $7, member_id = $8, organization_id = $9, updated_at = NOW()
     WHERE id = $1 AND workspace_id = $2 RETURNING *
  `, [current.id, workspace, optionalText(next.purpose), optionalText(next.restriction), next.amount_cents, next.paid_on, next.vehicle,
    await memberId(workspace, next.member_id), next.organization_id]);
  const before = Object.fromEntries(Object.keys(changes).map(key => [key, current[key]]));
  await transition(workspace, 'gift', current.id, 'corrected', { detail: { before, after: changes } });
  return giftRow({ ...row, refunded_cents: current.refunded_cents });
}

export async function voidGift({ workspaceId, giftId, reason }) {
  const workspace = ws(workspaceId);
  const current = await getGift({ workspaceId: workspace, giftId });
  if (!current) throw new CommandError('TARGET_NOT_FOUND', 'Gift not found.');
  if (current.voided) throw invalid('This gift was already voided.');
  const why = optionalText(reason, 300);
  if (!why) throw invalid('Say why this gift is being voided.', 'reason');
  const [row] = await query('UPDATE giving_gifts SET voided_at = NOW(), void_reason = $3, updated_at = NOW() WHERE id = $1 AND workspace_id = $2 RETURNING *', [current.id, workspace, why]);
  await transition(workspace, 'gift', current.id, 'voided', { from: 'paid', to: 'voided', detail: { reason: why } });
  return giftRow({ ...row, refunded_cents: current.refunded_cents });
}

export async function addRefund({ workspaceId, giftId, amountCents, refundedOn = null }) {
  const workspace = ws(workspaceId);
  const gift = await getGift({ workspaceId: workspace, giftId });
  if (!gift) throw new CommandError('TARGET_NOT_FOUND', 'Gift not found.');
  if (gift.voided) throw invalid('A voided gift cannot be refunded.');
  cents(amountCents, 'amount_cents');
  if (gift.refunded_cents + amountCents > gift.amount_cents) throw invalid('Refunds cannot exceed the original gift.', 'amount_cents');
  const [row] = await query(`
    INSERT INTO giving_refunds (id, workspace_id, gift_id, amount_cents, refunded_on) VALUES ($1, $2, $3, $4, $5) RETURNING *
  `, [id(), workspace, gift.id, amountCents, optionalDate(refundedOn, 'refunded_on')]);
  await transition(workspace, 'refund', row.id, 'recorded', { detail: { gift_id: gift.id, amount_cents: amountCents } });
  return { ...row, amount_cents: num(row.amount_cents), refunded_on: day(row.refunded_on) };
}

export async function addDafContribution({ workspaceId, provider = 'Daffy', amountCents, contributedOn = null, memberId: member = null }) {
  const workspace = ws(workspaceId);
  const [row] = await query(`
    INSERT INTO giving_daf_contributions (id, workspace_id, member_id, provider, amount_cents, contributed_on) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
  `, [id(), workspace, await memberId(workspace, member), optionalText(provider, 80) || 'Daffy', cents(amountCents, 'amount_cents'), optionalDate(contributedOn, 'contributed_on')]);
  await transition(workspace, 'daf_contribution', row.id, 'recorded', { detail: { amount_cents: amountCents } });
  return { ...row, amount_cents: num(row.amount_cents), contributed_on: day(row.contributed_on) };
}

export async function listDafContributions({ workspaceId }) {
  return (await query('SELECT * FROM giving_daf_contributions WHERE workspace_id = $1 AND voided_at IS NULL ORDER BY contributed_on NULLS LAST', [ws(workspaceId)]))
    .map(row => ({ ...row, amount_cents: num(row.amount_cents), contributed_on: day(row.contributed_on) }));
}

// ── Requests and pledges ───────────────────────────────────────────────

export async function getRequest({ workspaceId, requestId }) {
  const [row] = await query('SELECT * FROM giving_requests WHERE id = $1 AND workspace_id = $2', [String(requestId), ws(workspaceId)]);
  return requestRow(row);
}

export async function getPledge({ workspaceId, pledgeId }) {
  const [row] = await query('SELECT * FROM giving_pledges WHERE id = $1 AND workspace_id = $2', [String(pledgeId), ws(workspaceId)]);
  return pledgeRow(row);
}

export async function createRequest({ workspaceId, organization, request }) {
  const workspace = ws(workspaceId);
  const org = await resolveOrganization(workspace, organization);
  if (request.requested_cents != null) cents(request.requested_cents, 'requested_cents');
  const [row] = await query(`
    INSERT INTO giving_requests (id, workspace_id, organization_id, member_id, purpose, requested_cents, deadline)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
  `, [id(), workspace, org.id, await memberId(workspace, request.member_id), optionalText(request.purpose), request.requested_cents ?? null, optionalDate(request.deadline, 'deadline')]);
  await transition(workspace, 'request', row.id, 'created', { to: 'requested', detail: { requested_cents: num(row.requested_cents) } });
  return requestRow(row);
}

// Moves a request through an explicit decision. approved/pledged need a decided amount;
// pledged also creates the commitment. Nothing here records money as paid.
export async function decideRequest({ workspaceId, requestId, status, decidedCents = null, rationale = null, pledge = null }) {
  const workspace = ws(workspaceId);
  const current = await getRequest({ workspaceId: workspace, requestId });
  if (!current) throw new CommandError('TARGET_NOT_FOUND', 'Request not found.');
  try { assertRequestTransition(current.status, status); } catch (error) { throw givingProblem(error); }
  const amount = ['approved', 'pledged'].includes(status) ? cents(decidedCents ?? current.decided_cents, 'decided_cents') : (decidedCents ?? current.decided_cents);
  const [row] = await query(`
    UPDATE giving_requests SET status = $3, decided_cents = $4, rationale = COALESCE($5, rationale), updated_at = NOW()
     WHERE id = $1 AND workspace_id = $2 RETURNING *
  `, [current.id, workspace, status, amount ?? null, optionalText(rationale, 4000)]);
  let pledgeRecord = null;
  if (status === 'pledged') {
    const [created] = await query(`
      INSERT INTO giving_pledges (id, workspace_id, organization_id, member_id, request_id, purpose, total_cents, pledged_on, schedule_text)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
    `, [id(), workspace, current.organization_id, current.member_id, current.id, current.purpose, amount,
      optionalDate(pledge?.pledged_on, 'pledged_on'), optionalText(pledge?.schedule_text)]);
    pledgeRecord = pledgeRow(created);
    await transition(workspace, 'pledge', created.id, 'created', { to: 'active', detail: { request_id: current.id, total_cents: amount } });
  }
  if (status === 'cancelled') {
    await query(`UPDATE giving_pledges SET status = 'cancelled', updated_at = NOW() WHERE request_id = $1 AND status = 'active'`, [current.id]);
  }
  await transition(workspace, 'request', current.id, 'decided', { from: current.status, to: status, detail: { decided_cents: amount ?? null, rationale: optionalText(rationale, 4000) } });
  return { ...requestRow(row), pledge: pledgeRecord };
}

export async function createPledge({ workspaceId, organization, pledge }) {
  const workspace = ws(workspaceId);
  const org = await resolveOrganization(workspace, organization);
  const [row] = await query(`
    INSERT INTO giving_pledges (id, workspace_id, organization_id, member_id, purpose, restriction, total_cents, pledged_on, schedule_text)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
  `, [id(), workspace, org.id, await memberId(workspace, pledge.member_id), optionalText(pledge.purpose), optionalText(pledge.restriction),
    cents(pledge.total_cents, 'total_cents'), optionalDate(pledge.pledged_on, 'pledged_on'), optionalText(pledge.schedule_text)]);
  await transition(workspace, 'pledge', row.id, 'created', { to: 'active', detail: { total_cents: num(row.total_cents) } });
  return pledgeRow(row);
}

export async function listRequests({ workspaceId }) {
  const workspace = ws(workspaceId);
  const gifts = await giftsWithOrgs(workspace);
  return (await query(`
    SELECT r.*, o.name AS organization_name FROM giving_requests r JOIN giving_organizations o ON o.id = r.organization_id
     WHERE r.workspace_id = $1 ORDER BY r.updated_at DESC
  `, [workspace])).map(row => {
    const request = requestRow(row);
    return { ...request, payment: requestPaymentState(request, gifts.filter(gift => gift.request_id === request.id)) };
  });
}

export async function listPledges({ workspaceId }) {
  const workspace = ws(workspaceId);
  const gifts = await giftsWithOrgs(workspace);
  return (await query(`
    SELECT p.*, o.name AS organization_name FROM giving_pledges p JOIN giving_organizations o ON o.id = p.organization_id
     WHERE p.workspace_id = $1 ORDER BY p.created_at
  `, [workspace])).map(row => {
    const pledge = pledgeRow(row);
    return { ...pledge, ...pledgeOutstanding(pledge, gifts.filter(gift => gift.pledge_id === pledge.id)) };
  });
}

// ── Confirming proposed items ──────────────────────────────────────────

// decision.action: gift | evidence_of_gift | refund | daf_contribution | pledge | request | reject
export async function confirmItem({ workspaceId, itemId, decision }) {
  const workspace = ws(workspaceId);
  const item = await getItem({ workspaceId: workspace, itemId });
  if (!item) throw new CommandError('TARGET_NOT_FOUND', 'Proposed item not found.');
  if (item.status !== 'proposed') throw invalid(`This item was already ${item.status}.`);
  const links = { status: 'confirmed', organization_id: null, gift_id: null, refund_id: null, pledge_id: null, request_id: null, daf_contribution_id: null };
  const action = decision?.action;
  if (action === 'gift') {
    const gift = await createGift({ workspaceId: workspace, organization: decision.organization, gift: decision.gift });
    Object.assign(links, { organization_id: gift.organization_id, gift_id: gift.id });
  } else if (action === 'evidence_of_gift') {
    const gift = await getGift({ workspaceId: workspace, giftId: decision.gift_id });
    if (!gift) throw new CommandError('TARGET_NOT_FOUND', 'Gift not found.');
    Object.assign(links, { status: 'duplicate', organization_id: gift.organization_id, gift_id: gift.id });
  } else if (action === 'refund') {
    const refund = await addRefund({ workspaceId: workspace, giftId: decision.gift_id, amountCents: decision.amount_cents, refundedOn: decision.refunded_on });
    const gift = await getGift({ workspaceId: workspace, giftId: decision.gift_id });
    Object.assign(links, { organization_id: gift.organization_id, refund_id: refund.id });
  } else if (action === 'daf_contribution') {
    const contribution = await addDafContribution({ workspaceId: workspace, provider: decision.provider, amountCents: decision.amount_cents, contributedOn: decision.contributed_on, memberId: decision.member_id });
    links.daf_contribution_id = contribution.id;
  } else if (action === 'pledge') {
    const pledge = await createPledge({ workspaceId: workspace, organization: decision.organization, pledge: decision.pledge });
    Object.assign(links, { organization_id: pledge.organization_id, pledge_id: pledge.id });
  } else if (action === 'request') {
    const request = await createRequest({ workspaceId: workspace, organization: decision.organization, request: decision.request });
    Object.assign(links, { organization_id: request.organization_id, request_id: request.id });
  } else if (action === 'reject') {
    links.status = 'rejected';
  } else {
    throw invalid(`Unknown decision: ${action}`, 'action');
  }
  const [row] = await query(`
    UPDATE giving_source_items SET status = $3, organization_id = $4, gift_id = $5, refund_id = $6, pledge_id = $7, request_id = $8,
      daf_contribution_id = $9, decided_at = NOW()
     WHERE id = $1 AND workspace_id = $2 RETURNING *
  `, [item.id, workspace, links.status, links.organization_id, links.gift_id, links.refund_id, links.pledge_id, links.request_id, links.daf_contribution_id]);
  await transition(workspace, 'source_item', item.id, action, { from: 'proposed', to: links.status, detail: { ...links, status: undefined } });
  return itemRow(row);
}

// ── Lens, budget, snapshots ────────────────────────────────────────────

export async function currentLens({ workspaceId }) {
  const [row] = await query('SELECT * FROM giving_lens_versions WHERE workspace_id = $1 ORDER BY version DESC LIMIT 1', [ws(workspaceId)]);
  return row ? { id: row.id, version: Number(row.version), lens: json(row.lens), lens_sha256: row.lens_sha256, created_at: row.created_at } : null;
}

export async function saveLens({ workspaceId, lens }) {
  const workspace = ws(workspaceId);
  let normalized;
  try { normalized = validateLens(lens); } catch (error) { throw givingProblem(error); }
  const organizationIds = [...new Set(normalized.causes.flatMap(cause => cause.organization_ids))];
  if (organizationIds.length) {
    const found = await query('SELECT id FROM giving_organizations WHERE workspace_id = $1 AND id = ANY($2::text[])', [workspace, organizationIds]);
    if (found.length !== organizationIds.length) throw invalid('A cause links an organization that does not exist.', 'organization_ids');
  }
  const giftIds = [...normalized.causes, ...normalized.priorities].flatMap(entry => entry.origin.gift_ids || []);
  if (giftIds.length) {
    const found = await query('SELECT id FROM giving_gifts WHERE workspace_id = $1 AND id = ANY($2::text[])', [workspace, giftIds]);
    if (new Set(found.map(row => row.id)).size !== new Set(giftIds).size) throw invalid('A drafted cause cites a gift that is not confirmed.', 'origin');
  }
  const current = await currentLens({ workspaceId: workspace });
  if (current && sameLens(current.lens, normalized)) return current;
  const [row] = await query(`
    INSERT INTO giving_lens_versions (id, workspace_id, version, lens, lens_sha256) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING *
  `, [id(), workspace, (current?.version || 0) + 1, JSON.stringify(normalized), lensHash(normalized)]);
  await transition(workspace, 'lens', row.id, 'saved', { detail: { version: Number(row.version), causes: normalized.causes.length, priorities: normalized.priorities.length } });
  return { id: row.id, version: Number(row.version), lens: normalized, lens_sha256: row.lens_sha256, created_at: row.created_at };
}

export async function currentBudget({ workspaceId }) {
  const [row] = await query('SELECT * FROM giving_budgets WHERE workspace_id = $1 ORDER BY version DESC LIMIT 1', [ws(workspaceId)]);
  return budgetRow(row);
}

export async function saveBudget({ workspaceId, budget }) {
  const workspace = ws(workspaceId);
  let normalized;
  try { normalized = validateBudget(budget); } catch (error) { throw givingProblem(error); }
  for (const item of normalized.planned) {
    if (!(await getOrganization({ workspaceId: workspace, organizationId: item.organization_id }))) throw new CommandError('TARGET_NOT_FOUND', 'A planned organization was not found.');
  }
  const current = await currentBudget({ workspaceId: workspace });
  const [row] = await query(`
    INSERT INTO giving_budgets (id, workspace_id, version, starts_on, ends_on, mode, amount_cents, planned)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING *
  `, [id(), workspace, (current?.version || 0) + 1, normalized.starts_on, normalized.ends_on, normalized.mode, normalized.amount_cents, JSON.stringify(normalized.planned)]);
  await transition(workspace, 'budget', row.id, 'saved', { detail: { version: Number(row.version), mode: normalized.mode, amount_cents: normalized.amount_cents } });
  return budgetRow(row);
}

export async function saveSnapshot({ workspaceId, kind, asOf, payload, label = null, subjectId = null }) {
  const workspace = ws(workspaceId);
  optionalDate(asOf, 'as_of');
  const [row] = await query(`
    INSERT INTO giving_snapshots (id, workspace_id, kind, as_of, subject_id, label, payload, payload_sha256)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING *
  `, [id(), workspace, kind, asOf, subjectId, optionalText(label), canonicalJson(payload), snapshotHash(payload)]);
  await transition(workspace, 'snapshot', row.id, 'saved', { detail: { kind, as_of: asOf } });
  return snapshotRow(row);
}

export async function listSnapshots({ workspaceId, kind = null }) {
  return (await query(`
    SELECT id, workspace_id, kind, as_of, subject_id, label, payload_sha256, created_at, seq FROM giving_snapshots
     WHERE workspace_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY seq DESC
  `, [ws(workspaceId), kind])).map(snapshotRow);
}

export async function getSnapshot({ workspaceId, snapshotId }) {
  const [row] = await query('SELECT * FROM giving_snapshots WHERE id = $1 AND workspace_id = $2', [String(snapshotId), ws(workspaceId)]);
  return snapshotRow(row);
}

export async function listActivity({ workspaceId, limit = 100 }) {
  return query('SELECT * FROM giving_transitions WHERE workspace_id = $1 ORDER BY seq DESC LIMIT $2', [ws(workspaceId), Math.min(500, limit)]);
}

// ── Read models ────────────────────────────────────────────────────────

export async function givingReport({ workspaceId, asOf }) {
  const workspace = ws(workspaceId);
  const gifts = await giftsWithOrgs(workspace);
  const refunds = (await query('SELECT gift_id, amount_cents, refunded_on FROM giving_refunds WHERE workspace_id = $1', [workspace]))
    .map(row => ({ gift_id: row.gift_id, amount_cents: num(row.amount_cents), refunded_on: day(row.refunded_on) }));
  const lens = await currentLens({ workspaceId: workspace });
  // A gift counts toward a cause when its organization is linked to the cause, or when the
  // cause was drafted from that gift.
  const causes = (lens?.lens.causes || []).map(cause => {
    const orgs = new Set(cause.organization_ids || []);
    const drafted = new Set(cause.origin.gift_ids || []);
    return { id: cause.id, label: cause.label, gift_ids: gifts.filter(gift => orgs.has(gift.organization_id) || drafted.has(gift.id)).map(gift => gift.id) };
  });
  try {
    return { ...buildReport({ asOf, gifts, refunds, causes }), lens_version: lens?.version || null };
  } catch (error) { throw givingProblem(error); }
}

export async function givingPlan({ workspaceId }) {
  const workspace = ws(workspaceId);
  const budget = await currentBudget({ workspaceId: workspace });
  if (!budget) return null;
  const gifts = await giftsWithOrgs(workspace);
  const pledges = (await query('SELECT * FROM giving_pledges WHERE workspace_id = $1', [workspace])).map(pledgeRow);
  return { budget_version: budget.version, ...forwardPlan({ budget, gifts, pledges }) };
}

// ── Settings: ongoing intake (explicit opt-in; simulated until a real connector exists) ──

const INTAKE_OFF = { enabled: false };

export async function givingSettings({ workspaceId }) {
  const [r] = await query('SELECT * FROM giving_settings WHERE workspace_id = $1', [ws(workspaceId)]);
  return { ongoing_intake: r ? json(r.ongoing_intake) : INTAKE_OFF };
}

export async function setOngoingIntake({ workspaceId, enabled }) {
  const workspace = ws(workspaceId);
  const current = (await givingSettings({ workspaceId: workspace })).ongoing_intake;
  const next = enabled
    ? { enabled: true, mode: 'simulated', enabled_at: new Date().toISOString(), cadence: 'on request (simulation)' }
    : { enabled: false, mode: current.mode || null, disabled_at: new Date().toISOString() };
  await query(`
    INSERT INTO giving_settings (workspace_id, ongoing_intake, updated_at) VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (workspace_id) DO UPDATE SET ongoing_intake = EXCLUDED.ongoing_intake, updated_at = NOW()
  `, [workspace, JSON.stringify(next)]);
  await transition(workspace, 'settings', 'ongoing_intake', enabled ? 'enabled' : 'disabled', { from: current.enabled ? 'on' : 'off', to: enabled ? 'on' : 'off', detail: { mode: next.mode } });
  return next;
}

// Deletes every giving record for the workspace. Investment data is untouched.
export async function resetGiving({ workspaceId }) {
  const workspace = ws(workspaceId);
  const tables = ['giving_daf_plans', 'giving_daf_balances', 'giving_settings', 'giving_request_evaluations', 'giving_org_reviews', 'giving_snapshots', 'giving_transitions', 'giving_lens_versions', 'giving_budgets', 'giving_source_items', 'giving_refunds',
    'giving_gifts', 'giving_pledges', 'giving_requests', 'giving_daf_contributions', 'giving_sources', 'giving_organizations', 'giving_household_members'];
  const counts = {};
  for (const table of tables) counts[table] = (await query(`DELETE FROM ${table} WHERE workspace_id = $1 RETURNING 1`, [workspace])).length;
  return counts;
}

export async function exportGiving({ workspaceId }) {
  const workspace = ws(workspaceId);
  const tables = ['giving_household_members', 'giving_organizations', 'giving_sources', 'giving_source_items', 'giving_requests', 'giving_pledges',
    'giving_gifts', 'giving_refunds', 'giving_daf_contributions', 'giving_daf_balances', 'giving_daf_plans', 'giving_lens_versions', 'giving_budgets', 'giving_snapshots', 'giving_transitions', 'giving_org_reviews', 'giving_request_evaluations', 'giving_settings'];
  const out = { format: 'radar-giving-export/v1', exported_at: new Date().toISOString(), tables: {} };
  for (const table of tables) out.tables[table] = await query(`SELECT * FROM ${table} WHERE workspace_id = $1`, [workspace]);
  return out;
}
