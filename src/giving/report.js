// Giving report arithmetic (pure, no DB, no I/O).
//
// The trailing window is (asOf − 12 calendar months, asOf]; the prior window is the
// immediately preceding, non-overlapping 12 months. Only paid, non-voided gifts count.
// Gifts without a date go to a review queue and stay out of dated totals.
// Refunds count in the window of their own date (an undated refund follows its gift).
// Currencies are never mixed or converted: every total is per currency.
// Nothing is annualized.

export class GivingError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = 'GivingError';
    this.code = 'INVALID_GIVING_INPUT';
    this.field = field;
  }
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function assertDate(value, field = 'date') {
  const match = DATE.exec(value || '');
  if (!match) throw new GivingError(`${field} must be YYYY-MM-DD`, field);
  const [, y, m, d] = match.map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) throw new GivingError(`${field} is not a real date`, field);
  return value;
}

// Calendar-month shift, clamped to the end of the target month (2024-02-29 − 12 months = 2023-02-28).
export function shiftMonths(date, months) {
  assertDate(date);
  const [y, m, d] = date.split('-').map(Number);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = index % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export function trailingWindows(asOf) {
  assertDate(asOf, 'as_of');
  const start = shiftMonths(asOf, -12);
  return {
    current: { after: start, through: asOf },
    prior: { after: shiftMonths(start, -12), through: start },
  };
}

export const inWindow = (date, window) => Boolean(date) && date > window.after && date <= window.through;

const emptyTotals = () => ({ gross_cents: 0, refunds_cents: 0, net_cents: 0 });
function bucket(map, key, make) {
  if (!map.has(key)) map.set(key, make());
  return map.get(key);
}
const finish = totals => ({ ...totals, net_cents: totals.gross_cents - totals.refunds_cents });

// gifts: [{id, organization_id, organization_name, purpose, amount_cents, currency, paid_on, member_id, vehicle, voided}]
// refunds: [{id, gift_id, amount_cents, refunded_on}]
// causes (optional, from the confirmed lens): [{id, label, gift_ids}]
export function buildReport({ asOf, gifts = [], refunds = [], causes = [] }) {
  const windows = trailingWindows(asOf);
  const live = gifts.filter(gift => !gift.voided);
  const byId = new Map(live.map(gift => [gift.id, gift]));

  const periodTotals = { current: new Map(), prior: new Map() };
  const orgs = new Map();
  const members = new Map();
  const causeTotals = new Map(causes.map(cause => [cause.id, { cause_id: cause.id, label: cause.label, currencies: new Map() }]));
  const giftCause = new Map();
  for (const cause of causes) for (const id of cause.gift_ids || []) bucket(giftCause, id, () => []).push(cause.id);

  const periodOf = date => (inWindow(date, windows.current) ? 'current' : inWindow(date, windows.prior) ? 'prior' : null);

  function add(gift, period, field, cents) {
    const totals = bucket(periodTotals[period], gift.currency, emptyTotals);
    totals[field] += cents;
    const org = bucket(orgs, gift.organization_id, () => ({
      organization_id: gift.organization_id, name: gift.organization_name, currencies: new Map(), prior: new Map(), purposes: new Map(),
    }));
    if (period !== 'current') {
      bucket(org.prior, gift.currency, emptyTotals)[field] += cents;
      return;
    }
    bucket(org.currencies, gift.currency, emptyTotals)[field] += cents;
    const purpose = bucket(org.purposes, `${gift.purpose || ''}\u0000${gift.currency}`, () => ({
      purpose: gift.purpose || null, currency: gift.currency, ...emptyTotals(),
    }));
    purpose[field] += cents;
    bucket(bucket(members, gift.member_id || null, () => new Map()), gift.currency, emptyTotals)[field] += cents;
    for (const causeId of giftCause.get(gift.id) || []) {
      const cause = causeTotals.get(causeId);
      if (cause) bucket(cause.currencies, gift.currency, emptyTotals)[field] += cents;
    }
  }

  const unknownDate = [];
  for (const gift of live) {
    if (!gift.paid_on) { unknownDate.push(gift.id); continue; }
    const period = periodOf(gift.paid_on);
    if (period) add(gift, period, 'gross_cents', gift.amount_cents);
  }
  for (const refund of refunds) {
    const gift = byId.get(refund.gift_id);
    if (!gift) continue;
    const period = periodOf(refund.refunded_on || gift.paid_on);
    if (period) add(gift, period, 'refunds_cents', refund.amount_cents);
  }

  const currencyList = map => [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, totals]) => ({ currency, ...finish(totals) }));
  const current = currencyList(periodTotals.current);
  const prior = currencyList(periodTotals.prior);
  const currencies = [...new Set([...current, ...prior].map(row => row.currency))].sort();
  const change = currencies.map(currency => ({
    currency,
    net_change_cents: (current.find(row => row.currency === currency)?.net_cents || 0) - (prior.find(row => row.currency === currency)?.net_cents || 0),
  }));

  return {
    as_of: asOf,
    windows,
    totals: current,
    prior_totals: prior,
    change,
    mixed_currencies: currencies.length > 1,
    by_organization: [...orgs.values()]
      .map(org => ({
        organization_id: org.organization_id,
        name: org.name,
        totals: currencyList(org.currencies),
        prior_totals: currencyList(org.prior),
        // given in the prior window only: not repeated so far this period
        status: org.currencies.size === 0 ? 'prior_only' : org.prior.size === 0 ? 'new' : 'repeat',
        purposes: [...org.purposes.values()].map(finish).sort((a, b) => b.net_cents - a.net_cents || String(a.purpose).localeCompare(String(b.purpose))),
      }))
      .sort((a, b) => (b.totals[0]?.net_cents || 0) - (a.totals[0]?.net_cents || 0)
        || (b.prior_totals[0]?.net_cents || 0) - (a.prior_totals[0]?.net_cents || 0) || a.name.localeCompare(b.name)),
    by_member: [...members.entries()].map(([member_id, map]) => ({ member_id, totals: currencyList(map) })),
    // A gift linked to several causes appears under each; cause rows are never summed into a total.
    by_cause: [...causeTotals.values()].map(cause => ({ cause_id: cause.cause_id, label: cause.label, totals: currencyList(cause.currencies) })),
    unassigned_to_cause: live.filter(gift => inWindow(gift.paid_on, windows.current) && !giftCause.has(gift.id)).map(gift => gift.id),
    unknown_date_queue: unknownDate,
  };
}
