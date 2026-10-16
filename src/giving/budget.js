// Forward giving budget (pure).
//
// The forward budget has fixed dates and is separate from trailing history: the
// trailing total is only ever a suggestion and is never subtracted from it.
//   paid_in_period   confirmed gifts dated inside [starts_on, ends_on]
//   committed        outstanding pledge balances (all-time payments already netted)
//   planned_remaining planned allocations not tied to a pledge, less what was paid
//                    to that organization in the period
//   unallocated      budget − paid_in_period − committed − planned_remaining
// A skipped budget yields no dollar plan (unallocated null). Zero is a real budget.

import { assertDate, GivingError } from './report.js';
import { pledgeOutstanding } from './lifecycle.js';

export function validateBudget({ starts_on, ends_on, mode, amount_cents, planned = [] }) {
  assertDate(starts_on, 'starts_on');
  assertDate(ends_on, 'ends_on');
  if (ends_on <= starts_on) throw new GivingError('The budget must end after it starts.', 'ends_on');
  if (!['recorded', 'custom', 'skipped'].includes(mode)) throw new GivingError(`Unknown budget mode: ${mode}`, 'mode');
  if (mode === 'skipped') {
    if (amount_cents != null) throw new GivingError('A skipped budget has no amount.', 'amount_cents');
    if (planned.length) throw new GivingError('A skipped budget has no dollar allocations.', 'planned');
  } else if (!Number.isSafeInteger(amount_cents) || amount_cents < 0) {
    throw new GivingError('Budget amount must be zero or more, in cents.', 'amount_cents');
  }
  for (const [index, item] of planned.entries()) {
    if (!item || typeof item.organization_id !== 'string') throw new GivingError('Each planned allocation needs an organization.', `planned[${index}]`);
    if (!Number.isSafeInteger(item.amount_cents) || item.amount_cents <= 0) throw new GivingError('Planned amounts must be positive cents.', `planned[${index}]`);
  }
  return { starts_on, ends_on, mode, amount_cents: mode === 'skipped' ? null : amount_cents, planned };
}

// gifts: confirmed gifts [{organization_id, amount_cents, refunded_cents, paid_on, pledge_id, voided}]
// pledges: [{id, total_cents, status}]
export function forwardPlan({ budget, gifts = [], pledges = [] }) {
  const inPeriod = gifts.filter(gift => !gift.voided && gift.paid_on && gift.paid_on >= budget.starts_on && gift.paid_on <= budget.ends_on);
  const net = gift => gift.amount_cents - (gift.refunded_cents || 0);
  const paid = inPeriod.reduce((sum, gift) => sum + net(gift), 0);
  const committed = pledges.reduce((sum, pledge) => sum + pledgeOutstanding(pledge, gifts.filter(gift => gift.pledge_id === pledge.id)).outstanding_cents, 0);

  const paidByOrg = new Map();
  for (const gift of inPeriod) if (!gift.pledge_id) paidByOrg.set(gift.organization_id, (paidByOrg.get(gift.organization_id) || 0) + net(gift));
  let plannedRemaining = 0;
  const planned = budget.planned.map(item => {
    if (item.pledge_id) return { ...item, remaining_cents: 0, counted_as: 'commitment' };
    const credit = Math.min(item.amount_cents, paidByOrg.get(item.organization_id) || 0);
    paidByOrg.set(item.organization_id, (paidByOrg.get(item.organization_id) || 0) - credit);
    plannedRemaining += item.amount_cents - credit;
    return { ...item, remaining_cents: item.amount_cents - credit, counted_as: 'planned' };
  });

  return {
    starts_on: budget.starts_on,
    ends_on: budget.ends_on,
    mode: budget.mode,
    budget_cents: budget.amount_cents,
    paid_in_period_cents: paid,
    committed_cents: committed,
    planned_remaining_cents: plannedRemaining,
    unallocated_cents: budget.amount_cents == null ? null : budget.amount_cents - paid - committed - plannedRemaining,
    planned,
  };
}

// Incremental effect of a proposed gift. A request already counted (pledged, or planned
// for the same organization) is reported, not added a second time.
export function scenario(plan, { amount_cents, organization_id, already_counted_cents = 0 }) {
  if (!Number.isSafeInteger(amount_cents) || amount_cents < 0) throw new GivingError('Scenario amount must be cents.', 'amount_cents');
  const increment = Math.max(0, amount_cents - already_counted_cents);
  const after = plan.unallocated_cents == null ? null : plan.unallocated_cents - increment;
  return {
    organization_id,
    amount_cents,
    increment_cents: increment,
    unallocated_after_cents: after,
    over_budget_cents: after != null && after < 0 ? -after : 0,
  };
}
