// Newton-Raphson IRR solver (XIRR-equivalent).
// Takes an array of { date: Date|string, amount: number } cashflows.
// Negative = money out (investments), positive = money in (distributions, terminal value).
// Returns annualized IRR as a decimal (e.g. 0.15 = 15%) or null.

const MAX_ITER = 50;
const TOLERANCE = 1e-8;

export function calculateIRR(cashflows) {
  if (!cashflows || cashflows.length < 2) return null;

  // Normalize dates to day offsets from first cashflow
  const sorted = cashflows
    .map(cf => ({ t: new Date(cf.date).getTime(), amount: Number(cf.amount) }))
    .sort((a, b) => a.t - b.t);

  const t0 = sorted[0].t;
  const days = sorted.map(cf => (cf.t - t0) / (1000 * 60 * 60 * 24));
  const amounts = sorted.map(cf => cf.amount);

  // Need at least one negative and one positive cashflow
  const hasNeg = amounts.some(a => a < 0);
  const hasPos = amounts.some(a => a > 0);
  if (!hasNeg || !hasPos) return null;

  function npv(r) {
    let sum = 0;
    for (let i = 0; i < amounts.length; i++) {
      sum += amounts[i] / Math.pow(1 + r, days[i] / 365);
    }
    return sum;
  }

  function dnpv(r) {
    let sum = 0;
    for (let i = 0; i < amounts.length; i++) {
      const y = days[i] / 365;
      sum += -y * amounts[i] / Math.pow(1 + r, y + 1);
    }
    return sum;
  }

  let r = 0.1; // initial guess

  for (let i = 0; i < MAX_ITER; i++) {
    const f = npv(r);
    if (Math.abs(f) < TOLERANCE) return r;

    const df = dnpv(r);
    if (df === 0) return null;

    const step = f / df;
    r = r - step;

    // Divergence guard: rate below -100% is meaningless
    if (r <= -1) r = -0.99;
    if (!isFinite(r) || isNaN(r)) return null;
  }

  // Check if we converged close enough
  return Math.abs(npv(r)) < 1e-4 ? r : null;
}
