import assert from 'node:assert/strict';
import {
  assertCompleteChunkCoverage,
  batchRoomChunks,
  chunkRoomDocuments,
  mergeRoomLedgers,
} from '../room-evidence.js';
import {
  EXTRACTION_STATE_FIXTURE,
  substantialRoomFixture,
} from './fixtures.js';

const fixture = substantialRoomFixture();
const chunks = chunkRoomDocuments(fixture.deal.source_documents, { maxCharacters: 2_000 });
const batches = batchRoomChunks(chunks, { maxCharacters: 4_000 });

assert.equal(assertCompleteChunkCoverage(chunks, batches), true);
assert.ok(chunks.length > fixture.deal.source_documents.length);
for (const fact of fixture.facts) {
  assert.equal(
    chunks.filter(chunk => chunk.text.includes(fact.marker)).length,
    fact.id === 'same-event-conflict' ? 1 : 1,
    `${fact.id} must occur in exactly one deterministic chunk`,
  );
}

const criticalFacts = fixture.facts.filter(fact => fact.priority === 'critical');
const ledger = mergeRoomLedgers([{
  facts: criticalFacts.map(fact => ({
    claim: `${fact.marker}: fictional claim`,
    classification: fact.classification,
    source_locator: `fixture:${fact.id}`,
  })),
  contradictions: ['CONFLICT-SAME-EVENT-23 has incompatible June ARR values'],
  missing_evidence: [],
  named_entities: ['Nimbus Forge (fictional)'],
  named_competitors: fixture.namedCompetitors,
}]);
assert.equal(ledger.facts.length, criticalFacts.length);
assert.ok(ledger.contradictions.some(value => value.includes('CONFLICT-SAME-EVENT-23')));
assert.deepEqual(ledger.named_competitors, fixture.namedCompetitors);

assert.deepEqual(
  EXTRACTION_STATE_FIXTURE.map(entry => entry.extraction_status),
  ['included', 'empty', 'extraction_failed', 'unsupported'],
);
assert.ok(
  EXTRACTION_STATE_FIXTURE.slice(1).every(
    entry => !['included', 'excluded_by_user'].includes(entry.extraction_status),
  ),
  'non-terminal extraction states must block scoring until specifically waived',
);

const serialized = JSON.stringify(fixture);
assert.doesNotMatch(serialized, /Alpine Eagle|Mana Ventures|Chandler|Koglmeier/i);
assert.match(serialized, /absence of the current private offer from public sources is not a contradiction/i);

console.log('council-eval-contracts: fictional evidence corpus passed');

