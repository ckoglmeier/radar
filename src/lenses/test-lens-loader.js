/**
 * Lens loader verification — self-contained, machine-independent.
 *
 * Creates a temp directory, writes a complete synthetic fixture lens into it,
 * chdir()s into the temp dir (so loader picks up .radar/config.json locally),
 * runs all assertions against the fixture, then restores cwd and cleans up.
 *
 * No references to ~/.radar, no real calibration numbers, no real GP names.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import os from 'os';
import {
  getActiveLens, getTaggingRules, getDistributions,
  getThesisClusters, getRoundParams, getActiveThesisNames,
  getRubric, getGpTiers, getKillCriteria, resetLensCache, withLens,
} from './loader.js';
import { runAnalytics } from '../utils/analytics.js';

// ---------------------------------------------------------------------------
// Fixture data — ALL expected values are defined here once and written as JSON.
// Constants and JSON files are derived from the same source so they can't drift.
// ---------------------------------------------------------------------------

const FIXTURE_NAME = 'zz-test-fixture-lens';

// --- Theses (4, all active) ---
const FIXTURE_THESES = [
  {
    id: 'zz-alpha',
    name: 'Alpha: Software Infrastructure',
    belief: 'Infrastructure compounds. Applications fragment.',
    qualifications: ['Developer tooling', 'Data pipelines', 'Security automation'],
    exclusions: ['Thin wrappers', 'Feature-only products'],
    portfolio_examples: [{ name: 'Voltaic AI', check: 5000, note: 'core infra' }],
    conviction_signal: 'Substrate all apps depend on.',
    active: true,
  },
  {
    id: 'zz-beta',
    name: 'Beta: Physical World Repricing',
    belief: 'Physics-based moats outlast software advantages.',
    qualifications: ['Novel hardware', 'Robotics with unit economics', 'Energy materials'],
    exclusions: ['Software-only "deep tech"', 'Science projects without commercial thesis'],
    portfolio_examples: [{ name: 'Ironclad Defense', check: 5000, note: 'novel propulsion' }],
    conviction_signal: 'Engineering breakthrough reprices a cost curve.',
    active: true,
  },
  {
    id: 'zz-gamma',
    name: 'Gamma: Autonomous Physical Systems',
    belief: 'Intelligence embedded in hardware creates durable operational advantage.',
    qualifications: ['Autonomous logistics', 'Smart agriculture', 'Precision navigation'],
    exclusions: ['Pure software routing', 'Marketplace models without proprietary data'],
    portfolio_examples: [{ name: 'FloraHive', check: 5000, note: 'smart ag' }],
    conviction_signal: 'Hardware + ML feedback loop tightens with deployment.',
    active: true,
  },
  {
    id: 'zz-delta',
    name: 'Delta: Resilient Human Systems',
    belief: 'Systems that serve humans in high-stakes contexts become structurally embedded.',
    qualifications: ['Workforce infrastructure', 'Healthcare delivery', 'Education platforms'],
    exclusions: ['Pure HR SaaS without retention data', 'Consumer wellness with no clinical anchor'],
    portfolio_examples: [{ name: 'Curriculr', check: 5000, note: 'education platform' }],
    conviction_signal: 'Mission-critical workflow creates switching cost.',
    active: true,
  },
];

// --- Tagging rules (one per thesis, keyed by thesis_id) ---
// Company names are intentionally reused from prior synthetic fixtures.
const FIXTURE_TAGGING_RULES_JSON = {
  rules: [
    {
      thesis_id: 'zz-alpha',
      market_patterns: ['AI / ML'],
      company_patterns: [
        'Voltaic AI', 'Axiom Intelligence', 'Veritest Labs', 'Gridlock AI',
        'Fluency.ai', 'Lexara', 'Novu', 'Cedarwood.ai', 'PXTC',
        'CodePulse', 'Relay Teams', 'StreamFlow',
      ],
    },
    {
      thesis_id: 'zz-beta',
      market_patterns: ['Aerospace', 'Cleantech', 'Hardware', 'Drones', 'Robotics', 'Biotech', 'Transportation'],
      company_patterns: [
        'Ironclad Defense', 'OrbitalFling', 'Polaris Propulsion', 'Pelagic Fusion',
        'Helion Fusion', 'Mach Industries', 'Neutron Semi', 'Apex Supersonic',
        'Minimal Compute', 'Abyss Marine', 'Leonidas Systems', 'Artemis SpaceWorks',
        'Electron Era', 'Titan Bio', 'Lynx', 'Lattice', 'Vertex Seven',
        'Caduceus Robotics', 'AeroShield', 'Vanguard Systems', 'ResearchIO',
        'Pathogen Guard',
      ],
    },
    {
      thesis_id: 'zz-gamma',
      market_patterns: ['Logistics'],
      company_patterns: [
        'Vanguard Systems', 'HelmPath', 'FloraHive', 'UniRail', 'ClearGate',
        'FillUp', 'Haulo', 'SkyPlant', 'Pioneer.ai', 'Nanocraft',
        'Vizulex', 'CANOPY', 'EinsteinX',
      ],
    },
    {
      thesis_id: 'zz-delta',
      market_patterns: ['HR & Recruiting', 'Education', 'Healthcare', 'Health'],
      company_patterns: [
        'Curriculr', 'LearnForge', 'pelican', 'Open Roster', 'Anchored',
        'Frontline Jobs', 'Payflow', 'Serenity Health', 'Sturdent Health',
        'Bold Care', 'Molar Magic', 'Kiwi', 'Eos Health',
      ],
    },
  ],
};

// Expected tagging rules shape after getTaggingRules() processes the above
// (thesis_id → thesis name resolved via theses array).
const EXPECTED_TAGGING_RULES = FIXTURE_TAGGING_RULES_JSON.rules.map((rule, i) => ({
  thesis: FIXTURE_THESES[i].name,
  markets: rule.market_patterns,
  companies: rule.company_patterns,
}));

// --- Distributions (invented probs, all sum to 1.0, different from template defaults) ---
const FIXTURE_DISTRIBUTIONS_JSON = {
  calibration_date: '2099-01-01',
  calibration_source: 'Synthetic fixture — no real calibration data',
  bands: {
    '44+': {
      outcomes: [0.0, 0.5, 1.0, 3.0, 10.0, 30.0, 100.0],
      probs:    [0.25, 0.10, 0.15, 0.20, 0.15, 0.10, 0.05],
    },
    '39-43': {
      outcomes: [0.0, 0.5, 1.0, 3.0, 10.0, 30.0, 100.0],
      probs:    [0.30, 0.12, 0.18, 0.18, 0.12, 0.07, 0.03],
    },
    '30-38': {
      outcomes: [0.0, 0.5, 1.0, 3.0, 10.0, 30.0],
      probs:    [0.25, 0.20, 0.35, 0.12, 0.06, 0.02],
    },
    '<30': {
      outcomes: [0.0, 0.5, 1.0, 3.0, 10.0],
      probs:    [0.45, 0.25, 0.22, 0.06, 0.02],
    },
  },
};

// --- Round params (same structure as template, slightly different values) ---
const FIXTURE_ROUND_PARAMS_JSON = {
  rounds: {
    'pre-seed': { confidence: 'very_low', time_to_liquidity_years: 10 },
    'seed':     { confidence: 'low',      time_to_liquidity_years: 8  },
    'series a': { confidence: 'low',      time_to_liquidity_years: 6  },
    'series b': { confidence: 'medium',   time_to_liquidity_years: 5  },
    'series c': { confidence: 'medium',   time_to_liquidity_years: 3  },
    'series d': { confidence: 'high',     time_to_liquidity_years: 2  },
    'secondary': { confidence: 'high',    time_to_liquidity_years: 1  },
  },
  default: { confidence: 'low', time_to_liquidity_years: 7 },
};

// --- Rubric (total_points=50, 2 sections, 9 dimensions, 4 verdict bands) ---
// Matches _template shape so assertion counts hold.
const FIXTURE_RUBRIC_JSON = {
  total_points: 50,
  sections: [
    {
      name: 'Thesis Fit',
      weight_pct: 50,
      max_points: 25,
      dimensions: [
        {
          name: 'Domain match',
          weight_pct: 15,
          scale: [1, 5],
          anchors: { '1': 'No thesis match', '3': 'Adjacent', '5': 'Core thesis' },
        },
        {
          name: 'Compounding structure',
          weight_pct: 15,
          scale: [1, 5],
          anchors: { '1': 'Linear', '3': 'Some retention', '5': 'Clear flywheel' },
        },
        {
          name: 'Structural tailwind',
          weight_pct: 10,
          scale: [1, 5],
          anchors: { '1': 'Unclear timing', '3': 'Cyclical tailwind', '5': 'Durable multi-year shift' },
        },
        {
          name: 'Portfolio construction fit',
          weight_pct: 10,
          scale: [1, 5],
          anchors: { '1': 'Duplicates exposure', '3': 'Neutral', '5': 'Fills gap' },
        },
      ],
    },
    {
      name: 'Viability',
      weight_pct: 50,
      max_points: 25,
      dimensions: [
        {
          name: 'Team-market fit',
          weight_pct: 15,
          scale: [1, 5],
          anchors: { '1': 'Generic team', '3': 'Relevant but gaps', '5': 'Obvious why this team' },
        },
        {
          name: 'Capital efficiency',
          weight_pct: 10,
          scale: [1, 5],
          anchors: { '1': 'Needs $50M+ before proof', '3': 'Reasonable burn', '5': 'Lean path' },
        },
        {
          name: 'Business model clarity',
          weight_pct: 10,
          scale: [1, 5],
          anchors: { '1': 'No model', '3': 'Model exists, unproven', '5': 'Legible + early signals' },
        },
        {
          name: 'Differentiation',
          weight_pct: 10,
          scale: [1, 5],
          anchors: { '1': 'Feature lead only', '3': 'Some defensibility', '5': 'Hard-to-replicate' },
        },
        {
          name: 'Source quality',
          weight_pct: 5,
          scale: [1, 5],
          anchors: { '1': 'Cold inbound', '3': 'Known GP', '5': 'Tier 1 GP lead' },
        },
      ],
    },
  ],
  verdict_bands: [
    { range: [40, 50], verdict: 'Strong fit',      response_type: 'Warm interest' },
    { range: [30, 39], verdict: 'Worth exploring', response_type: 'Request more info' },
    { range: [20, 29], verdict: 'Likely pass',     response_type: 'Polite pass' },
    { range: [0, 19],  verdict: 'Clear pass',      response_type: 'Quick pass' },
  ],
};

// --- GP tiers (3 tiers, 3 direct — all synthetic names) ---
const FIXTURE_GP_TIERS_JSON = {
  tiers: [
    {
      tier: 1,
      label: 'Primary deal flow, highest trust',
      gps: [
        { name: 'Synthetic Syndicate Alpha', deals: 10, notes: 'Fixture GP — not a real fund' },
        { name: 'Synthetic Ventures Beta',   deals: 7,  notes: 'Fixture GP — not a real fund' },
      ],
    },
    {
      tier: 2,
      label: 'Consistent, proven',
      gps: [
        { name: 'Synthetic Partners Gamma', deals: 5 },
        { name: 'Synthetic Scout Delta',    deals: 4 },
      ],
    },
    {
      tier: 3,
      label: 'Selective, earlier relationship',
      gps: [
        { name: 'Synthetic Micro-VC Epsilon', deals: 2 },
      ],
    },
  ],
  direct: [
    { name: 'Synthetic Direct Co A', total: 5000,  notes: 'Fixture direct — not real' },
    { name: 'Synthetic Direct Co B', total: 10000, notes: 'Fixture direct — not real' },
    { name: 'Synthetic Direct Co C', total: 7500,  notes: 'Fixture direct — not real' },
  ],
};

// --- Kill criteria (4 automatic_pass, 4 structural_flags) ---
const FIXTURE_KILL_CRITERIA_JSON = {
  automatic_pass: [
    { label: 'Consumer social with no engagement moat', reason: 'Commoditized category' },
    { label: 'Crypto without protocol utility',         reason: 'Speculation only, no structural value' },
    { label: 'Pre-revenue at Series B+ valuation',      reason: 'Capital efficiency impossible' },
    { label: 'Regulated markets without compliance plan', reason: 'Execution risk exceeds return profile' },
  ],
  structural_flags: [
    { label: 'Valuation above $300M at pre-seed',   impact: 'lower_score', reason: 'Entry price kills return math' },
    { label: 'No domain experience on founding team', impact: 'lower_score' },
    { label: 'Business model requires regulatory change', impact: 'lower_score' },
    { label: 'Single customer concentration >60%',   impact: 'lower_score', reason: 'Pipeline risk' },
  ],
  notes: 'Fixture kill criteria — all synthetic.',
};

// ---------------------------------------------------------------------------
// Assertions helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    failed++;
  }
}

function assertDeepEqual(actual, expected, name) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    expected: ${e.slice(0, 200)}`);
    console.log(`    actual:   ${a.slice(0, 200)}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Build the fixture lens in a temp directory
// ---------------------------------------------------------------------------

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

const originalCwd = process.cwd();
const tempDir = mkdtempSync(join(os.tmpdir(), 'lens-test-'));

try {
  // Directory structure:
  //   <tempDir>/.radar/config.json          → activates fixture lens by name
  //   <tempDir>/lenses/zz-test-fixture-lens/
  //     manifest.json, tagging-rules.json, distributions.json,
  //     round-params.json, rubric.json, gp-tiers.json, kill-criteria.json
  //     theses/zz-alpha.json ... zz-delta.json

  const radarDir      = join(tempDir, '.radar');
  const lensesDir     = join(tempDir, 'lenses');
  const lensDir       = join(lensesDir, FIXTURE_NAME);
  const thesesDir     = join(lensDir, 'theses');

  for (const d of [radarDir, lensesDir, lensDir, thesesDir]) {
    mkdirSync(d, { recursive: true });
  }

  // .radar/config.json
  writeJson(join(radarDir, 'config.json'), { active_lens: FIXTURE_NAME });

  // manifest.json
  writeJson(join(lensDir, 'manifest.json'), {
    name: FIXTURE_NAME,
    version: '0.1.0',
    description: 'Synthetic fixture lens for automated tests — contains no real data',
    author: { name: 'Test Fixture', handle: 'fixture' },
    license: 'MIT',
    price_tier: 'free',
    radar_version_min: '1.0.0',
    thesis_count: FIXTURE_THESES.length,
    created: '2099-01-01',
    updated: '2099-01-01',
    tags: ['test', 'fixture'],
  });

  // theses/*.json — one file per thesis, sorted filenames match FIXTURE_THESES order
  for (const thesis of FIXTURE_THESES) {
    writeJson(join(thesesDir, `${thesis.id}.json`), thesis);
  }

  // tagging-rules.json
  writeJson(join(lensDir, 'tagging-rules.json'), FIXTURE_TAGGING_RULES_JSON);

  // distributions.json
  writeJson(join(lensDir, 'distributions.json'), FIXTURE_DISTRIBUTIONS_JSON);

  // round-params.json
  writeJson(join(lensDir, 'round-params.json'), FIXTURE_ROUND_PARAMS_JSON);

  // rubric.json
  writeJson(join(lensDir, 'rubric.json'), FIXTURE_RUBRIC_JSON);

  // gp-tiers.json
  writeJson(join(lensDir, 'gp-tiers.json'), FIXTURE_GP_TIERS_JSON);

  // kill-criteria.json
  writeJson(join(lensDir, 'kill-criteria.json'), FIXTURE_KILL_CRITERIA_JSON);

  // ---------------------------------------------------------------------------
  // Activate fixture: chdir + clear singleton cache
  // ---------------------------------------------------------------------------

  process.chdir(tempDir);
  resetLensCache();

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  console.log('\n  Lens loader tests\n');

  // 1. Active lens loads
  const lens = getActiveLens();
  assert(lens !== null, 'getActiveLens() returns a lens');
  assert(lens.manifest.name === FIXTURE_NAME, `active lens is ${FIXTURE_NAME}`);
  assert(lens.manifest.version === '0.1.0', 'version is 0.1.0');

  // 2. Tagging rules parity
  console.log('\n  Tagging rules parity\n');
  const rules = getTaggingRules();
  assert(rules.length === EXPECTED_TAGGING_RULES.length, `rule count matches (${rules.length})`);
  for (let i = 0; i < EXPECTED_TAGGING_RULES.length; i++) {
    const expected = EXPECTED_TAGGING_RULES[i];
    const loaded   = rules[i];
    assert(loaded.thesis === expected.thesis, `rule ${i} thesis name: ${loaded.thesis}`);
    assertDeepEqual(loaded.markets,   expected.markets,   `rule ${i} markets match`);
    assertDeepEqual(loaded.companies, expected.companies, `rule ${i} companies match`);
  }

  // 3. autoTagTheses behavior — simulate the matching function against fixture rules
  function autoTagTheses(companyName, market, ruleSet) {
    const matches = [];
    for (const rule of ruleSet) {
      if (market && rule.markets.some(m => market.toLowerCase().includes(m.toLowerCase()))) {
        matches.push(rule.thesis);
        continue;
      }
      if (rule.companies.some(c => companyName.toLowerCase().includes(c.toLowerCase()))) {
        matches.push(rule.thesis);
      }
    }
    return matches;
  }

  const ALPHA_NAME = FIXTURE_THESES[0].name;   // 'Alpha: Software Infrastructure'
  const BETA_NAME  = FIXTURE_THESES[1].name;   // 'Beta: Physical World Repricing'
  const GAMMA_NAME = FIXTURE_THESES[2].name;   // 'Gamma: Autonomous Physical Systems'
  const DELTA_NAME = FIXTURE_THESES[3].name;   // 'Delta: Resilient Human Systems'

  console.log('\n  Tagging behavior parity\n');
  const testCases = [
    // market match
    { company: 'Voltaic AI',      market: 'AI / ML',    expected: [ALPHA_NAME] },
    // company match (Defense not in any market_patterns → falls through to company list)
    { company: 'Ironclad Defense', market: 'Defense',   expected: [BETA_NAME] },
    // company match, no market
    { company: 'FloraHive',       market: 'Agriculture', expected: [GAMMA_NAME] },
    // market match for Delta (EdTech contains no market pattern; company match instead)
    { company: 'Curriculr',       market: 'EdTech',     expected: [DELTA_NAME] },
    // market match → Beta (Aerospace in Beta market_patterns)
    { company: 'Random Startup',  market: 'Aerospace',  expected: [BETA_NAME] },
    // market match → Gamma (Logistics in Gamma market_patterns)
    { company: 'Random Startup',  market: 'Logistics',  expected: [GAMMA_NAME] },
    // dual company match (Vanguard Systems appears in Beta AND Gamma company_patterns, no market)
    { company: 'Vanguard Systems', market: null,        expected: [BETA_NAME, GAMMA_NAME] },
    // no match
    { company: 'Unknown Company', market: 'Unknown Market', expected: [] },
    // company match → Delta
    { company: 'Serenity Health', market: null,         expected: [DELTA_NAME] },
    // company match → Beta
    { company: 'Pelagic Fusion',  market: null,         expected: [BETA_NAME] },
  ];

  for (const tc of testCases) {
    const result = autoTagTheses(tc.company, tc.market, rules);
    assertDeepEqual(result, tc.expected, `tag(${tc.company}, ${tc.market}) → [${tc.expected.join(', ')}]`);
  }

  // 4. Distributions parity
  console.log('\n  Distribution parity\n');
  const dists = getDistributions();
  for (const [band, expected] of Object.entries(FIXTURE_DISTRIBUTIONS_JSON.bands)) {
    assert(dists[band] !== undefined, `band ${band} exists`);
    assertDeepEqual(dists[band].outcomes, expected.outcomes, `band ${band} outcomes match`);
    assertDeepEqual(dists[band].probs,    expected.probs,    `band ${band} probs match`);
  }

  // 5. Thesis clusters parity
  console.log('\n  Thesis cluster parity\n');
  const clusters = getThesisClusters();
  for (const thesis of FIXTURE_THESES) {
    assert(clusters[thesis.name] === thesis.id, `cluster ${thesis.name} → ${thesis.id}`);
  }

  // 6. Round params parity
  console.log('\n  Round params parity\n');
  const rp = getRoundParams();
  for (const [round, params] of Object.entries(FIXTURE_ROUND_PARAMS_JSON.rounds)) {
    assert(rp.rounds[round] !== undefined, `round ${round} exists`);
    assertDeepEqual(rp.rounds[round], params, `round ${round} params match`);
  }
  assert(rp.default.confidence === 'low', 'default confidence is low');
  assert(rp.default.time_to_liquidity_years === 7, 'default time_to_liquidity is 7');

  // 7. Active thesis names
  // Loader returns theses in filesystem sort order (readdirSync().sort() on filenames).
  // We sort both arrays before comparing so the assertion is order-independent.
  console.log('\n  Active thesis names parity\n');
  const activeNames = [...getActiveThesisNames()].sort();
  const expectedActiveNames = FIXTURE_THESES.filter(t => t.active).map(t => t.name).sort();
  assertDeepEqual(activeNames, expectedActiveNames, 'active thesis names match fixture (order-independent)');

  // 8. Python sidecar receives active_theses correctly
  console.log('\n  Python sidecar active_theses passthrough\n');
  try {
    const fixtureThesisNames = getActiveThesisNames(); // 4 fixture thesis names
    const result = runAnalytics('thesis_validation', 'discover', {
      investments: [
        { company: 'FxTest1', multiple: 2.0, theses: [ALPHA_NAME], stage: 'seed',     invest_date: '2023-01-01' },
        { company: 'FxTest2', multiple: 0.5, theses: [ALPHA_NAME], stage: 'seed',     invest_date: '2023-06-01' },
        { company: 'FxTest3', multiple: 1.5, theses: [ALPHA_NAME], stage: 'seed',     invest_date: '2024-01-01' },
        { company: 'FxTest4', multiple: 3.0, theses: [BETA_NAME],  stage: 'pre-seed', invest_date: '2023-03-01' },
        { company: 'FxTest5', multiple: 1.0, theses: [BETA_NAME],  stage: 'pre-seed', invest_date: '2024-06-01' },
      ],
      active_theses: fixtureThesisNames,
    });
    assert(result.active_assessment !== undefined, 'discover returns active_assessment');
    assert(result.active_assessment.length === fixtureThesisNames.length,
      `active_assessment has ${fixtureThesisNames.length} theses (from fixture lens)`);
    const assessedNames = result.active_assessment.map(a => a.thesis);
    for (const name of fixtureThesisNames) {
      assert(assessedNames.includes(name), `assessed: ${name}`);
    }
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m Python sidecar call failed: ${err.message}`);
    failed++;
  }

  // 9. Rubric structure
  console.log('\n  Rubric structure\n');
  const rubric = getRubric();
  assert(rubric.total_points === 50, 'rubric total_points is 50');
  assert(rubric.sections.length === 2, 'rubric has 2 sections');
  const dims = rubric.sections.flatMap(s => s.dimensions);
  assert(dims.length === 9, 'rubric has 9 dimensions');
  assert(rubric.verdict_bands.length === 4, 'rubric has 4 verdict bands');

  // 10. GP tiers structure
  console.log('\n  GP tiers structure\n');
  const gp = getGpTiers();
  assert(gp.tiers.length === 3, 'GP tiers has 3 tiers');
  assert(gp.tiers[0].gps[0].name === 'Synthetic Syndicate Alpha', 'tier 1 lead is Synthetic Syndicate Alpha');
  assert(gp.direct.length === 3, 'GP has 3 direct entries');

  // 11. Kill criteria structure
  console.log('\n  Kill criteria structure\n');
  const kc = getKillCriteria();
  assert(kc.automatic_pass.length === 4, 'kill criteria has 4 automatic passes');
  assert(kc.structural_flags.length === 4, 'kill criteria has 4 structural flags');

  // 12. Guard-ordering: RADAR_LENS_SOURCE=db guard sits ABOVE the singleton cache.
  // The whole suite above has already warmed the module singleton (_activeLens)
  // via the filesystem path (getActiveLens() at test 1). Now flip the flag on.
  // The guard must still throw for an unhydrated (ALS-empty) call — proving it is
  // checked before the cached _activeLens short-circuit. If a future refactor
  // reorders "return the cache first," this test fails. (loader.js:156-162)
  console.log('\n  Guard ordering (db flag beats warm cache)\n');
  {
    const prev = process.env.RADAR_LENS_SOURCE;
    process.env.RADAR_LENS_SOURCE = 'db';
    try {
      let threw = false;
      try {
        getActiveLens(); // ALS empty, but _activeLens is warm from test 1
      } catch (e) {
        threw = /RADAR_LENS_SOURCE/.test(e.message);
      }
      assert(threw, 'warm singleton + db flag + no ALS → getActiveLens() throws');

      // And a hydrated (ALS-present) call under the same flag does NOT throw,
      // returning the request lens rather than the warm singleton.
      const hydrated = { manifest: { name: 'hydrated-under-flag' } };
      const got = withLens(hydrated, () => getActiveLens());
      assert(got === hydrated, 'hydrated call under db flag returns the ALS lens');
    } finally {
      if (prev === undefined) delete process.env.RADAR_LENS_SOURCE;
      else process.env.RADAR_LENS_SOURCE = prev;
    }
  }

} finally {
  // Restore cwd, clear cache, remove temp dir — leave no trace.
  process.chdir(originalCwd);
  resetLensCache();
  rmSync(tempDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
