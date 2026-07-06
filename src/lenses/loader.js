/**
 * Lens loader — reads a lens directory and provides accessors for all config.
 *
 * A lens is a portable analytical framework: thesis definitions, scoring rubric,
 * tagging rules, GP tiers, kill criteria, outcome distributions, and round params.
 * Stored as plain JSON/MD files in a directory. Local-first, optionally published.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve, dirname, sep } from 'path';
import { fileURLToPath } from 'url';
import { AsyncLocalStorage } from 'async_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LENSES_DIR = join(__dirname, '../../lenses');

// Singleton cache — loaded once per process
let _activeLens = null;
let _activeLensDir = null;

// Per-request lens (cloud product). Mirrors withTenant in db/index.js:
// an assembled lens object carried in AsyncLocalStorage so every accessor
// picks it up without threading it through call sites. CLI never sets this.
const lensStorage = new AsyncLocalStorage();

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

/**
 * Load a lens from a directory path.
 * Returns a unified config object with all lens components.
 */
export function loadLens(lensDir) {
  const manifest = readJson(join(lensDir, 'manifest.json'));

  // Load thesis files from theses/ subdirectory
  const thesesDir = join(lensDir, 'theses');
  const theses = [];
  if (existsSync(thesesDir)) {
    for (const file of readdirSync(thesesDir).filter(f => f.endsWith('.json')).sort()) {
      theses.push(readJson(join(thesesDir, file)));
    }
  }

  const loadOptional = (filename) => {
    const p = join(lensDir, filename);
    return existsSync(p) ? readJson(p) : null;
  };

  return {
    manifest,
    theses,
    rubric: loadOptional('rubric.json'),
    rubricSecondary: loadOptional('rubric-secondary.json'),
    taggingRules: loadOptional('tagging-rules.json'),
    gpTiers: loadOptional('gp-tiers.json'),
    killCriteria: loadOptional('kill-criteria.json'),
    distributions: loadOptional('distributions.json'),
    roundParams: loadOptional('round-params.json'),
    dir: lensDir,
  };
}

/**
 * Returns true if candidate is contained within root (equal or a direct descendant).
 * Uses resolve + sep suffix to avoid the prefix-collision bug (/foo/lenses-evil
 * passing a /foo/lenses startsWith check).
 */
function isContainedIn(candidate, root) {
  const r = resolve(root);
  const c = resolve(candidate);
  return c === r || c.startsWith(r + sep);
}

/**
 * Resolve the active lens directory.
 * Priority: project-local .radar/config.json → ~/.radar/config.json → default (_template).
 *
 * Name resolution order for bare names (e.g. "ck-conviction-era"):
 *   1. userLensesRoot (~/.radar/lenses/<name>) — user lenses win over bundled
 *   2. repoLensesRoot (<cwd>/lenses/<name>)    — bundled fallback
 */
function resolveActiveLensDir() {
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  // Legitimate lens roots — active_lens values must resolve within one of these.
  const repoLensesRoot = resolve(process.cwd(), 'lenses');
  const userLensesRoot = resolve(homeDir, '.radar', 'lenses');

  /**
   * Resolve a bare lens name to a directory path.
   * Checks userLensesRoot first (user lenses win over bundled), then repoLensesRoot.
   */
  function resolveName(name) {
    const inUser = join(homeDir, '.radar', 'lenses', name);
    if (existsSync(inUser)) return inUser;
    const inRepo = join(process.cwd(), 'lenses', name);
    if (existsSync(inRepo) && isContainedIn(inRepo, repoLensesRoot)) return inRepo;
    return null;
  }

  // Check for project-local config
  const projectConfig = join(process.cwd(), '.radar', 'config.json');
  if (existsSync(projectConfig)) {
    const config = readJson(projectConfig);
    if (config.active_lens) {
      const resolved = resolveName(config.active_lens);
      if (resolved) return resolved;
    }
  }

  // Check for user-level config
  const userConfig = join(homeDir, '.radar', 'config.json');
  if (existsSync(userConfig)) {
    const config = readJson(userConfig);
    if (config.active_lens) {
      // active_lens may be an absolute path or a bare name.
      // Absolute paths must resolve within a legitimate lens root.
      const asAbsolute = config.active_lens;
      if (existsSync(asAbsolute) &&
          (isContainedIn(asAbsolute, repoLensesRoot) || isContainedIn(asAbsolute, userLensesRoot))) {
        return resolve(asAbsolute);
      }
      const resolved = resolveName(config.active_lens);
      if (resolved) return resolved;
    }
  }

  // Default: bundled _template lens (no personal data)
  return join(LENSES_DIR, '_template');
}

/**
 * Run fn with an assembled lens active; getActiveLens() (and every accessor
 * built on it) reads it automatically. Mirrors withTenant in db/index.js.
 */
export function withLens(lens, fn) {
  return lensStorage.run(lens, fn);
}

