import assert from 'node:assert/strict';
import { aggregateStageUsage, readUsageSnapshot } from './session-usage.js';

const st = (stage, usage, extra = {}) => ({ stage, result: { model: 'gpt-x', provider: 'openai', numTurns: 1, usage, ...extra } });
const known = { inputTokens: 10, outputTokens: 5, reasoningTokens: 3, cacheReadInputTokens: 2,
  totalCostUsd: 0.01, estimatedCostUsd: 0.02, billedCostUsd: 0.03,
  billableTools: [{ tool: 'web_search', calls: 2 }] };

// stage records carried, tools summed, reasoning not double counted, costs sum
let { total, records } = aggregateStageUsage([
  st('research', known, { modelPolicyVersion: 'v7' }),
  st('bull', { ...known, billableTools: [{ tool: 'web_search', calls: 1 }, { tool: 'code', calls: 4 }] }, { modelPolicyVersion: 'v7' }),
]);
assert.equal(records.length, 2);
assert.deepEqual(Object.keys(records[0]).sort(), ['attempt', 'attemptKind', 'billableTools', 'billedCostUsd',
  'cacheCreationInputTokens', 'cacheReadInputTokens', 'estimatedCostUsd', 'inputTokens', 'model', 'outputTokens',
  'provider', 'reasoningTokens', 'reusedCheckpoint', 'stage', 'totalCostUsd']);
assert.equal(records[0].provider, 'openai');
assert.equal(total.outputTokens, 10);
assert.equal(total.reasoningTokens, 6);
assert.ok(Math.abs(total.totalCostUsd - 0.02) < 1e-12);
assert.ok(Math.abs(total.estimatedCostUsd - 0.04) < 1e-12);
assert.ok(Math.abs(total.billedCostUsd - 0.06) < 1e-12);
assert.deepEqual(total.billableTools, [{ tool: 'web_search', calls: 3 }, { tool: 'code', calls: 4 }]);
assert.equal(total.model_policy_version, 'v7');
assert.equal(total.stages.length, 2);

// unknown cost stays null, never 0 (null, undefined, and missing all unknown)
({ total } = aggregateStageUsage([st('a', known), st('b', { ...known, totalCostUsd: null, billedCostUsd: undefined })]));
assert.equal(total.totalCostUsd, null);
assert.equal(total.billedCostUsd, null);
assert.ok(total.estimatedCostUsd > 0);
assert.equal(total.inputTokens, 20, 'tokens still sum');
assert.equal(total.model_policy_version, null);

// repair attempts recorded separately with markers
({ records } = aggregateStageUsage([st('bull_invalid', known), st('bull', known), st('bear', known)]));
assert.deepEqual(records.map(r => [r.stage, r.attempt, r.attemptKind]),
  [['bull', 1, 'rejected'], ['bull', 2, 'repair'], ['bear', 1, 'initial']]);

// absent provider -> null unless caller supplies a connection-derived default
({ records } = aggregateStageUsage([{ stage: 'x', result: { usage: known } }]));
assert.equal(records[0].provider, null);
({ records } = aggregateStageUsage([{ stage: 'x', result: { usage: known } }], { defaultProvider: 'anthropic' }));
assert.equal(records[0].provider, 'anthropic');

// old snapshots still read
const old = readUsageSnapshot({ inputTokens: 5, outputTokens: 2, totalCostUsd: 0 });
assert.equal(old.totalCostUsd, 0);
assert.equal(old.estimatedCostUsd, null);
assert.deepEqual(old.stages, []);
assert.equal(old.model_policy_version, null);
assert.doesNotThrow(() => readUsageSnapshot(null));
console.log('session-usage: aggregation, null-cost semantics, attempts, legacy reads passed');
