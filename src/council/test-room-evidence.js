import assert from 'node:assert/strict';
import {
  assertCompleteChunkCoverage,
  batchRoomChunks,
  chunkRoomDocuments,
  mergeRoomLedgers,
  roomCoverage,
} from './room-evidence.js';

const documents = [{
  document_id: 11,
  filename: 'room.html',
  sha256: 'source-11',
  text: [
    '# Opening',
    'Critical opening fact.',
    '',
    '# Middle',
    'Important middle fact. '.repeat(180),
    '',
    '# End',
    'Critical end fact and Named Rival competitor.',
  ].join('\n'),
}, {
  document_id: 12,
  filename: 'terms.txt',
  sha256: 'source-12',
  text: 'Current private terms are supplied by the deal source.',
}];

const chunks = chunkRoomDocuments(documents, { maxCharacters: 2_000 });
assert.ok(chunks.length > documents.length, 'substantial input is deterministically chunked');
assert.match(chunks.at(-2).text + chunks.at(-1).text, /Critical end fact/);
assert.ok(chunks.every(chunk => chunk.chunk_id && chunk.text_sha256));

const batches = batchRoomChunks(chunks, { maxCharacters: 4_000 });
assert.equal(assertCompleteChunkCoverage(chunks, batches), true);
assert.throws(
  () => assertCompleteChunkCoverage(chunks, [{ batch_id: 'bad', chunks: chunks.slice(1) }]),
  /do not cover every source chunk/,
);

const locator = `${chunks[0].chunk_id}:${chunks[0].start_offset}-${chunks[0].end_offset}`;
const ledger = mergeRoomLedgers([{
  facts: [
    { claim: 'Current private terms are supplied', classification: 'supplied', source_locator: locator },
  ],
  contradictions: [],
  missing_evidence: ['Retention cohort'],
  named_entities: ['Fixture Company'],
  named_competitors: ['Named Rival'],
}, {
  facts: [
    { claim: 'Current private terms are supplied', classification: 'supplied', source_locator: locator },
  ],
  contradictions: ['Explicit same-event conflict'],
  missing_evidence: ['Retention cohort'],
  named_entities: ['Fixture Company'],
  named_competitors: ['Named Rival'],
}]);
assert.equal(ledger.facts.length, 1, 'identical located facts merge deterministically');
assert.deepEqual(ledger.named_competitors, ['Named Rival']);
assert.deepEqual(ledger.contradictions, ['Explicit same-event conflict']);

const receipt = roomCoverage({
  documents,
  manifest: documents.map(document => ({
    document_id: document.document_id,
    extraction_status: 'included',
  })),
  chunks,
  batches,
  strategy: 'chunk_all',
  model: 'claude-sonnet-4-6',
  contextBudgetTokens: 1_000,
});
assert.equal(receipt.coverage.strategy, 'chunk_all');
assert.equal(receipt.coverage.chunks, chunks.length);
assert.equal(receipt.sourceManifest[0].chunk_count, chunks.filter(
  chunk => chunk.document_id === 11,
).length);

console.log('test-room-evidence: chunk-all coverage contract passed');
