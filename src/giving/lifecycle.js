// Gift request and pledge lifecycle (pure).
//
// A request moves through explicit decisions. "Paid" is never a request status:
// payment exists only as a confirmed gift that references the request or its pledge.
// Approval never records a donation or initiates a transfer.

import { GivingError } from './report.js';

export const REQUEST_STATUSES = Object.freeze(['requested', 'evaluating', 'approved', 'pledged', 'deferred', 'passed', 'cancelled']);

const REQUEST_TRANSITIONS = Object.freeze({
  requested: ['evaluating', 'approved', 'pledged', 'deferred', 'passed', 'cancelled'],
  evaluating: ['requested', 'approved', 'pledged', 'deferred', 'passed', 'cancelled'],
  approved: ['pledged', 'deferred', 'cancelled'],
  pledged: ['cancelled'],
  deferred: ['requested', 'evaluating', 'passed', 'cancelled'],
  passed: ['requested'],
  cancelled: [],
});

export function assertRequestTransition(from, to) {
  if (!REQUEST_STATUSES.includes(to)) throw new GivingError(`Unknown request status: ${to}`, 'status');
  if (!(REQUEST_TRANSITIONS[from] || []).includes(to)) {
    throw new GivingError(`A request cannot move from ${from} to ${to}.`, 'status');
  }
}

const netPaid = gifts => gifts
  .filter(gift => !gift.voided)
  .reduce((sum, gift) => sum + gift.amount_cents - (gift.refunded_cents || 0), 0);

// Commitment outstanding = pledge total − net payments linked to it (never below zero).
export function pledgeOutstanding(pledge, linkedGifts) {
  if (pledge.status === 'cancelled') return { paid_cents: netPaid(linkedGifts), outstanding_cents: 0 };
  const paid = netPaid(linkedGifts);
  return { paid_cents: paid, outstanding_cents: Math.max(0, pledge.total_cents - paid) };
}

// Payment state of a decided request, derived from confirmed gifts only.
export function requestPaymentState(request, linkedGifts) {
  const paid = netPaid(linkedGifts);
  if (paid <= 0) return { state: 'unpaid', paid_cents: 0 };
  const target = request.decided_cents ?? request.requested_cents;
  if (target != null && paid >= target) return { state: 'paid_in_full', paid_cents: paid };
  return { state: 'partially_paid', paid_cents: paid };
}
