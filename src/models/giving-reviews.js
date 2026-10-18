import { randomUUID } from 'node:crypto';
import { query } from '../db/index.js';
import { CommandError } from '../commands/errors.js';
import { snapshotHash } from '../angel/personal-context.js';
import { forwardPlan, scenario } from '../giving/budget.js';
import { GIVING_RUBRIC_VERSION } from '../giving/review-contract.js';
import { currentBudget, currentLens, getOrganization, getRequest, listGifts } from './giving.js';
import { getAnalysisLens, saveAnalysisLens } from './analysis-lenses.js';
import { validateLens, lensHash } from '../giving/lens.js';

// Giving research runs. A start creates a 'running' row whose inputs are assembled here from
// the database, so the runner never decides what it was asked. Completed rows are immutable.

const STALE_MS = 45 * 60 * 1000;
const json = value => (value == null ? null : typeof value === 'string' ? JSON.parse(value) : value);
const row = r => r && ({ ...r, seq: Number(r.seq), inputs: json(r.inputs), artifact: json(r.artifact), retrieval: json(r.retrieval), usage: json(r.usage) });
const ws = workspaceId => {
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) throw new CommandError('WORKSPACE_REQUIRED', 'A workspace is required.');
  return workspaceId;
};

// Approximate months of reserves from a 990: (assets − liabilities) ÷ (expenses ÷ 12). Labeled as such.
export function derivedFinancials(filings = []) {
  return filings
    .filter(f => f.totalExpenses > 0)
    .map(f => ({
      tax_year: f.taxYear,
      form: f.form,
      revenue: f.totalRevenue,
      expenses: f.totalExpenses,
      net_assets: f.totalAssets != null && f.totalLiabilities != null ? f.totalAssets - f.totalLiabilities : null,
      approx_months_of_reserves: f.totalAssets != null && f.totalLiabilities != null
        ? Math.round(((f.totalAssets - f.totalLiabilities) / (f.totalExpenses / 12)) * 10) / 10 : null,
      surplus: f.totalRevenue != null ? f.totalRevenue - f.totalExpenses : null,
    }));
}

async function failStale(table, column, value, workspaceId) {
  await query(`
    UPDATE ${table} SET status = 'failed', error_code = 'INTERRUPTED', error_message = 'The run stopped before finishing (Radar was closed or restarted).'
     WHERE ${column} = $1 AND workspace_id = $2 AND status = 'running' AND created_at < NOW() - INTERVAL '${STALE_MS / 1000} seconds'
  `, [value, workspaceId]);
}

// ── Organization reviews ──

export async function startOrgReview({ workspaceId, organizationId }) {
  const workspace = ws(workspaceId);
  const org = await getOrganization({ workspaceId: workspace, organizationId });
  if (!org) throw new CommandError('TARGET_NOT_FOUND', 'Organization not found.');
  await failStale('giving_org_reviews', 'organization_id', org.id, workspace);
  const [running] = await query(`SELECT * FROM giving_org_reviews WHERE organization_id = $1 AND workspace_id = $2 AND status = 'running'`, [org.id, workspace]);
  if (running) return { review: row(running), already_running: true };
  const registry = org.registry_snapshot || null;
  // Only public identity goes into research inputs: never gifts, amounts, notes or household names.
  const inputs = {
    organization: { id: org.id, name: org.name, ein: org.ein, website: org.website || null, aliases: org.aliases || [] },
    registry: registry ? { source: registry.source, retrieved_at: registry.retrieved_at, organization: registry.organization, filings: registry.filings || [] } : null,
    derived_financials: derivedFinancials(registry?.filings || []),
  };
  const [created] = await query(`
    INSERT INTO giving_org_reviews (id, workspace_id, organization_id, status, rubric_version, inputs)
    VALUES ($1, $2, $3, 'running', $4, $5::jsonb) RETURNING *
  `, [randomUUID(), workspace, org.id, GIVING_RUBRIC_VERSION, JSON.stringify(inputs)]);
  return { review: row(created), already_running: false };
}

export async function getOrgReview({ workspaceId, reviewId }) {
  const [r] = await query('SELECT * FROM giving_org_reviews WHERE id = $1 AND workspace_id = $2', [String(reviewId), ws(workspaceId)]);
  return row(r);
}

