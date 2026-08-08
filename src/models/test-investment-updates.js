#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'radar-investment-updates-'));
const databaseUrl = `file:${join(scratch, 'db')}`;

const { closeDb, withTenant } = await import('../db/index.js');
const { runMigrations } = await import('../db/migrate.js');
const { upsertInvestment } = await import('./investments.js');
const { createDocument } = await import('./documents.js');
const {
  completeInvestmentUpdate,
  createInvestmentUpdate,
  failInvestmentUpdate,
  getInvestmentUpdate,
  listInvestmentUpdates,
  retryInvestmentUpdate,
} = await import('./investment-updates.js');

try {
  await withTenant(databaseUrl, async () => {
  await runMigrations();
  const investment = await upsertInvestment({
    company_name: 'Source Backed Update Test', invest_date: '2026-01-01',
    status: 'Live', invested: 1000, source: 'test', asset_class: 'direct',
  });
  const document = await createDocument({
    entity_type: 'investment', entity_id: investment.id,
    filename: 'founder-update.eml', mime: 'message/rfc822',
    content: Buffer.from('Revenue grew and runway declined.'),
  });

  const created = await createInvestmentUpdate({
    investmentId: investment.id,
    sourceDocumentId: document.id,
    updateKind: 'founder_update',
    receivedDate: '2026-07-31',
    processingMode: 'interpret',
  });
  assert.equal(created.update.status, 'pending');
  const completed = await completeInvestmentUpdate(created.update.id, {
    summary: 'Growth improved while runway shortened.',
    observedChanges: [{ area: 'runway', current: '9 months' }],
    proposedFacts: [{ field: 'runway_months', proposed_value: 9 }],
    evaluationSignals: [{ dimension: 'viability', direction: 'negative' }],
    actions: [{ title: 'Review financing plan', urgency: 'soon' }],
    model: 'test-model',
  });
  assert.equal(completed.status, 'complete');
  assert.equal(completed.proposed_facts[0].field, 'runway_months');
  assert.equal((await listInvestmentUpdates(investment.id))[0].filename, 'founder-update.eml');
  assert.equal((await getInvestmentUpdate(created.update.id)).previous_source_document_id, null);

  const storedDocument = await createDocument({
    entity_type: 'investment', entity_id: investment.id,
    filename: 'board-deck.pdf', mime: 'application/pdf', content: Buffer.from('stored'),
  });
  const stored = await createInvestmentUpdate({
    investmentId: investment.id, sourceDocumentId: storedDocument.id,
    updateKind: 'founder_update', receivedDate: '2026-08-01', processingMode: 'store_only',
  });
  assert.equal(stored.update.status, 'stored');
  assert.equal(stored.update.previous_update_id, created.update.id);

  const failedDocument = await createDocument({
    entity_type: 'investment', entity_id: investment.id,
    filename: 'retry.txt', mime: 'text/plain', content: Buffer.from('retry'),
  });
  const retryable = await createInvestmentUpdate({
    investmentId: investment.id, sourceDocumentId: failedDocument.id,
    updateKind: 'general', receivedDate: '2026-08-02', processingMode: 'interpret',
  });
  await failInvestmentUpdate(retryable.update.id, 'model unavailable');
  assert.equal((await retryInvestmentUpdate(retryable.update.id)).status, 'pending');

  await assert.rejects(() => createInvestmentUpdate({
    investmentId: investment.id + 999,
    sourceDocumentId: document.id,
    updateKind: 'general',
    receivedDate: '2026-08-02',
    processingMode: 'store_only',
  }), /same investment/);

  console.log('Investment update tests passed');
  });
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
