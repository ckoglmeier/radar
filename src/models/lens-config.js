/**
 * Lens config writer — the cloud lens's editable distributions store.
 *
 * Distributions live as a single validated JSONB value in the one-row
 * lens_config table. Each write is a single-statement upsert (last-write-wins
 * at row granularity). See RADAR_CLOUD_LENS_ARCHITECTURE.md §5.
 */

import { query } from '../db/index.js';

// Must match the bands scoreToBand() produces (utils/bet-sizing.js). If that
// function's bands change, this set must change with it.
const REQUIRED_BANDS = ['44+', '39-43', '30-38', '<30'];

/**
 * Validate a distributions value. Rejects the whole write on any violation
 * (no partial band updates). Throws with a specific message.
 */
function validateDistributions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('distributions must be an object');
  }
  const bands = value.bands;
  if (!bands || typeof bands !== 'object' || Array.isArray(bands)) {
    throw new Error('distributions.bands must be an object');
  }

  const keys = Object.keys(bands);
  const missing = REQUIRED_BANDS.filter(b => !keys.includes(b));
  const extra = keys.filter(b => !REQUIRED_BANDS.includes(b));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `band keys must be exactly ${JSON.stringify(REQUIRED_BANDS)} ` +
      `(missing: ${JSON.stringify(missing)}, unexpected: ${JSON.stringify(extra)})`
    );
  }

  for (const band of REQUIRED_BANDS) {
    const { outcomes, probs } = bands[band] ?? {};
    if (!Array.isArray(outcomes) || !Array.isArray(probs)) {
      throw new Error(`band ${band}: outcomes and probs must both be arrays`);
    }
    if (outcomes.length !== probs.length) {
      throw new Error(
        `band ${band}: outcomes.length (${outcomes.length}) !== probs.length (${probs.length})`
      );
    }
    let sum = 0;
    for (const p of probs) {
      if (typeof p !== 'number' || Number.isNaN(p) || p < 0) {
        throw new Error(`band ${band}: probs must all be numbers >= 0, got ${JSON.stringify(p)}`);
      }
      sum += p;
    }
    if (Math.abs(sum - 1) > 1e-6) {
      throw new Error(`band ${band}: probs must sum to 1 (±1e-6), got ${sum}`);
    }
  }
}

/**
 * Save the distributions value (validated). Single-statement upsert on the
 * one-row lens_config table.
 */
export async function saveDistributions(value) {
  validateDistributions(value);
  const rows = await query(
    `INSERT INTO lens_config (id, distributions, updated_at)
     VALUES (1, $1::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET
       distributions = EXCLUDED.distributions,
       updated_at = NOW()
     RETURNING *`,
    [JSON.stringify(value)]
  );
  return rows[0];
}

/** Read the lens_config row (the hydration read). Returns null if unset. */
export async function getLensConfig() {
  const rows = await query(`SELECT * FROM lens_config WHERE id = 1`);
  return rows.length > 0 ? rows[0] : null;
}
