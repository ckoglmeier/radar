// Single source of truth for company-name normalization, tokenization, and
// stopwords. All matchers — investments, pipeline invites, deal evaluations,
// transactions ledger — should import from here so a stopword tweak in one
// place fixes false-positives everywhere.
//
// History note: stopword sets were previously scattered across match.js,
// models/evaluations.js, and import/transactions.js. The Marketplace Holding
// Company → Company Six Robotics false-positive came from "company" being a
// stopword in one file but not another. Don't bring back the divergence.

// Suffixes that say "this is a corporate entity" and contribute nothing to
// identifying the actual company. Stripped before tokenizing.
export const STRIP_SUFFIXES = /\b(inc\.?|llc|ltd\.?|corp\.?|corporation|company|holdings?|holding|gmbh|sa|ag|pbc|pte|the)\b/gi;

// Parenthetical content (e.g., "(YC W25)", "(formerly Foo)") is noise.
export const PARENTHETICAL = /\([^)]*\)/g;

// Generic / industry words that should never serve as the sole basis for a
// token match. e.g., "Marketplace Holding Company" must NOT match "Company Six
// Robotics" via "company"; "Foo Robotics" must NOT match "Bar Robotics" via
// "robotics". YC batch labels (w25, s26, …) are noise from parenthetical
// remnants.
export const STOPWORDS = new Set([
  // Tech / industry generics
  'ai', 'io', 'co', 'labs', 'tech', 'technologies', 'technology', 'systems',
  'health', 'bio', 'data', 'app', 'api', 'digital', 'cloud', 'group', 'global',
  'platform', 'network', 'services', 'solutions', 'software', 'studio',
  'robotics', 'robotic', 'space', 'marketplace',
  // Investment-vehicle words
  'ventures', 'capital', 'partners', 'spv', 'fund', 'access',
  // Cash-flow description noise
  'proceeds', 'distribution',
  // YC batch labels (residue from parenthetical strip)
  'yc', 'w24', 'w25', 'w26', 's24', 's25', 's26',
]);

/**
 * Lowercase, drop parenthetical content, strip corporate suffixes, collapse
 * non-alphanumerics to spaces. The output is suitable for both equality
 * comparisons (`normalize(a) === normalize(b)`) and tokenization.
 */
export function normalize(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(PARENTHETICAL, ' ')
    .replace(STRIP_SUFFIXES, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Split a normalized name into discriminating tokens: length >= 3 and not in
 * STOPWORDS. Returns an empty array if nothing useful is left.
 */
export function tokenize(normName) {
  if (!normName) return [];
  return normName.split(/\s+/).filter(t => t.length >= 3 && !STOPWORDS.has(t));
}
