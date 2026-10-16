// DAF planning is a scenario, never a valuation or a paid gift.
import { assertDate, GivingError } from './report.js';
import { localToday } from '../utils/date-only.js';
const fail = (message, field) => { throw new GivingError(message, field); };
function money(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${field} must be non-negative whole cents.`, field);
  return value;
}
function text(value, field, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) fail(`Enter a valid ${field}.`, field);
  return value.trim();
}
export function validateDafBalance(input, { today = localToday() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Enter a Daffy balance.', 'balance');
  assertDate(input.as_of, 'as_of');
  if (input.as_of > today) fail('A balance cannot be dated in the future.', 'as_of');
  if (!['daffy_api', 'manual'].includes(input.source)) fail('Choose a balance source.', 'source');
  if (input.currency !== 'USD') fail('Daffy balances must be in USD.', 'currency');
  const result = {
    account_ref: text(input.account_ref, 'account reference', 128),
    account_name: text(input.account_name, 'fund name', 160),
    provider: 'daffy', currency: 'USD', source: input.source, as_of: input.as_of,
    total_cents: money(input.total_cents, 'total_cents'),
    available_cents: money(input.available_cents, 'available_cents'),
    invested_cents: input.invested_cents == null ? null : money(input.invested_cents, 'invested_cents'),
    pending_cents: input.pending_cents == null ? null : money(input.pending_cents, 'pending_cents'),
  };
  if (result.available_cents > result.total_cents) fail('Available balance cannot exceed the total balance.', 'available_cents');
  return result;
}
export function validateDafPlan(input) {
  if (!input || typeof input !== 'object') fail('Enter planning assumptions.', 'assumptions');
  const { years, annual_giving_cents, annual_contribution_cents, net_return_bps, giving_growth_bps } = input;
  if (!Number.isInteger(years) || years < 1 || years > 50) fail('Choose a horizon from 1 to 50 years.', 'years');
  for (const [field, value, min, max] of [['net_return_bps', net_return_bps, -10000, 2000], ['giving_growth_bps', giving_growth_bps, 0, 2000]]) {
    if (!Number.isInteger(value) || value < min || value > max) fail(`${field} is outside the supported scenario range.`, field);
  }
  return { years, annual_giving_cents: money(annual_giving_cents, 'annual_giving_cents'), annual_contribution_cents: money(annual_contribution_cents, 'annual_contribution_cents'), net_return_bps, giving_growth_bps };
}
function grow(cents, bps) {
  const result = (BigInt(cents) * BigInt(10000 + bps) + 5000n) / 10000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) fail('The scenario exceeds the supported money range.', 'scenario');
  return Number(result);
}
// Contributions and grants at the start of each planning year, net growth after.
// The source balance already reflects prior gifts/contributions. Never subtract
// historical gift records again. Pending deposits are not spendable starting funds.
export function projectDafPlan(balance, input) {
  const assumptions = validateDafPlan(input);
  let opening = money(balance.available_cents, 'available_cents');
  let giving = assumptions.annual_giving_cents;
  let totalGiving = 0, totalShortfall = 0, firstShortfallYear = null;
  const rows = [];
  for (let year = 1; year <= assumptions.years; year++) {
    const available = money(opening + assumptions.annual_contribution_cents, 'scenario funds');
    const granted = Math.min(available, giving);
    const shortfall = giving - granted;
    const ending = grow(available - granted, assumptions.net_return_bps);
    totalGiving = money(totalGiving + granted, 'total grants');
    totalShortfall = money(totalShortfall + shortfall, 'total shortfall');
    if (shortfall && firstShortfallYear == null) firstShortfallYear = year;
    rows.push({ year, opening_cents: opening, contribution_cents: assumptions.annual_contribution_cents, requested_giving_cents: giving, granted_cents: granted, shortfall_cents: shortfall, ending_cents: ending });
    opening = ending;
    if (year < assumptions.years) giving = grow(giving, assumptions.giving_growth_bps);
  }
  return { assumptions, starting_available_cents: balance.available_cents, ending_cents: opening, total_grants_cents: totalGiving, total_shortfall_cents: totalShortfall, first_shortfall_year: firstShortfallYear, rows };
}
