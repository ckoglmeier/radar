/**
 * Stage bucket helpers — single source of truth for mapping AngelList `round`
 * values into canonical stage buckets.
 *
 * Four-group model:
 *   Early  (pre-seed, seed)          — QSBS-eligible, asymmetric upside
 *   Mid    (seed-ext / Seed+, A)     — transition / growth equity
 *   Late   (Series B, C)             — shorter time-to-liquidity, DPI velocity
 *   Growth (Series D+)               — pre-IPO / near-liquidity
 */

export const STAGE_ORDER = [
  'pre-seed',
  'seed',
  'seed-ext',
  'series-a',
  'series-b',
  'series-c',
  'growth',
  'fund',
  'unknown',
];

export const BARBELL_GROUPS = {
  Early:  ['pre-seed', 'seed'],
  Mid:    ['seed-ext', 'series-a'],
  Late:   ['series-b', 'series-c'],
  Growth: ['growth'],
};

/**
 * Map a raw `round` string to a canonical stage bucket.
 */
export function roundToStageBucket(round) {
  if (!round) return 'unknown';
  const r = String(round).trim().toLowerCase().replace(/\s+/g, ' ');

  if (r === 'pre-seed' || r === 'preseed' || r === 'pre seed') return 'pre-seed';
  if (r === 'seed')                                             return 'seed';
  if (r === 'seed+')                                           return 'seed-ext';
  if (r === 'series a' || r === 'series a+')                   return 'series-a';
  if (r === 'series b' || r === 'series b+')                   return 'series-b';
  if (r === 'series c' || r === 'series c+')                   return 'series-c';
  if (
    r === 'series d'  || r === 'series d+'  ||
    r === 'series e'  || r === 'series e+'  ||
    r === 'series f'  || r === 'series f+'  ||
    r === 'growth'    || r === 'late stage' || r === 'late-stage'
  ) return 'growth';

  return 'unknown';
}

/** Which group does a stage bucket belong to? */
export function stageToBarbellGroup(stageBucket) {
  for (const [group, stages] of Object.entries(BARBELL_GROUPS)) {
    if (stages.includes(stageBucket)) return group;
  }
  return 'Unknown';
}

/** Display label for a stage bucket. */
export function stageLabel(stageBucket) {
  const labels = {
    'pre-seed':  'Pre-Seed',
    'seed':      'Seed',
    'seed-ext':  'Seed+',
    'series-a':  'Series A',
    'series-b':  'Series B',
    'series-c':  'Series C',
    'growth':    'Growth (D+)',
    'fund':      'Fund',
    'unknown':   'Unknown',
  };
  return labels[stageBucket] ?? stageBucket;
}
