import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { calculateOffer, canonicalJson } from '../index.mjs';
import { SCHEMAS } from '../schema.mjs';
import { run } from './helpers.mjs';
import { legacyOffer, legacyScenarioSet, legacyGroup, makeGrant, makeOffer, makeScenario, makeScenarioSet, namedFixtures, f, missing } from './fixtures/index.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  }).filter((p) => p.endsWith('.mjs'));
}

test('browser safety: only relative imports and no host globals', () => {
  const list = [join(root, 'index.mjs'), ...files(join(root, 'src'))];
  assert.ok(list.length > 5);
  const forbidden = [/\bprocess\b/, /\bBuffer\b/, /\brequire\s*\(/, /\bfetch\s*\(/, /\bsetTimeout\b/, /\bsetInterval\b/, /Date\.now/, /new Date\s*\(/];
  for (const file of list) {
    const text = readFileSync(file, 'utf8');
    const specs = [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const s of specs) assert.ok(s.startsWith('./') || s.startsWith('../'), `${file}: non-relative import ${s}`);
    for (const re of forbidden) assert.ok(!re.test(text), `${file}: forbidden ${re}`);
  }
});

test('determinism: same input gives an identical JSON string', () => {
  const input = () => ({ group: legacyGroup, offerRevision: legacyOffer, scenarioSet: legacyScenarioSet });
  assert.equal(JSON.stringify(calculateOffer(input())), JSON.stringify(calculateOffer(input())));
  const r = run();
  assert.equal(canonicalJson(r), canonicalJson(JSON.parse(JSON.stringify(r))));
});

test('limitations are sorted and de-duplicated', () => {
  const r = run({ offer: makeOffer({ grants: [makeGrant({ instrument: 'rsu' }), makeGrant({ componentId: 'c2', instrument: 'rsu' })] }) });
  for (const l of [r.limitations, ...r.scenarios.map((s) => s.limitations)]) {
    assert.deepEqual(l, [...new Set(l)].sort());
  }
});

test('canonicalJson sorts keys recursively', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson({ a: undefined, b: 'x' }), '{"b":"x"}');
});

const ajv = new Ajv({ strict: true, allErrors: true });
const validators = {
  group: ajv.compile(SCHEMAS.decisionGroup),
  opportunity: ajv.compile(SCHEMAS.opportunity),
  offer: ajv.compile(SCHEMAS.offerRevision),
  scenarioSet: ajv.compile(SCHEMAS.scenarioSet),
};
const kindOf = (name) => (name.startsWith('group') ? 'group' : name.startsWith('opportunity') ? 'opportunity' : name.startsWith('offer') ? 'offer' : 'scenarioSet');

test('every fixture validates against the strict schemas', () => {
  const extra = {
    offerRsu: makeOffer({ grants: [makeGrant({ instrument: 'rsu' })] }),
    offerMissingStrike: makeOffer({ grants: [makeGrant({ strikePrice: missing() })] }),
    offerIllustrative: makeOffer({ grants: [makeGrant({ units: f('1', 'illustrative') })] }),
    scenarioSetNoLiquidity: makeScenarioSet([makeScenario({ liquidity: { occurs: false, monthsFromStart: null } })]),
    scenarioSetAtDate: makeScenarioSet([makeScenario({ exercisePath: { kind: 'at_date', exerciseMonthsFromStart: 24 } })]),
  };
  for (const [name, value] of Object.entries({ ...namedFixtures, ...extra })) {
    const v = validators[kindOf(name)];
    assert.ok(v(value), `${name}: ${JSON.stringify(v.errors)}`);
  }
});

test('schema rejects dilution on share-based methods', () => {
  const bad = makeScenarioSet([makeScenario({ payout: { method: 'pro_rata_shares', equityExitValue: '1', fullyDilutedExitShares: '1', dilutionRounds: ['0.1'] } })]);
  assert.equal(validators.scenarioSet(bad), false);
});
