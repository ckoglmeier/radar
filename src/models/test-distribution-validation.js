import assert from 'node:assert/strict';
import { validateDistributions, saveDistributions } from './lens-config.js';
const bands = ['44+', '39-43', '30-38', '<30'];
const fixture = () => ({ bands: Object.fromEntries(bands.map(band => [band, { outcomes: [0, 2], probs: [.5, .5] }])) });
assert.doesNotThrow(() => validateDistributions(fixture()));
for (const outcome of [-1, NaN, Infinity, null, '2']) {
  const value = fixture();
  value.bands['44+'].outcomes[1] = outcome;
  assert.throws(() => validateDistributions(value), /return multiples/);
  await assert.rejects(saveDistributions(value), /return multiples/);
}
for (const probabilities of [[.4, .4], [NaN, 1], [Infinity, 0], [-.5, 1.5]]) {
  const value = fixture();
  value.bands['39-43'].probs = probabilities;
  assert.throws(() => validateDistributions(value));
}
const empty = fixture();
empty.bands['<30'] = { outcomes: [], probs: [] };
assert.throws(() => validateDistributions(empty), /between 1 and 100/);
console.log('Distribution validation: finite nonnegative returns, valid probability mass, no invalid writes passed');
