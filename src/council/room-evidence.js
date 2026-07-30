import { createHash } from 'node:crypto';

export const ROOM_CHUNK_CONTRACT_VERSION = 'room-chunks-v1';
export const ROOM_EVIDENCE_CONTRACT_VERSION = 'room-evidence-v1';

function digest(value) {
  return createHash('sha256').update(
    typeof value === 'string' ? value : JSON.stringify(value),
  ).digest('hex');
}

function splitPoint(text, start, targetEnd) {
  if (targetEnd >= text.length) return text.length;
  const floor = Math.max(start + 1, targetEnd - 1_000);
  const candidates = [
    text.lastIndexOf('\n#', targetEnd),
    text.lastIndexOf('\n\n', targetEnd),
    text.lastIndexOf('\n', targetEnd),
    text.lastIndexOf('. ', targetEnd),
  ];
  return candidates.find(point => point >= floor) + 1 || targetEnd;
}

export function chunkRoomDocuments(documents = [], options = {}) {
  const maxCharacters = Math.max(2_000, Number(options.maxCharacters || 24_000));
  const chunks = [];
  for (const document of documents) {
    const text = String(document?.text || '');
    let start = 0;
    let sequence = 0;
    while (start < text.length) {
      const end = splitPoint(text, start, Math.min(text.length, start + maxCharacters));
      const chunkText = text.slice(start, end);
      sequence += 1;
      const sourceId = `doc-${document.document_id || 'unknown'}`;
      chunks.push({
        chunk_id: `${sourceId}-chunk-${sequence}`,
        document_id: document.document_id || null,
        filename: document.filename || null,
        sha256: document.sha256 || null,
        sequence,
        start_offset: start,
        end_offset: end,
        text: chunkText,
        text_sha256: digest(chunkText),
      });
      start = end;
    }
  }
  return chunks;
}

export function batchRoomChunks(chunks = [], options = {}) {
  const maxCharacters = Math.max(4_000, Number(options.maxCharacters || 72_000));
  const batches = [];
  let current = [];
  let characters = 0;
  for (const chunk of chunks) {
    if (current.length && characters + chunk.text.length > maxCharacters) {
      batches.push(current);
      current = [];
      characters = 0;
    }
    current.push(chunk);
    characters += chunk.text.length;
  }
  if (current.length) batches.push(current);
  return batches.map((batch, index) => ({
    batch_id: `room-batch-${index + 1}`,
    chunks: batch,
  }));
}

export function assertCompleteChunkCoverage(chunks, batches) {
  const expected = chunks.map(chunk => chunk.chunk_id).sort();
  const actual = batches.flatMap(batch => batch.chunks.map(chunk => chunk.chunk_id)).sort();
  if (
    expected.length !== actual.length
    || expected.some((chunkId, index) => chunkId !== actual[index])
  ) {
    throw new Error('Room evidence batches do not cover every source chunk exactly once');
  }
  if (new Set(actual).size !== actual.length) {
    throw new Error('Room evidence batches contain duplicate source chunks');
  }
  return true;
}

function normalizedClaim(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function mergeRoomLedgers(ledgers = []) {
  const facts = [];
  const seenFacts = new Set();
  for (const ledger of ledgers) {
    for (const fact of ledger?.facts || []) {
      const key = JSON.stringify([
        normalizedClaim(fact.claim),
        fact.classification,
        fact.source_locator,
      ]);
      if (seenFacts.has(key)) continue;
      seenFacts.add(key);
      facts.push(fact);
    }
  }
  const uniqueStrings = field => [...new Set(
    ledgers.flatMap(ledger => ledger?.[field] || []).map(value => String(value).trim()).filter(Boolean),
  )];
  return {
    contract_version: ROOM_EVIDENCE_CONTRACT_VERSION,
    facts,
    contradictions: uniqueStrings('contradictions'),
    missing_evidence: uniqueStrings('missing_evidence'),
    named_entities: uniqueStrings('named_entities'),
    named_competitors: uniqueStrings('named_competitors'),
  };
}

export function roomCoverage({
  documents = [],
  manifest = [],
  chunks = [],
  batches = [],
  strategy,
  model,
  contextBudgetTokens,
} = {}) {
  const byDocument = new Map();
  for (const chunk of chunks) {
    byDocument.set(chunk.document_id, (byDocument.get(chunk.document_id) || 0) + 1);
  }
  const sourceManifest = manifest.map(entry => ({
    ...entry,
    chunk_contract_version: ROOM_CHUNK_CONTRACT_VERSION,
    chunk_count: byDocument.get(entry.document_id) || 0,
  }));
  const extractedCharacters = documents.reduce(
    (sum, document) => sum + String(document?.text || '').length,
    0,
  );
  return {
    sourceManifest,
    coverage: {
      strategy,
      model,
      context_budget_tokens: contextBudgetTokens,
      extracted_characters: extractedCharacters,
      estimated_tokens: Math.ceil(extractedCharacters / 4),
      chunks: chunks.length,
      batches: batches.length,
      chunk_contract_version: ROOM_CHUNK_CONTRACT_VERSION,
      room_evidence_contract_version: ROOM_EVIDENCE_CONTRACT_VERSION,
    },
  };
}
