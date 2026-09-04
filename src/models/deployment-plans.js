import { query } from '../db/index.js';

function yearValue(value = new Date().getFullYear()) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new TypeError('budgetYear must be an integer between 2000 and 2100');
  }
  return year;
}

function moneyValue(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 999999999999.99) {
    throw new TypeError('annualBudget must be a non-negative dollar amount');
  }
  return Math.round(amount * 100) / 100;
}

export async function getAnnualDeploymentPlan(budgetYear = new Date().getFullYear(), {
  fallbackAnnualBudget = null,
} = {}) {
  const year = yearValue(budgetYear);
  const [saved] = await query(`
    SELECT id, budget_year, asset_class, annual_budget, version,
           supersedes_id, change_note, created_at
      FROM annual_deployment_plan_versions
     WHERE budget_year = $1 AND asset_class = 'direct'
     ORDER BY version DESC, id DESC
     LIMIT 1
  `, [year]);
  if (saved) return { ...saved, source: 'saved_plan' };

  const fallback = Number(fallbackAnnualBudget);
  return {
    id: null,
    budget_year: year,
    asset_class: 'direct',
    annual_budget: Number.isFinite(fallback) && fallback >= 0 ? fallback : null,
    version: null,
    supersedes_id: null,
    change_note: null,
    created_at: null,
    source: Number.isFinite(fallback) && fallback >= 0 ? 'legacy_config' : 'not_configured',
  };
}

export async function saveAnnualDeploymentPlan({
  budgetYear,
  annualBudget,
  changeNote = null,
}) {
  const year = yearValue(budgetYear);
  const amount = moneyValue(annualBudget);
  const previous = await getAnnualDeploymentPlan(year);
  const nextVersion = previous.source === 'saved_plan' ? Number(previous.version) + 1 : 1;
  const note = String(changeNote || '').trim() || null;
  const [saved] = await query(`
    INSERT INTO annual_deployment_plan_versions (
      budget_year, asset_class, annual_budget, version, supersedes_id, change_note
    ) VALUES ($1, 'direct', $2, $3, $4, $5)
    RETURNING *
  `, [year, amount, nextVersion, previous.id, note]);
  return { ...saved, source: 'saved_plan' };
}

export async function listAnnualDeploymentPlanVersions(budgetYear = new Date().getFullYear()) {
  return query(`
    SELECT id, budget_year, asset_class, annual_budget, version,
           supersedes_id, change_note, created_at
      FROM annual_deployment_plan_versions
     WHERE budget_year = $1 AND asset_class = 'direct'
     ORDER BY version DESC, id DESC
  `, [yearValue(budgetYear)]);
}