/**
 * Get the active lens.
 * Resolution order:
 *   1. AsyncLocalStorage store (per-request hydrated lens — the cloud app)
 *   2. process singleton (CLI, cached)
 *   3. filesystem resolution (CLI fallback)
 *
 * Guard: when RADAR_LENS_SOURCE === 'db' (set in the cloud app), an unhydrated
 * call throws instead of falling back to fs/_template — sizing capital against
 * placeholder distributions is a silent-wrong-number bug. The CLI never sets it.
 */
export function getActiveLens() {
  const ctx = lensStorage.getStore();
  if (ctx) return ctx;

  if (process.env.RADAR_LENS_SOURCE === 'db') {
    throw new Error(
      'RADAR_LENS_SOURCE=db but no lens is hydrated in this context. ' +
      'Wrap this call in withLens(await loadCloudLens(files), fn) ' +
      '(via withRadar in the app). Refusing to fall back to the filesystem/_template lens.'
    );
  }

  if (!_activeLens) {
    _activeLensDir = resolveActiveLensDir();
    const templateDir = join(LENSES_DIR, '_template');
    if (resolve(_activeLensDir) === resolve(templateDir)) {
      process.stderr.write(
        'No lens configured — using the empty starter template. ' +
        'Copy lenses/_template to ~/.radar/lenses/<your-lens> and set active_lens in ~/.radar/config.json.\n'
      );
    }
    _activeLens = loadLens(_activeLensDir);
  }
  return _activeLens;
}

/** Reset cache (for testing or after install). */
export function resetLensCache() {
  _activeLens = null;
  _activeLensDir = null;
}

// ---------------------------------------------------------------------------
// Convenience accessors — drop-in replacements for hardcoded config
// ---------------------------------------------------------------------------

/**
 * Get active theses as an array of thesis objects.
 */
export function getTheses() {
  return getActiveLens().theses.filter(t => t.active);
}

/**
 * Get active thesis names (for passing to Python sidecar).
 */
export function getActiveThesisNames() {
  return getTheses().map(t => t.name);
}

/**
 * Get tagging rules in the format the importer expects:
 * [{ thesis: 'Name', markets: [...], companies: [...] }]
 */
export function getTaggingRules() {
  const lens = getActiveLens();
  if (!lens.taggingRules?.rules) return [];

  const thesisById = {};
  for (const t of lens.theses) {
    thesisById[t.id] = t.name;
  }

  return lens.taggingRules.rules.map(rule => ({
    thesis: thesisById[rule.thesis_id] || rule.thesis_id,
    markets: rule.market_patterns || [],
    companies: rule.company_patterns || [],
  }));
}

/**
 * Get outcome distributions by score band.
 * Returns object in the same shape as the old DISTRIBUTIONS constant.
 */
export function getDistributions() {
  const lens = getActiveLens();
  return lens.distributions?.bands || {};
}

/**
 * Get thesis name → cluster ID mapping.
 * Returns object like { 'AI Infrastructure & Safety': 'ai-infra', ... }
 */
export function getThesisClusters() {
  const clusters = {};
  for (const t of getActiveLens().theses) {
    clusters[t.name] = t.id;
  }
  return clusters;
}

/**
 * Get round parameters.
 * Returns { rounds: { 'pre-seed': {...}, ... }, default: {...} }
 */
export function getRoundParams() {
  const lens = getActiveLens();
  return lens.roundParams || { rounds: {}, default: { confidence: 'low', time_to_liquidity_years: 7 } };
}

/**
 * Get the rubric config.
 * @param {string} [mode] - 'secondary' for the pre-IPO/secondary trade rubric, omit for standard.
 */
export function getRubric(mode) {
  const lens = getActiveLens();
  if (mode === 'secondary') return lens.rubricSecondary || lens.rubric;
  return lens.rubric;
}

/**
 * List all available rubric modes for the active lens.
 */
export function getRubricModes() {
  const lens = getActiveLens();
  const modes = ['standard'];
  if (lens.rubricSecondary) modes.push('secondary');
  return modes;
}

/**
 * Get GP tier list.
 */
export function getGpTiers() {
  return getActiveLens().gpTiers;
}

/**
 * Get kill criteria.
 */
export function getKillCriteria() {
  return getActiveLens().killCriteria;
}

/**
 * List available lenses in the bundled lenses/ directory.
 */
export function listAvailableLenses() {
  const lenses = [];
  if (!existsSync(LENSES_DIR)) return lenses;

  for (const entry of readdirSync(LENSES_DIR)) {
    if (entry.startsWith('_')) continue;
    const manifestPath = join(LENSES_DIR, entry, 'manifest.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = readJson(manifestPath);
        lenses.push({ dir: entry, ...manifest });
      } catch { /* skip malformed */ }
    }
  }

  // Also check ~/.radar/lenses/
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  const userLensesDir = join(homeDir, '.radar', 'lenses');
  if (existsSync(userLensesDir)) {
    for (const entry of readdirSync(userLensesDir)) {
      const manifestPath = join(userLensesDir, entry, 'manifest.json');
      if (existsSync(manifestPath)) {
        try {
          const manifest = readJson(manifestPath);
          lenses.push({ dir: join(userLensesDir, entry), ...manifest });
        } catch { /* skip */ }
      }
    }
  }

  return lenses;
}
