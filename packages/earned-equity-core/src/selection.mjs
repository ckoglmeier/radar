// Selection validation. No optimization; errors block, warnings inform.
import { MONEY_SCALE, parseDecimal, formatMoney } from './decimal.mjs';

const NOT_SELECTABLE = new Set(['declined', 'expired', 'withdrawn']);

export function validateSelection(input) {
  const { group, opportunities = [], offerRevisions = [], selectedOfferRevisionIds = [], results } = input ?? {};
  const errors = [];
  const warnings = [];
  const E = (path, code, message) => errors.push({ path, code, message });
  const W = (path, code, message) => warnings.push({ path, code, message });
  const oppById = new Map(opportunities.map((o) => [o.id, o]));
  const revById = new Map(offerRevisions.map((r) => [r.id, r]));
  const superseded = new Set(offerRevisions.map((r) => r.supersedesRevisionId).filter((x) => x));
  const selectedRevs = [];
  const ids = [...new Set(selectedOfferRevisionIds)];
  for (const [i, id] of ids.entries()) {
    const path = `selectedOfferRevisionIds[${i}]`;
    const rev = revById.get(id);
    if (!rev) { E(path, 'unknown_offer_revision', `Offer revision ${id} is not known.`); continue; }
    const opp = oppById.get(rev.opportunityId);
    if (!opp) { E(path, 'unknown_opportunity', `Opportunity ${rev.opportunityId} is not known.`); continue; }
    if (group && opp.groupId !== group.id) E(path, 'opportunity_wrong_group', 'Opportunity belongs to a different decision group.');
    if (superseded.has(id)) E(path, 'superseded_revision', `Offer revision ${id} has been superseded.`);
    if (NOT_SELECTABLE.has(opp.lifecycle)) E(path, 'opportunity_not_selectable', `Opportunity lifecycle is ${opp.lifecycle}.`);
    selectedRevs.push({ rev, opp });
  }
  const byOpp = new Map();
  for (const s of selectedRevs) byOpp.set(s.opp.id, [...(byOpp.get(s.opp.id) ?? []), s.rev.id]);
  for (const [oppId, revIds] of byOpp) {
    if (revIds.length > 1) E('selectedOfferRevisionIds', 'same_opportunity_revisions', `Revisions ${revIds.join(', ')} of opportunity ${oppId} are mutually exclusive.`);
  }
  const distinctOpps = [...byOpp.keys()];
  if (group?.mode === 'employment' && distinctOpps.length > 1) {
    E('selectedOfferRevisionIds', 'employment_multiple_primary', 'An employment group selects at most one opportunity.');
  }
  const cap = group?.capacity ?? {};
  if (cap.maxSelections !== null && cap.maxSelections !== undefined && distinctOpps.length > cap.maxSelections) {
    W('capacity.maxSelections', 'capacity_selection_exceeded', 'More opportunities are selected than the group allows.');
  }
  if (cap.hoursPerMonth !== null && cap.hoursPerMonth !== undefined) {
    let total = 0n;
    for (const id of distinctOpps) {
      const h = oppById.get(id).commitmentHoursPerMonth;
      if (h !== null && h !== undefined) total += parseDecimal(h, MONEY_SCALE);
    }
    if (total > parseDecimal(cap.hoursPerMonth, MONEY_SCALE)) W('capacity.hoursPerMonth', 'capacity_hours_exceeded', 'Selected commitments exceed hours per month.');
  }
  if (results && cap.exerciseFundingCapacity !== null && cap.exerciseFundingCapacity !== undefined) {
    let need = 0n;
    for (const { rev } of selectedRevs) {
      const res = results[rev.id];
      if (!res) continue;
      let worst = 0n;
      for (const s of res.scenarios) {
        if (s.maxCumulativeFundingNeed !== null) {
          const v = parseDecimal(s.maxCumulativeFundingNeed, MONEY_SCALE);
          if (v > worst) worst = v;
        }
      }
      need += worst;
    }
    if (need > parseDecimal(cap.exerciseFundingCapacity, MONEY_SCALE)) {
      W('capacity.exerciseFundingCapacity', 'exercise_funding_capacity_exceeded', `Worst-case exercise funding ${formatMoney(need)} exceeds capacity.`);
    }
  }
  if (selectedRevs.length > 1) {
    W('selectedOfferRevisionIds', 'correlated_concentration', 'More than one selection: downside outcomes may be correlated; expected values are not additive.');
  }
  return { ok: errors.length === 0, errors, warnings };
}