export async function orgReviewState({ workspaceId, organizationId }) {
  const workspace = ws(workspaceId);
  const rows = (await query('SELECT * FROM giving_org_reviews WHERE organization_id = $1 AND workspace_id = $2 ORDER BY seq DESC LIMIT 20', [organizationId, workspace])).map(row);
  const running = rows.find(r => r.status === 'running') || null;
  return {
    latest: rows.find(r => r.status === 'completed') || null,
    running: running && Date.now() - new Date(running.created_at).getTime() < STALE_MS ? running : null,
    lastFailure: rows[0]?.status === 'failed' ? rows[0] : null,
    history: rows.filter(r => r.status === 'completed').map(r => ({ id: r.id, completed_at: r.completed_at })),
  };
}

export async function completeOrgReview({ workspaceId, reviewId, artifact, retrieval = null, usage = null }) {
  const [r] = await query(`
    UPDATE giving_org_reviews SET status = 'completed', artifact = $3::jsonb, retrieval = $4::jsonb, usage = $5::jsonb, completed_at = NOW()
     WHERE id = $1 AND workspace_id = $2 AND status = 'running' RETURNING *
  `, [reviewId, ws(workspaceId), JSON.stringify(artifact), retrieval ? JSON.stringify(retrieval) : null, usage ? JSON.stringify(usage) : null]);
  if (!r) throw new CommandError('PRECONDITION_FAILED', 'This review is no longer running.');
  return row(r);
}

export async function failOrgReview({ workspaceId, reviewId, code, message }) {
  const [r] = await query(`
    UPDATE giving_org_reviews SET status = 'failed', error_code = $3, error_message = $4 WHERE id = $1 AND workspace_id = $2 AND status = 'running' RETURNING *
  `, [reviewId, ws(workspaceId), String(code || 'FAILED').slice(0, 60), String(message || '').slice(0, 500)]);
  return row(r);
}

// ── Request evaluations ──

export async function startRequestEvaluation({ workspaceId, requestId, lensChoice = 'plan', customLens = null, saveLensName = null }) {
  const workspace = ws(workspaceId);
  const request = await getRequest({ workspaceId: workspace, requestId });
  if (!request) throw new CommandError('TARGET_NOT_FOUND', 'Request not found.');
  const reviewState = await orgReviewState({ workspaceId: workspace, organizationId: request.organization_id });
  if (!reviewState.latest) throw new CommandError('PRECONDITION_FAILED', 'Research the organization first. The evaluation reads the request against that review.');
  await failStale('giving_request_evaluations', 'request_id', request.id, workspace);
  const [running] = await query(`SELECT * FROM giving_request_evaluations WHERE request_id = $1 AND workspace_id = $2 AND status = 'running'`, [request.id, workspace]);
  if (running) return { evaluation: row(running), already_running: true };

  let lens;
  let lensSource;
  if (lensChoice === 'plan') {
    if (customLens || saveLensName) throw new CommandError('PRECONDITION_FAILED', 'Custom preferences must be explicitly selected.');
    lens = await currentLens({ workspaceId: workspace });
    lensSource = { kind: 'plan', id: lens?.id || null };
  } else if (lensChoice === 'custom') {
    const normalized = validateLens(customLens || {});
    const saved = saveLensName ? await saveAnalysisLens({ workspaceId: workspace, category: 'giving', name: saveLensName, payload: normalized }) : null;
    lens = { version: null, lens_sha256: lensHash(normalized), lens: normalized };
    lensSource = { kind: saved ? 'saved' : 'custom', id: saved?.id || null, name: saved?.name || null };
  } else {
    if (customLens || saveLensName) throw new CommandError('PRECONDITION_FAILED', 'A saved lens cannot be overwritten by this evaluation.');
    const saved = await getAnalysisLens({ workspaceId: workspace, category: 'giving', lensId: lensChoice });
    if (!saved) throw new CommandError('TARGET_NOT_FOUND', 'That Giving lens was not found.');
    lens = { version: null, lens_sha256: saved.sha256, lens: saved.payload };
    lensSource = { kind: 'saved', id: saved.id, name: saved.name };
  }
  const budget = await currentBudget({ workspaceId: workspace });
  const gifts = await listGifts({ workspaceId: workspace });
  const pledges = (await query('SELECT * FROM giving_pledges WHERE workspace_id = $1', [workspace])).map(p => ({ ...p, total_cents: Number(p.total_cents) }));
  const plan = budget ? forwardPlan({ budget, gifts, pledges }) : null;
  const amount = request.decided_cents ?? request.requested_cents;
  const alreadyCounted = ['approved', 'pledged'].includes(request.status) ? (request.decided_cents || 0) : 0;
  const [source] = await query(`SELECT excerpt FROM giving_source_items WHERE request_id = $1 AND workspace_id = $2 ORDER BY seq LIMIT 1`, [request.id, workspace]);
  const [org] = await query('SELECT name FROM giving_organizations WHERE id = $1', [request.organization_id]);
  const inputs = {
    request: {
      id: request.id, organization: org?.name || null, purpose: request.purpose, requested_cents: request.requested_cents,
      deadline: request.deadline, status: request.status, text: source?.excerpt || null,
    },
    org_review_id: reviewState.latest.id,
    org_review_completed_at: reviewState.latest.completed_at,
    lens: lens
      ? { version: lens.version, sha256: lens.lens_sha256, causes: lens.lens.causes.map(c => ({ id: c.id, label: c.label, outcome: c.outcome, community: c.community, geography: c.geography, note: c.note })), priorities: lens.lens.priorities.map(p => ({ id: p.id, label: p.label, note: p.note, must_have: p.must_have })), reasoning: lens.lens.reasoning }
      : { version: null, sha256: null, causes: [], priorities: [], reasoning: null },
    lens_source: lensSource,
    budget: plan
      ? { version: budget.version, plan: { starts_on: plan.starts_on, ends_on: plan.ends_on, budget_cents: plan.budget_cents, unallocated_cents: plan.unallocated_cents, committed_cents: plan.committed_cents, planned_remaining_cents: plan.planned_remaining_cents, paid_in_period_cents: plan.paid_in_period_cents },
        effect: amount != null ? scenario(plan, { amount_cents: amount, organization_id: request.organization_id, already_counted_cents: alreadyCounted }) : null }
      : null,
  };
  const [created] = await query(`
    INSERT INTO giving_request_evaluations (id, workspace_id, request_id, org_review_id, status, inputs, inputs_sha256)
    VALUES ($1, $2, $3, $4, 'running', $5::jsonb, $6) RETURNING *
  `, [randomUUID(), workspace, request.id, reviewState.latest.id, JSON.stringify(inputs), snapshotHash(inputs)]);
  return { evaluation: row(created), already_running: false };
}

