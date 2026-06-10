#!/usr/bin/env node

// Standalone tests for matchCompanyToInvestment() — no DB required.
// Uses the `universe` option to inject a mock investment list.
// Run: node src/utils/test-match.js

import { matchCompanyToInvestment } from './match.js';

let passed = 0;
let failed = 0;

function eq(actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`expected ${e}, got ${a}`);
}

// Mock universe — a representative slice of investments
const universe = [
  { id: 1, company_name: 'Nexar' },
  { id: 2, company_name: 'Dual Drift' },
  { id: 3, company_name: 'Peak Orbital' },
  { id: 4, company_name: 'Pelagic Fusion' },
  { id: 5, company_name: 'Rosewater Finance' },
  { id: 6, company_name: 'Quantum Computing Research' },
  { id: 7, company_name: 'Acme Widgets' },
  { id: 8, company_name: 'NovaBio' },
  { id: 9, company_name: 'SkyNet Defense' },
  { id: 10, company_name: 'Green Harvest' },
];

function match(name) {
  return matchCompanyToInvestment(name, { universe });
}

async function runTests() {
  const tests = [];

  function test(name, fn) {
    tests.push({ name, fn });
  }

  // ─── Exact match (normalized equality) ─────────────────────────────

  test('exact match — identical casing', async () => {
    eq(await match('Nexar'), { investment_id: 1, confidence: 'exact' });
  });

  test('exact match — different casing', async () => {
    eq(await match('nexar'), { investment_id: 1, confidence: 'exact' });
  });

  test('exact match — uppercase', async () => {
    eq(await match('NEXAR'), { investment_id: 1, confidence: 'exact' });
  });

  test('exact match — multi-word company', async () => {
    eq(await match('Dual Drift'), { investment_id: 2, confidence: 'exact' });
  });

  test('exact match — multi-word different casing', async () => {
    eq(await match('dual drift'), { investment_id: 2, confidence: 'exact' });
  });

  // ─── Normalized match (suffix stripping, parenthetical removal) ────

  test('normalized — strips Inc suffix', async () => {
    eq(await match('Nexar, Inc.'), { investment_id: 1, confidence: 'exact' });
  });

  test('normalized — strips LLC suffix', async () => {
    eq(await match('Nexar LLC'), { investment_id: 1, confidence: 'exact' });
  });

  test('normalized — strips Corp suffix', async () => {
    eq(await match('Nexar Corp'), { investment_id: 1, confidence: 'exact' });
  });

  test('normalized — strips Holdings suffix', async () => {
    eq(await match('Nexar Holdings'), { investment_id: 1, confidence: 'exact' });
  });

  test('normalized — strips parenthetical (YC batch)', async () => {
    eq(await match('Nexar (YC W25)'), { investment_id: 1, confidence: 'exact' });
  });

  test('normalized — strips parenthetical (formerly ...)', async () => {
    eq(await match('Nexar (formerly NexarChip)'), { investment_id: 1, confidence: 'exact' });
  });

  test('normalized — strips multiple suffixes + parenthetical', async () => {
    eq(await match('Peak Orbital Inc. (YC S20)'), { investment_id: 3, confidence: 'exact' });
  });

  test('normalized — hyphenated name matches space-separated', async () => {
    eq(await match('Dual-Drift'), { investment_id: 2, confidence: 'exact' });
  });

  test('normalized — PBC suffix stripped', async () => {
    eq(await match('NovaBio PBC'), { investment_id: 8, confidence: 'exact' });
  });

  // ─── Token match (discriminating-token fuzzy match) ────────────────

  test('token match — superset name shares discriminating tokens', async () => {
    // "Pelagic Fusion Energy" → normalize → "pelagic fusion energy"
    // "Pelagic Fusion" → normalize → "pelagic fusion"
    // Not equal → falls to token match. Tokens [pelagic, fusion, energy] vs [pelagic, fusion]
    // Single candidate → token
    eq(await match('Pelagic Fusion Energy'), { investment_id: 4, confidence: 'token' });
  });

  test('token match — superset with stopword suffix', async () => {
    // "SkyNet Defense Systems" → normalize → "skynet defense systems"
    // "SkyNet Defense" → normalize → "skynet defense"
    // Not equal. Tokens: [skynet, defense] (systems is stopword) vs [skynet, defense]
    // Single candidate → token
    eq(await match('SkyNet Defense Systems'), { investment_id: 9, confidence: 'token' });
  });

  test('token match — non-stopword carries match despite stopwords in name', async () => {
    const u = [{ id: 404, company_name: 'Acme AI Labs' }];
    // "Acme Tech Solutions" → tokens: [acme]. "Acme AI Labs" → tokens: [acme]. Match.
    eq(await matchCompanyToInvestment('Acme Tech Solutions', { universe: u }),
      { investment_id: 404, confidence: 'token' });
  });

  test('token match — shared discriminating token among stopword-heavy names', async () => {
    const u = [{ id: 405, company_name: 'DeepMind AI Labs' }];
    // "DeepMind Tech" → tokens: [deepmind]. "DeepMind AI Labs" → tokens: [deepmind].
    eq(await matchCompanyToInvestment('DeepMind Tech', { universe: u }),
      { investment_id: 405, confidence: 'token' });
  });

  // ─── Ambiguous match ───────────────────────────────────────────────

  test('ambiguous — token matches multiple investments', async () => {
    const u = [
      { id: 100, company_name: 'Fusion Power' },
      { id: 101, company_name: 'Fusion Robotics' },
    ];
    // "Fusion Energy" → tokens: [fusion, energy]. Both candidates have "fusion".
    eq(await matchCompanyToInvestment('Fusion Energy', { universe: u }),
      { investment_id: null, confidence: 'ambiguous' });
  });

  test('ambiguous — two companies share discriminating token with input', async () => {
    const u = [
      { id: 11, company_name: 'Acme Widgets' },
      { id: 12, company_name: 'Acme Robotics' },
    ];
    // "Acme Power" → tokens: [acme, power]. Both have "acme".
    eq(await matchCompanyToInvestment('Acme Power', { universe: u }),
      { investment_id: null, confidence: 'ambiguous' });
  });

  test('ambiguous — stopwords do not contribute to candidate list', async () => {
    // "AI Labs" → tokens: [] (ai is stopword + <3 chars, labs is stopword)
    // Empty tokens → unmatched, NOT ambiguous
    const u = [
      { id: 200, company_name: 'DeepAI Labs' },
      { id: 201, company_name: 'OpenAI Labs' },
    ];
    eq(await matchCompanyToInvestment('AI Labs', { universe: u }),
      { investment_id: null, confidence: 'unmatched' });
  });

  // ─── Unmatched / no match ──────────────────────────────────────────

  test('no match — completely unknown company', async () => {
    eq(await match('Zephyr Dynamics'), { investment_id: null, confidence: 'unmatched' });
  });

  test('no match — stopword-only input yields unmatched', async () => {
    // "AI Tech Labs" → tokens: [] (all stopwords)
    eq(await match('AI Tech Labs'), { investment_id: null, confidence: 'unmatched' });
  });

  test('no match — empty universe', async () => {
    eq(await matchCompanyToInvestment('Nexar', { universe: [] }),
      { investment_id: null, confidence: 'unmatched' });
  });

  test('no match — short form does not substring-match', async () => {
    // "Zura" token: [zura]. "Rosewater Finance" tokens: [rosewater, finance]. No overlap.
    eq(await match('Zura'), { investment_id: null, confidence: 'unmatched' });
  });

  // ─── Edge cases: null, empty, short inputs ─────────────────────────

  test('null input → unmatched', async () => {
    eq(await match(null), { investment_id: null, confidence: 'unmatched' });
  });

  test('undefined input → unmatched', async () => {
    eq(await match(undefined), { investment_id: null, confidence: 'unmatched' });
  });

  test('empty string → unmatched', async () => {
    eq(await match(''), { investment_id: null, confidence: 'unmatched' });
  });

  test('whitespace only → unmatched', async () => {
    eq(await match('   '), { investment_id: null, confidence: 'unmatched' });
  });

  test('single character — exact match still works', async () => {
    const u = [{ id: 300, company_name: 'X' }];
    eq(await matchCompanyToInvestment('X', { universe: u }),
      { investment_id: 300, confidence: 'exact' });
  });

  test('two-character name — exact match still works', async () => {
    const u = [{ id: 301, company_name: 'AI' }];
    eq(await matchCompanyToInvestment('AI', { universe: u }),
      { investment_id: 301, confidence: 'exact' });
  });

  test('two-character name — no token fallback (too short + stopword)', async () => {
    const u = [{ id: 302, company_name: 'AI Power' }];
    // "AI" normalizes to "ai". "AI Power" normalizes to "ai power". Not equal.
    // tokenize("ai") → [] (length < 3 and stopword) → unmatched
    eq(await matchCompanyToInvestment('AI', { universe: u }),
      { investment_id: null, confidence: 'unmatched' });
  });

  test('name that normalizes to empty → unmatched', async () => {
    // "The Inc." → normalize strips "The" and "Inc." → ""
    eq(await match('The Inc.'), { investment_id: null, confidence: 'unmatched' });
  });

  // ─── Stopword handling ─────────────────────────────────────────────

  test('stopword "robotics" does not cause false match', async () => {
    const u = [{ id: 400, company_name: 'Boston Robotics' }];
    // "Acme Robotics" tokens: [acme]. "Boston Robotics" tokens: [boston]. No overlap.
    eq(await matchCompanyToInvestment('Acme Robotics', { universe: u }),
      { investment_id: null, confidence: 'unmatched' });
  });

  test('stopword "marketplace" does not cause false match', async () => {
    const u = [{ id: 401, company_name: 'Green Marketplace' }];
    // "Blue Marketplace" tokens: [blue]. "Green Marketplace" tokens: [green]. No overlap.
    eq(await matchCompanyToInvestment('Blue Marketplace', { universe: u }),
      { investment_id: null, confidence: 'unmatched' });
  });

  test('stopword "capital" does not cause false match between funds', async () => {
    const u = [
      { id: 402, company_name: 'Sequoia Capital' },
      { id: 403, company_name: 'Accel Capital' },
    ];
    // "Founders Capital" tokens: [founders]. Neither has "founders".
    eq(await matchCompanyToInvestment('Founders Capital', { universe: u }),
      { investment_id: null, confidence: 'unmatched' });
  });

  // ─── Corporate suffix handling ─────────────────────────────────────

  test('Inc. suffix on both sides still matches exactly', async () => {
    const u = [{ id: 500, company_name: 'Acme Inc.' }];
    eq(await matchCompanyToInvestment('Acme Inc', { universe: u }),
      { investment_id: 500, confidence: 'exact' });
  });

  test('different suffixes normalize to same name → exact', async () => {
    const u = [{ id: 501, company_name: 'Delta Corp' }];
    eq(await matchCompanyToInvestment('Delta LLC', { universe: u }),
      { investment_id: 501, confidence: 'exact' });
  });

  test('GmbH suffix stripped → exact', async () => {
    const u = [{ id: 502, company_name: 'Siemens' }];
    eq(await matchCompanyToInvestment('Siemens GmbH', { universe: u }),
      { investment_id: 502, confidence: 'exact' });
  });

  // ─── ID ordering (earliest wins) ──────────────────────────────────

  test('exact match picks first row (lowest id) when duplicates exist', async () => {
    const u = [
      { id: 10, company_name: 'Nexar' },
      { id: 20, company_name: 'Nexar' },
      { id: 30, company_name: 'Nexar' },
    ];
    eq(await matchCompanyToInvestment('Nexar', { universe: u }),
      { investment_id: 10, confidence: 'exact' });
  });

  // ─── Real-world scenarios ──────────────────────────────────────────

  test('AngelList invite format matches portfolio company', async () => {
    eq(await match('Peak Orbital Inc. (YC S16)'), { investment_id: 3, confidence: 'exact' });
  });

  test('deal-log title with LLC matches portfolio company', async () => {
    eq(await match('Quantum Computing Research LLC'), { investment_id: 6, confidence: 'exact' });
  });

  test('transaction ledger entry with PBC suffix matches', async () => {
    eq(await match('Green Harvest PBC'), { investment_id: 10, confidence: 'exact' });
  });

  test('special characters normalized — & becomes space', async () => {
    const u = [{ id: 600, company_name: 'Foo & Bar' }];
    eq(await matchCompanyToInvestment('Foo & Bar', { universe: u }),
      { investment_id: 600, confidence: 'exact' });
  });

  test('dot in company name normalizes to space', async () => {
    const u = [{ id: 601, company_name: 'X.ai' }];
    eq(await matchCompanyToInvestment('X.ai', { universe: u }),
      { investment_id: 601, confidence: 'exact' });
  });

  // ─── Run all tests ────────────────────────────────────────────────

  console.log('\n  matchCompanyToInvestment() tests\n');

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  \u2713 ${t.name}`);
      passed++;
    } catch (e) {
      console.log(`  \u2717 ${t.name}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
