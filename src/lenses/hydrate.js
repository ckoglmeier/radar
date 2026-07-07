/**
 * Lens hydration — assembles the same unified lens object loadLens() produces,
 * from three cloud sources: read-only JSON files (bundled), thesis rows (from
 * the theses table), and the distributions value (from lens_config).
 *
 * The accessors in loader.js are synchronous and called deep inside sync math
 * (the Kelly solver reads getDistributions() mid-solve), so the lens must be
 * fully assembled before report code runs. loadCloudLens() does the two async
 * queries; assembleLens() is pure. See RADAR_CLOUD_LENS_ARCHITECTURE.md §4.
 */

import { query } from '../db/index.js';

/**
 * Map one DB thesis row onto the file-shaped thesis object loadLens() yields.
 *   id            ← lens_thesis_id (the stable slug; tagging-rules.json keys on it)
 *   qualifications/exclusions come back as arrays (JSONB), default []
 *   portfolio_examples is a file-lens artifact — always [] in the cloud (spec §2a)
 */
function rowToThesis(row) {
  return {
    id: row.lens_thesis_id,
    name: row.name,
    belief: row.belief ?? null,
    proves_true: row.proves_true ?? null,
    proves_false: row.proves_false ?? null,
    open_question: row.open_question ?? null,
    conviction_now: row.conviction_now ?? null,
    conviction_entry: row.conviction_entry ?? null,
    qualifications: row.qualifications ?? [],
    exclusions: row.exclusions ?? [],
    conviction_signal: row.conviction_signal ?? null,
    portfolio_examples: [],
    active: row.active,
  };
}

/**
 * Assemble the unified lens object from its three sources.
 *
 * @param {object} sources
 * @param {object} sources.files   - { manifest, rubric, rubricSecondary, taggingRules,
 *                                      gpTiers, killCriteria, roundParams } (bundled JSON)
 * @param {Array}  sources.theses  - rows from the theses table
 * @param {object} sources.distributions - the lens_config.distributions JSONB value
 * @returns the exact shape loadLens() returns (dir: null in the cloud).
 */
export function assembleLens({ files, theses, distributions }) {
  return {
    manifest: files.manifest,
    theses: (theses || []).map(rowToThesis),
    rubric: files.rubric ?? null,
    rubricSecondary: files.rubricSecondary ?? null,
    taggingRules: files.taggingRules ?? null,
    gpTiers: files.gpTiers ?? null,
    killCriteria: files.killCriteria ?? null,
    distributions: distributions ?? null,
    roundParams: files.roundParams ?? null,
    dir: null,
  };
}

/**
 * Load a cloud lens: run the two queries (thesis rows + lens_config), then
 * assemble with the bundled read-only files. Runs inside withTenant so query()
 * hits the tenant's database.
 */
export async function loadCloudLens(files) {
  const theses = await query(
    `SELECT id, name, active, lens_thesis_id, belief, proves_true, proves_false,
            open_question, conviction_now, conviction_entry, qualifications,
            exclusions, conviction_signal
       FROM theses
      ORDER BY id`
  );

  const configRows = await query(`SELECT distributions FROM lens_config WHERE id = 1`);
  const distributions = configRows.length > 0 ? configRows[0].distributions : null;

  // Empty-lens guard. An empty-but-hydrated lens (unseeded or wrong DB) must
  // fail loudly here — otherwise it sails past the RADAR_LENS_SOURCE=db check
  // in getActiveLens() (a hydrated lens IS present in ALS) and feeds empty
  // theses / null distributions to the Kelly solver, producing silent wrong
  // numbers — the exact failure the guard exists to prevent.
  // See RADAR_CLOUD_LENS_ARCHITECTURE.md §9 risk 1 and REVIEW-FINDINGS P0.2(b).
  if (!theses || theses.length === 0) {
    throw new Error(
      'loadCloudLens: theses table returned zero rows. The lens is not seeded ' +
      '(or DATABASE_URL points at the wrong database). Run src/db/seed-lens.js. ' +
      'Refusing to hydrate an empty lens.'
    );
  }
  if (distributions == null) {
    throw new Error(
      'loadCloudLens: lens_config.distributions is missing (no row id=1, or a ' +
      'null value). The lens is not seeded (or DATABASE_URL points at the wrong ' +
      'database). Run src/db/seed-lens.js. Refusing to size capital against ' +
      'empty distributions.'
    );
  }

  return assembleLens({ files, theses, distributions });
}