export async function getRequestEvaluation({ workspaceId, evaluationId }) {
  const [r] = await query('SELECT * FROM giving_request_evaluations WHERE id = $1 AND workspace_id = $2', [String(evaluationId), ws(workspaceId)]);
  return row(r);
}

export async function requestEvaluationState({ workspaceId, requestId }) {
  const rows = (await query('SELECT * FROM giving_request_evaluations WHERE request_id = $1 AND workspace_id = $2 ORDER BY seq DESC LIMIT 20', [requestId, ws(workspaceId)])).map(row);
  const running = rows.find(r => r.status === 'running') || null;
  return {
    latest: rows.find(r => r.status === 'completed') || null,
    running: running && Date.now() - new Date(running.created_at).getTime() < STALE_MS ? running : null,
    lastFailure: rows[0]?.status === 'failed' ? rows[0] : null,
  };
}

export async function completeRequestEvaluation({ workspaceId, evaluationId, artifact, usage = null }) {
  const [r] = await query(`
    UPDATE giving_request_evaluations SET status = 'completed', artifact = $3::jsonb, usage = $4::jsonb, completed_at = NOW()
     WHERE id = $1 AND workspace_id = $2 AND status = 'running' RETURNING *
  `, [evaluationId, ws(workspaceId), JSON.stringify(artifact), usage ? JSON.stringify(usage) : null]);
  if (!r) throw new CommandError('PRECONDITION_FAILED', 'This evaluation is no longer running.');
  return row(r);
}

export async function failRequestEvaluation({ workspaceId, evaluationId, code, message }) {
  const [r] = await query(`
    UPDATE giving_request_evaluations SET status = 'failed', error_code = $3, error_message = $4 WHERE id = $1 AND workspace_id = $2 AND status = 'running' RETURNING *
  `, [evaluationId, ws(workspaceId), String(code || 'FAILED').slice(0, 60), String(message || '').slice(0, 500)]);
  return row(r);
}
