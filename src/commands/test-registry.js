import assert from 'node:assert/strict';
import {
  canonicalHash,
  canonicalJson,
  commandHash,
  commandSetHash,
  NORMALIZER_VERSION,
} from './canonical.js';
import { CommandRegistry } from './registry.js';

function definition(overrides = {}) {
  return {
    name: 'fund.record_nav',
    version: 1,
    title: 'Record Fund NAV',
    description: 'Append a dated NAV.',
    risk: 'additive_reporting_fact',
    domainAtomicity: 'multi_statement',
    proposeCapabilities: ['portfolio:propose'],
    applyCapabilities: ['portfolio:apply:additive'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['date', 'nav'],
      properties: {
        date: { type: 'string', format: 'date' },
        nav: { type: 'number', minimum: 0 },
      },
    },
    resultSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['valuation_id'],
      properties: { valuation_id: { type: 'integer', minimum: 1 } },
    },
    availability() { return { available: true }; },
    resolve() {},
    inspect() {},
    preview() {},
    preconditions() {},
    affectedResources() { return []; },
    ...overrides,
  };
}

const registry = new CommandRegistry();
const stored = registry.register(definition());
assert.ok(Object.isFrozen(stored));
assert.ok(Object.isFrozen(stored.inputSchema));
assert.throws(() => registry.register(definition()), /duplicate command/);
assert.throws(() => registry.get('fund.record_nav', 2), error => error.code === 'COMMAND_UNSUPPORTED');
assert.deepEqual(registry.validateInput('fund.record_nav', 1, {
  date: '2026-06-30',
  nav: 310_000,
}), { date: '2026-06-30', nav: 310_000 });
assert.throws(
  () => registry.validateInput('fund.record_nav', 1, { date: '2026-06-30', nav: 1, hidden: true }),
  error => error.code === 'COMMAND_VALIDATION_FAILED',
);
assert.deepEqual(
  registry.validateResult('fund.record_nav', 1, { valuation_id: 9 }),
  { valuation_id: 9 },
);

const invalidSchemaRegistry = new CommandRegistry();
assert.throws(
  () => invalidSchemaRegistry.register(definition({
    name: 'fund.bad_schema',
    inputSchema: { type: 'object', madeUpKeyword: true },
  })),
  /invalid schema.*unknown keyword/i,
);

assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
assert.equal(canonicalHash({ a: 1, b: 2 }), canonicalHash({ b: 2, a: 1 }));
assert.throws(() => canonicalJson({ missing: undefined }), /undefined/);
assert.throws(() => canonicalJson({ amount: Number.NaN }), /non-finite/);

const command = {
  name: 'fund.record_nav',
  version: 1,
  target: { type: 'fund_position', id: 594 },
  input: { date: '2026-06-30', nav: 310_000 },
  preconditions: { latest_valuation_id: 81 },
};
const hash = commandHash(command);
assert.equal(hash, commandHash({ ...command, display: 'wording does not matter' }));
assert.equal(commandSetHash({
  registryVersion: registry.registryVersion(),
  commands: [{ ...command, command_hash: hash }],
}), commandSetHash({
  registryVersion: registry.registryVersion(),
  commands: [{ ...command, command_hash: hash }],
}));
assert.equal(NORMALIZER_VERSION, 1);
assert.equal(registry.metadata()[0].name, 'fund.record_nav');

console.log('command registry: schemas, immutability, metadata, and canonical hashes passed');
