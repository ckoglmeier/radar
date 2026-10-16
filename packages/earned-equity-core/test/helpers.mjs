import assert from 'node:assert/strict';
import { calculateOffer } from '../index.mjs';
import { makeGroup, makeOffer, makeScenarioSet } from './fixtures/index.mjs';

export function run(over = {}) {
  const out = calculateOffer({
    group: over.group ?? makeGroup(),
    offerRevision: over.offer ?? makeOffer(),
    scenarioSet: over.set ?? makeScenarioSet(),
  });
  assert.equal(out.ok, true, JSON.stringify(out.errors));
  return out.result;
}

export const first = (over) => run(over).scenarios[0];
