#!/usr/bin/env node

// Standalone tests for company name normalization and tokenization.
// No framework — same pattern as test-irr.js.
// Run: node src/utils/test-matching.js

import { normalize, tokenize, STOPWORDS, STRIP_SUFFIXES } from './company-names.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (e) {
    console.log(`  \u2717 ${name}: ${e.message}`);
    failed++;
  }
}

function eq(actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`expected ${e}, got ${a}`);
}

console.log('\n  normalize() tests\n');

test('null input returns empty string', () => {
  eq(normalize(null), '');
});

test('empty string returns empty string', () => {
  eq(normalize(''), '');
});

test('lowercases input', () => {
  eq(normalize('FooBar'), 'foobar');
});

test('strips Inc suffix', () => {
  eq(normalize('Acme Inc.'), 'acme');
});

test('strips LLC suffix', () => {
  eq(normalize('Widgets LLC'), 'widgets');
});

test('strips Corp suffix', () => {
  eq(normalize('BigCo Corp'), 'bigco');
});

test('strips Holdings suffix', () => {
  eq(normalize('Alpha Holdings'), 'alpha');
});

test('strips Company suffix', () => {
  eq(normalize('Beta Company'), 'beta');
});

test('strips PBC suffix', () => {
  eq(normalize('GreenTech PBC'), 'greentech');
});

test('strips multiple suffixes', () => {
  eq(normalize('Delta Corp Holdings Inc.'), 'delta');
});

test('strips parenthetical (YC batch)', () => {
  eq(normalize('Novex (YC S21)'), 'novex');
});

test('strips parenthetical (formerly ...)', () => {
  eq(normalize('NewCo (formerly OldCo)'), 'newco');
});

test('collapses special characters to spaces', () => {
  eq(normalize('Foo-Bar_Baz.Qux'), 'foo bar baz qux');
});

test('trims whitespace', () => {
  eq(normalize('  Spacey Name  '), 'spacey name');
});

test('handles company with all suffixes stripped to empty', () => {
  // "The Inc." → "the" stripped by STRIP_SUFFIXES → empty after trim
  // Actually "The" is a suffix, "Inc" is a suffix
  const result = normalize('The Inc.');
  eq(result, '');
});

console.log('\n  tokenize() tests\n');

test('null input returns empty array', () => {
  eq(tokenize(null), []);
});

test('empty string returns empty array', () => {
  eq(tokenize(''), []);
});

test('filters tokens shorter than 3 chars', () => {
  eq(tokenize('ab cd efg'), ['efg']);
});

test('filters stopwords', () => {
  // "ai", "labs", "tech" are all stopwords
  eq(tokenize('acme ai labs'), ['acme']);
});

test('keeps non-stopword tokens >= 3 chars', () => {
  eq(tokenize('quantum computing research'), ['quantum', 'computing', 'research']);
});

test('filters "robotics" stopword', () => {
  eq(tokenize('boston robotics'), ['boston']);
});

test('filters "marketplace" stopword', () => {
  eq(tokenize('green marketplace'), ['green']);
});

test('filters investment vehicle stopwords', () => {
  // ventures, capital, fund are stopwords
  eq(tokenize('acme ventures capital fund'), ['acme']);
});

test('filters YC batch labels', () => {
  // w24, s25 are stopwords
  eq(tokenize('acme w24 s25'), ['acme']);
});

test('end-to-end: normalize then tokenize', () => {
  const name = 'Acme Robotics Inc. (YC W25)';
  const tokens = tokenize(normalize(name));
  eq(tokens, ['acme']);
});

test('end-to-end: multi-word company', () => {
  const name = 'Quantum Computing Research LLC';
  const tokens = tokenize(normalize(name));
  eq(tokens, ['quantum', 'computing', 'research']);
});

test('end-to-end: company with dashes', () => {
  const name = 'Eight-Sleep';
  const tokens = tokenize(normalize(name));
  eq(tokens, ['eight', 'sleep']);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
