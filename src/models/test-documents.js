#!/usr/bin/env node

// Integration tests for the documents + pending_intake model.
// Hits the real DATABASE_URL; run under npm run test:local for throwaway PGlite.
//
// Run: node src/models/test-documents.js

import { randomBytes, createHash } from 'crypto';
import { query } from '../db/index.js';
import { upsertInvestment } from './investments.js';
import {
  createDocument,
  listDocuments,
  getDocument,
  findBySha,
  orphanReport,
  createPendingIntake,
  getPendingIntake,
  markPendingCommitted,
  sweepExpiredPending,
} from './documents.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function eq(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function ok(value, msg = 'expected truthy value') {
  if (!value) throw new Error(msg);
}

async function expectRejects(fn, pattern) {
  let caught = null;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  if (!caught) throw new Error('expected function to reject');
  if (pattern && !pattern.test(caught.message)) {
    throw new Error(`expected error matching ${pattern}, got ${caught.message}`);
  }
}

async function cleanupCompany(company) {
  const rows = await query(`SELECT id FROM investments WHERE company_name = $1`, [company]);
  if (rows.length === 0) return;
  const ids = rows.map(r => r.id);
  await query(`DELETE FROM documents WHERE entity_type = 'investment' AND entity_id = ANY($1::int[])`, [ids]);
  await query(`DELETE FROM investment_theses WHERE investment_id = ANY($1::int[])`, [ids]);
  await query(`DELETE FROM investments WHERE id = ANY($1::int[])`, [ids]);
}

const BASE_INVESTMENT = {
  status: 'Live',
  invested: 5000,
  unrealized_value: null,
  realized_value: null,
  net_value: null,
  multiple: null,
  investment_entity: null,
  lead: 'Apex Syndicate',
  investment_type: null,
  round: 'Seed',
  stage_bucket: null,
  market: 'AI',
  fund_name: null,
  allocation: null,
  instrument: null,
  round_size: null,
  valuation_cap_type: null,
  valuation_cap: null,
  discount: null,
  carry: null,
  share_class: null,
  source: 'test',
};

