// Side-by-side comparison. Deliberately returns no composite score, ordering or winner.
import { MONEY_SCALE, formatPerShare, parseDecimal } from './decimal.mjs';
import { sortedUnique } from './canonical-json.mjs';

const KIND_ORDER = ['failure', 'no_liquidity', 'downside', 'base', 'upside', 'custom'];
const UNRESOLVED_RE = /(_missing$|_conflicting$|_unknown$|_unmodeled$|^instrument_unsupported:|^vesting_unsupported$|^illustrative_value_ignored:|^weights_|^expected_value_unavailable$|^no_solution$|^exercise_cost_unknown$|^acceleration_)/;

export const COMPARISON_NOTES = Object.freeze([
  'Scenario kinds are case definitions, not likelihoods; a base case is not assumed equally likely across offers.',
  'Company-specific scenarios may assume different company outcomes.',
  'Missing material inputs prevent a definitive comparison; known differences are shown as-is.',
]);

const BASIS_FIELDS = ['currency', 'startDate', 'horizonMonths', 'discountRateAnnual'];

export function compareOffers(input) {
  try {
    return compareOffersUnsafe(input);
  } catch (e) {
    return { ok: false, errors: [{ path: '', code: 'invalid_input', message: String(e?.message ?? e) }] };
  }
}

function compareOffersUnsafe(input) {
  const { group, entries } = input ?? {};
  const errors = [];
  if (!group || typeof group !== 'object' || !Array.isArray(entries) || entries.length === 0) {
    return { ok: false, errors: [{ path: '', code: 'missing_input', message: 'group and at least one entry are required.' }] };
  }
  entries.forEach((e, i) => {
    const r = e?.result;
    if (!e || !e.offerRevision || !r || !Array.isArray(r.scenarios) || !Array.isArray(r.limitations) || !r.basis || typeof r.basis !== 'object') {
      errors.push({ path: `entries[${i}]`, code: 'invalid_entry', message: 'Entry needs offerRevision and a successful result with scenarios, limitations and basis.' });
      return;
    }
    for (const f of BASIS_FIELDS) {
      if (r.basis[f] !== group[f]) errors.push({ path: `entries[${i}].result.basis.${f}`, code: 'comparison_basis_mismatch', message: `Result ${f} differs from the group.` });
      if (e.group && e.group[f] !== group[f]) errors.push({ path: `entries[${i}].group.${f}`, code: 'comparison_basis_mismatch', message: `Entry ${f} differs from the comparison basis.` });
    }
    if (r.currency !== group.currency) errors.push({ path: `entries[${i}].result.currency`, code: 'comparison_basis_mismatch', message: 'Entry result currency differs from the comparison basis.' });
    if (e.offerRevision.currency !== group.currency) errors.push({ path: `entries[${i}].offerRevision.currency`, code: 'comparison_basis_mismatch', message: 'Entry offer currency differs from the comparison basis.' });
  });
  if (errors.length) return { ok: false, errors };

  const rowsByKind = new Map();
  const unresolved = [];
  const offers = [];
  for (const e of entries) {
    const opportunityId = e.opportunity?.id ?? e.offerRevision.opportunityId;
    const offerRevisionId = e.offerRevision.id;
    const companyName = e.opportunity?.companyName ?? null;
    offers.push({ opportunityId, offerRevisionId, companyName, weighted: e.result.weighted, limitations: e.result.limitations });
    for (const code of e.result.limitations) if (UNRESOLVED_RE.test(code)) unresolved.push({ opportunityId, offerRevisionId, code });
    for (const sc of e.result.scenarios) {
      if (sc.netPreTax === null) unresolved.push({ opportunityId, offerRevisionId, code: `net_pre_tax_unavailable:${sc.scenarioId}` });
      if (!rowsByKind.has(sc.kind)) rowsByKind.set(sc.kind, []);
      rowsByKind.get(sc.kind).push({
        opportunityId, offerRevisionId, companyName, scenarioId: sc.scenarioId, label: sc.label,
        cashSacrifice: sc.cash.totalCashDifference,
        netPreTax: sc.netPreTax,
        maxCumulativeFundingNeed: sc.maxCumulativeFundingNeed,
        breakEvenCommonPrice: sc.breakEvenCommonPrice,
        limitations: sc.limitations,
      });
    }
  }
  const rows = KIND_ORDER.filter((k) => rowsByKind.has(k)).map((kind) => ({ kind, offers: rowsByKind.get(kind) }));
  const crossovers = [];
  for (const row of rows) {
    for (let i = 0; i < row.offers.length; i += 1) {
      for (let j = i + 1; j < row.offers.length; j += 1) {
        const a = row.offers[i];
        const b = row.offers[j];
        if (a.offerRevisionId === b.offerRevisionId) continue;
        if (a.breakEvenCommonPrice === null || b.breakEvenCommonPrice === null) continue;
        const diff = parseDecimal(b.breakEvenCommonPrice, MONEY_SCALE) - parseDecimal(a.breakEvenCommonPrice, MONEY_SCALE);
        crossovers.push({
          kind: row.kind,
          a: { offerRevisionId: a.offerRevisionId, scenarioId: a.scenarioId, breakEvenCommonPrice: a.breakEvenCommonPrice },
          b: { offerRevisionId: b.offerRevisionId, scenarioId: b.scenarioId, breakEvenCommonPrice: b.breakEvenCommonPrice },
          breakEvenDifference: formatPerShare(diff),
        });
      }
    }
  }
  const seen = new Set();
  const uniq = unresolved.filter((u) => { const k = `${u.offerRevisionId}|${u.code}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((x, y) => (`${x.offerRevisionId}|${x.code}` < `${y.offerRevisionId}|${y.code}` ? -1 : 1));
  return {
    ok: true,
    comparison: {
      currency: group.currency, startDate: group.startDate, horizonMonths: group.horizonMonths, discountRateAnnual: group.discountRateAnnual,
      offers, rows, crossovers, unresolved: uniq, notes: [...COMPARISON_NOTES],
      limitations: sortedUnique(offers.flatMap((o) => o.limitations)),
    },
  };
}
