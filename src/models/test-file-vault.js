#!/usr/bin/env node

import assert from 'node:assert/strict';
import { query } from '../db/index.js';
import { accessDocumentBytes } from './documents.js';
import { createVaultFile, listVaultFiles } from './file-vault.js';

const title = `Test life policy ${Date.now()}`;
const investmentTitle = `Test investment record ${Date.now()}`;

try {
  const created = await createVaultFile({
    title,
    category: 'life_insurance',
    ownerName: 'Test household',
    documentDate: '2026-08-20',
    notes: 'Regression fixture',
    filename: 'term-life-policy.pdf',
    mime: 'application/pdf',
    content: Buffer.from('%PDF-file-vault-test'),
    executionMode: 'desktop',
  });

  assert.equal(created.title, title);
  assert.equal(created.document.confidentiality, 'personal_sensitive');
  assert.equal(created.document.processing_policy, 'local_only');
  assert.equal(created.document.sync_policy, 'encrypted_backup_allowed');

  const rows = await listVaultFiles({ category: 'life_insurance' });
  const stored = rows.find(row => row.id === created.id);
  assert.ok(stored, 'created vault entry is listed');
  assert.equal(stored.filename, 'term-life-policy.pdf');
  assert.equal(stored.owner_name, 'Test household');

  const [investment] = await query(`
    INSERT INTO investments (company_name, status, invest_date, source, asset_class)
    VALUES ('Vault Test Investment', 'Live', '2026-08-20', 'test', 'direct')
    RETURNING id
  `);
  const linked = await createVaultFile({
    title: investmentTitle,
    category: 'investments',
    relatedEntityType: 'investment',
    relatedEntityId: investment.id,
    relatedLabel: 'Vault Test Investment',
    filename: 'investment-record.pdf',
    mime: 'application/pdf',
    content: Buffer.from('%PDF-investment-record'),
    executionMode: 'desktop',
  });
  const linkedRows = await listVaultFiles({
    relatedEntityType: 'investment',
    relatedEntityId: investment.id,
  });
  assert.deepEqual(linkedRows.map(row => row.id), [linked.id]);
  assert.equal(linkedRows[0].related_label, 'Vault Test Investment');

  await assert.rejects(
    () => accessDocumentBytes({
      documentId: stored.document_id,
      purpose: 'model',
      executionMode: 'desktop',
    }),
    error => error?.code === 'DOCUMENT_POLICY_DENIED',
  );

  const downloaded = await accessDocumentBytes({
    documentId: stored.document_id,
    purpose: 'download',
    executionMode: 'desktop',
  });
  assert.equal(Buffer.from(downloaded.content).toString(), '%PDF-file-vault-test');

  await assert.rejects(
    () => createVaultFile({
      title: 'Bad category',
      category: 'not_real',
      filename: 'bad.txt',
      content: Buffer.from('bad'),
      executionMode: 'desktop',
    }),
    /valid file-vault category/,
  );

  console.log('file-vault: private household document storage passed');
} finally {
  const rows = await query(`SELECT id FROM file_vault_entries WHERE title = ANY($1::text[])`, [[title, investmentTitle]]);
  if (rows.length > 0) {
    await query(`DELETE FROM documents WHERE entity_type = 'file_vault_entry' AND entity_id = ANY($1::text[])`, [rows.map(row => row.id)]);
    await query(`DELETE FROM file_vault_entries WHERE id = ANY($1::uuid[])`, [rows.map(row => row.id)]);
  }
  await query(`DELETE FROM investments WHERE company_name = 'Vault Test Investment' AND source = 'test'`);
}
