// Reading provenance-carrying facts. Unknown is null plus a limitation, never zero.
const USABLE = new Set(['confirmed_by_user', 'supported_by_document', 'user_reported']);

/**
 * @returns {{ value: any, limitations: string[] }} value is null when unusable.
 */
export function readFact(fact, name, opts = {}) {
  if (!fact || typeof fact !== 'object') return { value: null, limitations: [`${name}_missing`] };
  // Researched, unconfirmed values may feed relative metrics only when the caller opts in.
  if (fact.state === 'researched_unconfirmed') {
    if (opts.allowResearched && fact.value !== null && fact.value !== undefined) return { value: fact.value, limitations: [`researched_value:${name}`] };
    return { value: null, limitations: [`researched_value:${name}`] };
  }
  if (fact.state === 'illustrative') return { value: null, limitations: [`illustrative_value_ignored:${name}`] };
  if (fact.state === 'conflicting') return { value: null, limitations: [`${name}_conflicting`] };
  if (!USABLE.has(fact.state) || fact.value === null || fact.value === undefined) {
    return { value: null, limitations: [`${name}_missing`] };
  }
  return { value: fact.value, limitations: [] };
}