async function run() {
  const stamp = Date.now();

  await test('createDocument round-trips content byte-identical (incl. null bytes)', async () => {
    const company = `Test Documents Roundtrip ${stamp}-1`;
    try {
      const investment = await upsertInvestment({
        ...BASE_INVESTMENT,
        company_name: company,
        invest_date: '2026-07-12',
      });

      const buf = randomBytes(4096);
      buf[0] = 0x00;
      buf[1] = 0x00;
      buf[2000] = 0x00;
      buf[4095] = 0x00;
      const shaBefore = createHash('sha256').update(buf).digest('hex');

      const doc = await createDocument({
        entity_type: 'investment',
        entity_id: investment.id,
        filename: 'update.pdf',
        mime: 'application/pdf',
        content: buf,
        source: 'manual-upload',
      });
      eq(doc.sha256, shaBefore, 'computed sha256 matches source buffer');
      eq(doc.size_bytes, buf.length);

      const full = await getDocument(doc.id);
      const readBuf = Buffer.isBuffer(full.content) ? full.content : Buffer.from(full.content);
      eq(readBuf.length, buf.length, 'byte length preserved');
      const shaAfter = createHash('sha256').update(readBuf).digest('hex');
      eq(shaAfter, shaBefore, 'sha256 of read-back content matches original');
    } finally {
      await cleanupCompany(company);
    }
  });

  await test('createDocument rejects a nonexistent entity_id', async () => {
    await expectRejects(
      () => createDocument({
        entity_type: 'investment',
        entity_id: 999999999,
        filename: 'x.txt',
        mime: 'text/plain',
        content: Buffer.from('hi'),
      }),
      /not found/
    );
  });

  await test('createDocument rejects an unknown entity_type', async () => {
    await expectRejects(
      () => createDocument({
        entity_type: 'not_a_real_type',
        entity_id: 1,
        filename: 'x.txt',
        mime: 'text/plain',
        content: Buffer.from('hi'),
      }),
      /unknown entity_type/
    );
  });

  await test('createDocument enforces the 10MB size cap', async () => {
    const company = `Test Documents SizeCap ${stamp}-2`;
    try {
      const investment = await upsertInvestment({
        ...BASE_INVESTMENT,
        company_name: company,
        invest_date: '2026-07-13',
      });
      const big = Buffer.alloc(11 * 1024 * 1024, 1);
      await expectRejects(
        () => createDocument({
          entity_type: 'investment',
          entity_id: investment.id,
          filename: 'big.bin',
          mime: 'application/octet-stream',
          content: big,
        }),
        /cap/
      );
    } finally {
      await cleanupCompany(company);
    }
  });

  await test('createDocument rejects a supplied sha256 that does not match content', async () => {
    const company = `Test Documents ShaMismatch ${stamp}-3`;
    try {
      const investment = await upsertInvestment({
        ...BASE_INVESTMENT,
        company_name: company,
        invest_date: '2026-07-14',
      });
      await expectRejects(
        () => createDocument({
          entity_type: 'investment',
          entity_id: investment.id,
          filename: 'x.txt',
          mime: 'text/plain',
          sha256: 'deadbeef'.repeat(8),
          content: Buffer.from('actual content'),
        }),
        /sha256 mismatch/
      );
    } finally {
      await cleanupCompany(company);
    }
  });

  await test('listDocuments returns metadata only, never content', async () => {
    const company = `Test Documents List ${stamp}-4`;
    try {
      const investment = await upsertInvestment({
        ...BASE_INVESTMENT,
        company_name: company,
        invest_date: '2026-07-15',
      });
      await createDocument({
        entity_type: 'investment',
        entity_id: investment.id,
        filename: 'a.txt',
        mime: 'text/plain',
        content: Buffer.from('hello world'),
      });
      const rows = await listDocuments('investment', investment.id);
      eq(rows.length, 1);
      ok(!('content' in rows[0]), 'content field absent from listDocuments rows');
      eq(rows[0].filename, 'a.txt');
      ok(rows[0].sha256, 'sha256 present');
      ok(rows[0].size_bytes > 0, 'size_bytes present');
    } finally {
      await cleanupCompany(company);
    }
  });

  await test('findBySha finds the duplicate by content hash', async () => {
    const company = `Test Documents FindSha ${stamp}-5`;
    try {
      const investment = await upsertInvestment({
        ...BASE_INVESTMENT,
        company_name: company,
        invest_date: '2026-07-16',
      });
      const content = Buffer.from('duplicate-detection-fixture');
      const doc = await createDocument({
        entity_type: 'investment',
        entity_id: investment.id,
        filename: 'dup.txt',
        mime: 'text/plain',
        content,
      });
      const matches = await findBySha(doc.sha256);
      ok(matches.some(m => m.id === doc.id), 'findBySha returns the created document');
    } finally {
      await cleanupCompany(company);
    }
  });

  await test('pending intake lifecycle: create -> get -> markCommitted -> get reflects status', async () => {
    const content = Buffer.from('pending intake fixture content');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const preview = { type: 'company_update', confidence: 'high', fields: { company_name: 'Acme' } };

    const created = await createPendingIntake({
      filename: 'update.md',
      mime: 'text/markdown',
      sha256,
      content,
      preview,
    });
    ok(created.id, 'pending row has an id');
    eq(created.status, 'pending');

    const fetched = await getPendingIntake(created.id);
    ok(fetched, 'getPendingIntake returns the row');
    eq(fetched.sha256, sha256);
    eq(fetched.preview.type, 'company_update');
    const readBuf = Buffer.isBuffer(fetched.content) ? fetched.content : Buffer.from(fetched.content);
    eq(readBuf.toString(), content.toString(), 'pending content round-trips');

    const createdRefs = { table: 'company_updates', id: 42 };
    await markPendingCommitted(created.id, createdRefs);

    const afterCommit = await getPendingIntake(created.id);
    ok(afterCommit, 'row still fetchable after commit');
    eq(afterCommit.status, 'committed');
    eq(afterCommit.created_refs.id, 42);
  });

  await test('getPendingIntake returns null for an expired row', async () => {
    const content = Buffer.from('expired fixture');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const created = await createPendingIntake({
      filename: 'expired.txt',
      mime: 'text/plain',
      sha256,
      content,
      preview: { type: 'unknown' },
      ttlHours: 24,
    });
    // Force it into the past directly (createPendingIntake only accepts a
    // forward TTL) so the "already expired" path is exercised.
    await query(`UPDATE pending_intake SET expires_at = NOW() - interval '1 hour' WHERE id = $1`, [created.id]);

    const fetched = await getPendingIntake(created.id);
    eq(fetched, null, 'expired row is not returned');
  });

  await test('sweepExpiredPending deletes only expired pending rows', async () => {
    const content = Buffer.from('sweep fixture');
    const sha256 = createHash('sha256').update(content).digest('hex');

    const toExpire = await createPendingIntake({
      filename: 'sweep-me.txt',
      mime: 'text/plain',
      sha256,
      content,
      preview: { type: 'unknown' },
      ttlHours: 24,
    });
    await query(`UPDATE pending_intake SET expires_at = NOW() - interval '1 hour' WHERE id = $1`, [toExpire.id]);

    const stillValid = await createPendingIntake({
      filename: 'keep-me.txt',
      mime: 'text/plain',
      sha256,
      content,
      preview: { type: 'unknown' },
      ttlHours: 24,
    });

    const deletedCount = await sweepExpiredPending();
    ok(deletedCount >= 1, 'sweep reports at least the one expired row deleted');

    const goneRows = await query(`SELECT id FROM pending_intake WHERE id = $1`, [toExpire.id]);
    eq(goneRows.length, 0, 'expired row physically deleted');

    const keptRows = await query(`SELECT id FROM pending_intake WHERE id = $1`, [stillValid.id]);
    eq(keptRows.length, 1, 'unexpired row untouched by the sweep');
  });

  await test('orphanReport is empty on clean data', async () => {
    const company = `Test Documents Orphan ${stamp}-6`;
    try {
      const investment = await upsertInvestment({
        ...BASE_INVESTMENT,
        company_name: company,
        invest_date: '2026-07-17',
      });
      await createDocument({
        entity_type: 'investment',
        entity_id: investment.id,
        filename: 'clean.txt',
        mime: 'text/plain',
        content: Buffer.from('clean data fixture'),
      });
      const orphans = await orphanReport();
      const ours = orphans.filter(o => o.entity_type === 'investment' && o.entity_id === investment.id);
      eq(ours.length, 0, 'no orphans for a document whose parent row exists');
    } finally {
      await cleanupCompany(company);
    }
  });

  await test('orphanReport surfaces a document whose parent row was removed', async () => {
    const company = `Test Documents Orphan Detect ${stamp}-7`;
    const investment = await upsertInvestment({
      ...BASE_INVESTMENT,
      company_name: company,
      invest_date: '2026-07-18',
    });
    const doc = await createDocument({
      entity_type: 'investment',
      entity_id: investment.id,
      filename: 'will-be-orphaned.txt',
      mime: 'text/plain',
      content: Buffer.from('orphan fixture'),
    });
    try {
      // Bypass the "parents are never hard-deleted" convention on purpose,
      // to exercise the hygiene query itself.
      await query(`DELETE FROM investments WHERE id = $1`, [investment.id]);
      const orphans = await orphanReport();
      ok(orphans.some(o => o.id === doc.id), 'orphanReport finds the document with a missing parent');
    } finally {
      await query(`DELETE FROM documents WHERE id = $1`, [doc.id]);
      await query(`DELETE FROM investments WHERE id = $1`, [investment.id]);
    }
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
