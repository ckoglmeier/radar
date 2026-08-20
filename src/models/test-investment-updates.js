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
const { createCommandProposal, getCommandProposal } = await import('./command-proposals.js');
const {
  completeInvestmentUpdate,
  createInvestmentUpdate,
  failInvestmentUpdate,
  getInvestmentUpdate,
  listInvestmentUpdates,
  reviewInvestmentUpdate,
  retryInvestmentUpdate,
  updateInvestmentUpdateMetadata,
} = await import('./investment-updates.js');

try {
  await withTenant(databaseUrl, async () => {
  await runMigrations();
  const investment = await upsertInvestment({
    company_name: 'Source Backed Update Test', invest_date: '2026-01-01',
    status: 'Live', invested: 1000, source: 'test', asset_class: 'direct',
  });
  const fund = await upsertInvestment({
    company_name: 'Source Backed Fund I', invest_date: '2024-01-01',
    status: 'Live', invested: 1000, source: 'test', asset_class: 'fund',
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
  assert.equal(completed.review_status, 'pending_review');
  assert.equal(completed.proposed_facts[0].field, 'runway_months');
  assert.equal((await listInvestmentUpdates(investment.id))[0].filename, 'founder-update.eml');
  assert.equal((await getInvestmentUpdate(created.update.id)).previous_source_document_id, null);
  const reviewed = await reviewInvestmentUpdate(created.update.id, {
    outcome: 'reviewed_no_changes', reviewedBy: 'test-reviewer',
  });
  assert.equal(reviewed.update.review_status, 'reviewed_no_changes');
  assert.equal(reviewed.update.reviewed_by, 'test-reviewer');
  assert.equal((await reviewInvestmentUpdate(created.update.id, {
    outcome: 'reviewed_no_changes', reviewedBy: 'test-reviewer',
  })).idempotent_replay, true);

  const proposedDocument = await createDocument({
    entity_type: 'investment', entity_id: investment.id,
    filename: 'proposal-update.txt', mime: 'text/plain', content: Buffer.from('candidate fact'),
  });
  const proposedUpdate = await createInvestmentUpdate({
    investmentId: investment.id, sourceDocumentId: proposedDocument.id,
    updateKind: 'general', receivedDate: '2026-08-01', processingMode: 'interpret',
  });
  await completeInvestmentUpdate(proposedUpdate.update.id, { summary: 'Candidate fact.' });
  const linkedProposal = await createCommandProposal({
    originSurface: 'investment_update', actorType: 'test', sourceDocumentId: proposedDocument.id,
    sourceUpdateId: proposedUpdate.update.id, commands: [{ name: 'test' }], previews: [],
    commandSetHash: 'test-linked-update-hash', idempotencyKey: 'test-linked-update', registryVersion: 'test',
  });
  const closed = await reviewInvestmentUpdate(proposedUpdate.update.id, {
    outcome: 'interpretation_rejected', reviewedBy: 'test-reviewer',
  });
  assert.equal(closed.update.review_status, 'interpretation_rejected');
  assert.equal((await getCommandProposal(linkedProposal.proposal.id)).status, 'rejected');

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

  const corrected = await updateInvestmentUpdateMetadata(stored.update.id, {
    receivedDate: '2026-07-01',
  });
  assert.equal(corrected.received_date.toISOString().slice(0, 10), '2026-07-01');
  await assert.rejects(() => updateInvestmentUpdateMetadata(stored.update.id, {
    receivedDate: '2100-01-01',
  }), /future/);

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

  const k1Document = await createDocument({
    entity_type: 'investment', entity_id: fund.id,
    filename: '2025-k1.pdf', mime: 'application/pdf', content: Buffer.from('Schedule K-1'),
  });
  const k1 = await createInvestmentUpdate({
    investmentId: fund.id, sourceDocumentId: k1Document.id,
    updateKind: 'fund_k1', taxYear: 2025,
    receivedDate: '2026-03-15', processingMode: 'store_only',
  });
  assert.equal(k1.update.update_kind, 'fund_k1');
  assert.equal(Number(k1.update.tax_year), 2025);

  await assert.rejects(() => createInvestmentUpdate({
    investmentId: investment.id, sourceDocumentId: document.id,
    updateKind: 'fund_k1', taxYear: 2025,
    receivedDate: '2026-03-15', processingMode: 'store_only',
  }), /Fund investment/);

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
