// Duplicate and link suggestions for incoming giving evidence (pure).
//
// Suggestions only: nothing here merges records. A suggestion is "strong" only when
// the organization is the same identity (same organization id or EIN) and the amount
// matches. A match on organization name alone is always flagged for review.

export function normalizeEin(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length === 9 ? digits : null;
}

export function normalizeOrgName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(the|inc|incorporated|corp|corporation)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const DAY = 86400000;
const dayGap = (a, b) => (a && b ? Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY : null);

// candidate: {organization_id?, ein?, organization_name, amount_cents, date, kind}
// gifts: [{id, organization_id, organization_name, ein, amount_cents, paid_on, vehicle, voided}]
export function suggestGiftMatches(candidate, gifts, { windowDays = 10 } = {}) {
  const ein = normalizeEin(candidate.ein);
  const name = normalizeOrgName(candidate.organization_name);
  const suggestions = [];
  for (const gift of gifts) {
    if (gift.voided) continue;
    const sameIdentity = (candidate.organization_id && candidate.organization_id === gift.organization_id)
      || (ein && ein === normalizeEin(gift.ein));
    const sameName = !sameIdentity && name && name === normalizeOrgName(gift.organization_name);
    if (!sameIdentity && !sameName) continue;
    const amountMatches = candidate.amount_cents != null && candidate.amount_cents === gift.amount_cents;
    const gap = dayGap(candidate.date, gift.paid_on);
    const dateMatches = gap != null && gap <= windowDays;
    if (!amountMatches && !dateMatches) continue;
    const reasons = [
      sameIdentity ? 'same_organization' : 'same_name_only',
      ...(amountMatches ? ['same_amount'] : []),
      ...(dateMatches ? [`within_${Math.round(gap)}_days`] : gap == null ? ['date_unknown'] : []),
      ...(candidate.kind === 'receipt' && gift.vehicle === 'daf_grant' ? ['daf_grant_receipt_pair'] : []),
      ...(candidate.kind === 'daf_grant' && gift.vehicle !== 'daf_grant' ? ['daf_grant_receipt_pair'] : []),
    ];
    suggestions.push({
      gift_id: gift.id,
      strength: sameIdentity && amountMatches && (dateMatches || gap == null) ? 'strong' : 'possible',
      requires_review: true,
      reasons,
    });
  }
  return suggestions.sort((a, b) => (a.strength === b.strength ? 0 : a.strength === 'strong' ? -1 : 1));
}

// Groups undecided proposals that probably describe the same gift (for example a Daffy
// recommendation, approval and disbursement email). Same organization (EIN, else exact
// normalized name), same stated amount, dates within the window. An email whose amount
// could not be read joins a group only when exactly one same-organization group (or
// single proposal) with a known amount is within a few days of it. Review aid only.
// items: [{id, kind, organization_name, ein, amount_cents, date}]
export function groupLikelySameGift(items, { windowDays = 21, unknownAmountDays = 3 } = {}) {
  const candidates = items.filter(item => ['receipt', 'daf_grant', 'pledge_payment'].includes(item.kind));
  const parent = new Map(candidates.map(item => [item.id, item.id]));
  const root = id => (parent.get(id) === id ? id : root(parent.get(id)));
  const sameOrg = (a, b) => {
    const einA = normalizeEin(a.ein);
    const einB = normalizeEin(b.ein);
    if (einA && einB) return einA === einB;
    const name = normalizeOrgName(a.organization_name);
    return name !== '' && name === normalizeOrgName(b.organization_name);
  };
  const known = candidates.filter(item => item.amount_cents != null);
  for (let i = 0; i < known.length; i += 1) {
    for (let j = i + 1; j < known.length; j += 1) {
      const a = known[i];
      const b = known[j];
      if (!sameOrg(a, b) || a.amount_cents !== b.amount_cents) continue;
      const gap = dayGap(a.date, b.date);
      if (gap != null && gap > windowDays) continue;
      parent.set(root(a.id), root(b.id));
    }
  }
  for (const item of candidates.filter(entry => entry.amount_cents == null)) {
    const near = known.filter(other => sameOrg(item, other) && dayGap(item.date, other.date) != null && dayGap(item.date, other.date) <= unknownAmountDays);
    const groups = new Set(near.map(other => root(other.id)));
    if (groups.size === 1) parent.set(item.id, [...groups][0]);
  }
  const groups = new Map();
  for (const item of candidates) {
    const key = root(item.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item.id);
  }
  return [...groups.values()].filter(group => group.length > 1);
}
