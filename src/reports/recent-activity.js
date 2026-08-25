import { query as defaultQuery } from '../db/index.js';

function jsonValue(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function words(value) {
  return String(value || '')
    .replaceAll('.', ' ')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

const COMMAND_LABELS = Object.freeze({
  'council.answer_followup': 'Founder answer saved',
  'council.apply_followups': 'Founder answers reassessed',
  'council.cancel': 'Council stopped',
  'council.start': 'Council started',
  'intake.commit': 'Document added',
  'intake.commit_batch': 'Documents added',
  'pipeline.clear': 'Deal cleared',
  'pipeline.mark_executed': 'Investment executed',
  'pipeline.reopen_decision': 'Decision reopened',
  'pipeline.seal_decision': 'Decision recorded',
  'pin.dismiss': 'Pinned item dismissed',
  'thesis.assign_primary': 'Primary thesis assigned',
  'thesis.assign_primary_bulk': 'Positions categorized',
  'update.add': 'Update added',
  'update.review': 'Update reviewed',
});

function commandLabel(names) {
  if (names.length !== 1) return `${names.length} changes applied`;
  return COMMAND_LABELS[names[0]] || `${words(names[0])} recorded`;
}

function resourceLink(resource, pipelineSlugs) {
  if (!resource) return '/dashboard';
  if (resource.type === 'pipeline_invite') {
    const slug = pipelineSlugs.get(Number(resource.id));
    return slug ? `/pipeline/${slug}` : '/pipeline';
  }
  if (resource.type === 'direct_position') {
    return resource.label ? `/portfolio/${encodeURIComponent(resource.label)}` : '/portfolio';
  }
  if (resource.type === 'fund_position') return `/funds/${resource.id}`;
  if (resource.type === 'employment_equity_position') return `/employment-equity/${resource.id}`;
  if (resource.type === 'investment_update') return `/updates/${resource.id}`;
  if (resource.type === 'thesis') return '/thesis';
  if (resource.type === 'metric_view') return '/performance';
  return '/dashboard';
}

function terminalCouncilLabel(eventType) {
  if (eventType === 'completed') return 'Council evaluation completed';
  if (eventType === 'cancelled') return 'Council stopped';
  return 'Council evaluation needs attention';
}

export function projectRecentActivity({ receipts, councilEvents, pipelineEvents, updates, pipelineSlugs }) {
  const receiptPipelineIds = new Set();
  const receiptUpdateIds = new Set();
  const items = receipts.map(row => {
    const receipt = jsonValue(row.receipt, {});
    const resources = receipt.affectedResources || receipt.affected_resources || [];
    for (const resource of resources) {
      if (resource.type === 'pipeline_invite') receiptPipelineIds.add(Number(resource.id));
      if (resource.type === 'investment_update') receiptUpdateIds.add(String(resource.id));
    }
    const commands = receipt.commands || [];
    const names = commands.map(command => command.name).filter(Boolean);
    const primary = resources.find(resource => resource.label) || resources[0] || null;
    return {
      key: `receipt:${row.id}`,
      kind: 'command',
      title: primary?.label || 'Radar',
      detail: commandLabel(names),
      href: resourceLink(primary, pipelineSlugs),
      occurredAt: row.created_at,
      stableId: String(row.id),
    };
  });
  for (const row of councilEvents) {
    items.push({
      key: `council:${row.id}`,
      kind: 'council',
      title: row.company_name,
      detail: terminalCouncilLabel(row.event_type),
      href: `/pipeline/${row.deal_slug}`,
      occurredAt: row.occurred_at,
      stableId: String(row.id),
    });
  }
  for (const row of pipelineEvents) {
    if (receiptPipelineIds.has(Number(row.invite_id))) continue;
    items.push({
      key: `pipeline:${row.id}`,
      kind: 'legacy_pipeline',
      title: row.company_name,
      detail: row.event_type === 'invite_received' ? 'Deal received' : 'Pipeline status changed',
      href: `/pipeline/${row.deal_slug}`,
      occurredAt: row.event_date,
      stableId: String(row.id),
    });
  }
  for (const row of updates) {
    if (receiptUpdateIds.has(String(row.id))) continue;
    items.push({
      key: `update:${row.id}`,
      kind: 'legacy_update',
      title: row.company_name,
      detail: 'Update received',
      href: `/updates/${row.id}`,
      occurredAt: row.created_at,
      stableId: String(row.id),
    });
  }
  return items.sort((left, right) => {
    const date = new Date(right.occurredAt) - new Date(left.occurredAt);
    return date || right.stableId.localeCompare(left.stableId);
  });
}

export async function recentActivityReport({ limit = 20 } = {}, deps = {}) {
  const query = deps.query || defaultQuery;
  const bounded = Math.max(1, Math.min(100, Number(limit) || 20));
  const [receipts, councilEvents, pipelineEvents, updates] = await Promise.all([
    query(`SELECT id, receipt, created_at FROM command_receipts ORDER BY created_at DESC, id DESC LIMIT $1`, [bounded * 3]),
    query(
      `SELECT event.id, event.event_type, event.occurred_at,
              invite.company_name, invite.deal_slug
       FROM council_run_events event
       JOIN council_runs run ON run.id = event.run_id
       JOIN pipeline_invites invite ON invite.id = run.pipeline_invite_id
       WHERE event.event_type IN ('completed', 'failed', 'stalled', 'interrupted', 'cancelled')
       ORDER BY event.occurred_at DESC, event.id DESC LIMIT $1`,
      [bounded * 2],
    ),
    query(
      `SELECT event.id, event.invite_id, event.event_type, event.event_date,
              invite.company_name, invite.deal_slug
       FROM pipeline_events event
       JOIN pipeline_invites invite ON invite.id = event.invite_id
       ORDER BY event.event_date DESC, event.id DESC LIMIT $1`,
      [bounded * 2],
    ),
    query(
      `SELECT source_update.id, source_update.created_at, investment.company_name
       FROM investment_updates source_update
       JOIN investments investment ON investment.id = source_update.investment_id
       ORDER BY source_update.created_at DESC, source_update.id DESC LIMIT $1`,
      [bounded * 2],
    ),
  ]);
  const pipelineIds = new Set();
  for (const row of receipts) {
    const receipt = jsonValue(row.receipt, {});
    for (const resource of receipt.affectedResources || receipt.affected_resources || []) {
      if (resource.type === 'pipeline_invite') pipelineIds.add(Number(resource.id));
    }
  }
  const slugRows = pipelineIds.size > 0
    ? await query('SELECT id, deal_slug FROM pipeline_invites WHERE id = ANY($1::int[])', [[...pipelineIds]])
    : [];
  return projectRecentActivity({
    receipts,
    councilEvents,
    pipelineEvents,
    updates,
    pipelineSlugs: new Map(slugRows.map(row => [Number(row.id), row.deal_slug])),
  }).slice(0, bounded);
}
