import { query } from '../db/index.js';
import { getAnnualDeploymentPlan } from '../models/deployment-plans.js';
import { loadBetSizingConfig } from '../utils/bet-sizing.js';

function yearValue(value = new Date().getFullYear()) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new TypeError('budgetYear must be an integer between 2000 and 2100');
  }
  return year;
}

export async function directDeploymentActivity(budgetYear = new Date().getFullYear()) {
  const year = yearValue(budgetYear);
  const [deployed] = await query(`
    SELECT COALESCE(SUM(ABS(cf.amount)), 0) AS deployed
      FROM cash_flows cf
      JOIN investments i ON i.id = cf.investment_id
     WHERE cf.type = 'investment'
       AND cf.flow_date >= make_date($1, 1, 1)
       AND cf.flow_date < make_date($1 + 1, 1, 1)
       AND i.asset_class = 'direct'
  `, [year]);
  const [committed] = await query(`
    SELECT COALESCE(SUM(COALESCE(
             pi.allocation_usd,
             (SELECT dr.chosen_size
                FROM decision_records dr
               WHERE dr.pipeline_invite_id = pi.id
                 AND dr.sealed = TRUE
                 AND LOWER(dr.decision) = 'invest'
               ORDER BY dr.sealed_at DESC NULLS LAST, dr.id DESC
               LIMIT 1),
             0
           )), 0) AS committed
      FROM pipeline_invites pi
     WHERE LOWER(pi.status) = 'committed'
       AND pi.investment_id IS NULL
  `);
  return {
    budget_year: year,
    deployed_this_year: Number(deployed?.deployed || 0),
    unfunded_commitments: Number(committed?.committed || 0),
  };
}

export async function annualDeploymentPlanReport({
  budgetYear = new Date().getFullYear(),
  fallbackAnnualBudget = loadBetSizingConfig().annual_budget,
} = {}) {
  const year = yearValue(budgetYear);
  const [plan, activity] = await Promise.all([
    getAnnualDeploymentPlan(year, { fallbackAnnualBudget }),
    directDeploymentActivity(year),
  ]);
  const budget = plan.annual_budget == null ? null : Number(plan.annual_budget);
  const deployed = activity.deployed_this_year;
  const committed = activity.unfunded_commitments;
  const cashRemaining = budget == null ? null : Math.max(0, budget - deployed);
  const available = budget == null ? null : Math.max(0, budget - deployed - committed);
  return {
    ...plan,
    annual_budget: budget,
    deployed_this_year: deployed,
    unfunded_commitments: committed,
    cash_remaining: cashRemaining,
    available_after_commitments: available,
    utilization_pct: budget > 0 ? deployed / budget : null,
  };
}
