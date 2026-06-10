// Fuzzy company-name matching against the investments table.
// Goal: link a pipeline_invite, transaction, or deal evaluation to an existing
// investment if the user already invested in that company.
//
// All normalization, tokenization, and stopword logic lives in
// ./company-names.js — keep it there so a tweak in one place fixes
// false-positives across every caller.

import { query } from '../db/index.js';
import { normalize, tokenize, STOPWORDS } from './company-names.js';

/**
 * Load the investments universe once. Pass the result to matchCompanyToInvestment
 * via `{ universe }` to avoid a SELECT per call when batching hundreds of matches.
 *
 * ORDER BY id is intentional: when two investments share a normalized name
 * (same company, multiple invest_dates), the matcher picks the lowest id —
 * stable across runs and biased toward the earliest record.
 */
export async function loadInvestmentUniverse() {
  return query(`SELECT id, company_name FROM investments ORDER BY id`);
}

// Returns { investment_id, confidence } or { investment_id: null, confidence: 'unmatched' }
//
// Pass `{ universe }` to skip the per-call SELECT — `universe` is an array of
// { id, company_name } rows produced by `loadInvestmentUniverse()`. Used by
// batch ingesters to amortize the load across many matches.
export async function matchCompanyToInvestment(companyName, { universe } = {}) {
  if (!companyName) return { investment_id: null, confidence: 'unmatched' };

  const norm = normalize(companyName);
  if (!norm) return { investment_id: null, confidence: 'unmatched' };

  // Try exact normalized match first
  const all = universe || await query(`SELECT id, company_name FROM investments`);
  const exact = all.find(r => normalize(r.company_name) === norm);
  if (exact) return { investment_id: exact.id, confidence: 'exact' };

  // Discriminating-token match (e.g. "NovaStar" in a pipeline invite matches
  // "NovaStar Energy Systems" in the portfolio via shared discriminating token).
  // Stopwords are filtered out so generic words can't carry a match by themselves.
  const tokens = tokenize(norm);
  if (tokens.length === 0) return { investment_id: null, confidence: 'unmatched' };

  const candidates = all
    .map(r => ({ id: r.id, name: r.company_name, normName: normalize(r.company_name) }))
    .filter(r => {
      const rTokens = r.normName.split(/\s+/).filter(t => !STOPWORDS.has(t));
      return tokens.some(t => rTokens.includes(t));
    });

  if (candidates.length === 1) return { investment_id: candidates[0].id, confidence: 'token' };
  if (candidates.length > 1) return { investment_id: null, confidence: 'ambiguous' };
  return { investment_id: null, confidence: 'unmatched' };
}
