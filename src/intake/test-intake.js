#!/usr/bin/env node

// Integration tests for src/intake — classifyArtifact, intakePreview,
// intakeCommit. Hits the real DATABASE_URL; run under npm run test:local for
// throwaway PGlite (also runs against Neon under `npm test`).
//
// Run: node src/intake/test-intake.js

import { readFileSync, readdirSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db/index.js';
import { upsertInvestment } from '../models/investments.js';
import { classifyArtifact, intakePreview, intakeCommit, withTx } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

function arrEq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${e}, got ${a}`);
  }
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
  await query(`DELETE FROM company_updates WHERE investment_id = ANY($1::int[])`, [ids]);
  await query(`DELETE FROM deal_evaluations WHERE investment_id = ANY($1::int[])`, [ids]);
  await query(`DELETE FROM pipeline_invites WHERE investment_id = ANY($1::int[])`, [ids]);
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

// Wraps the existing (HTML-only) sync fixture in a synthetic RFC822 envelope
// — there is no real .eml fixture in the repo to reuse, so this builds one
// from the SAME fixture content src/sync/test-fixtures/test-parser.js
// already exercises, rather than inventing new golden content.
function buildInviteEml({ messageId = 'msg-intake-test-000000000001' } = {}) {
  const html = readFileSync(
    join(__dirname, '..', 'sync', 'test-fixtures', 'angellist-invite-sample.html'),
    'utf-8'
  );
  const eml = [
    'From: AngelList <portal@angellist.com>',
    'To: test@example.com',
    'Subject: Example Syndicate invited you to invest in Acme Autonomy (YC W24)',
    'Date: Thu, 15 Jan 2026 10:00:00 +0000',
    `Message-ID: <${messageId}@mail.gmail.com>`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    html,
  ].join('\r\n');
  return Buffer.from(eml, 'utf-8');
}

function dealLogFixtures() {
  const dir = join(__dirname, '..', 'models', 'test-fixtures', 'deal-log');
  return readdirSync(dir).filter(f => f.endsWith('.md')).map(f => ({
    filename: f,
    content: readFileSync(join(dir, f), 'utf-8'),
  }));
}

async function domainCounts() {
  const [pi, cu, de, doc] = await Promise.all([
    query(`SELECT count(*)::int AS n FROM pipeline_invites`),
    query(`SELECT count(*)::int AS n FROM company_updates`),
    query(`SELECT count(*)::int AS n FROM deal_evaluations`),
    query(`SELECT count(*)::int AS n FROM documents`),
  ]);
  return { pipeline_invites: pi[0].n, company_updates: cu[0].n, deal_evaluations: de[0].n, documents: doc[0].n };
}

async function run() {
  const stamp = Date.now();

  // -------------------------------------------------------------------
  // classifyArtifact — one family per branch
  // -------------------------------------------------------------------

  await test('classifyArtifact: AngelList invite .eml -> pipeline_invite, high confidence', () => {
    const eml = buildInviteEml();
    const result = classifyArtifact(eml, 'invite.eml', 'message/rfc822');
    eq(result.type, 'pipeline_invite');
    eq(result.confidence, 'high');
    eq(result.parsed.company_name, 'Acme Autonomy (YC W24)');
    eq(result.parsed.lead, 'Example Syndicate');
  });

  for (const fixture of dealLogFixtures()) {
    await test(`classifyArtifact: deal-log fixture ${fixture.filename} -> deal_log_eval, high confidence`, () => {
      const result = classifyArtifact(Buffer.from(fixture.content), fixture.filename, 'text/markdown');
      eq(result.type, 'deal_log_eval');
      eq(result.confidence, 'high');
      ok(result.parsed.company_name, 'company_name extracted');
    });
  }

  await test('classifyArtifact: synthetic founder-update text (no frontmatter/grammar) -> company_update, low confidence', () => {
    const text = 'Hey Chandler,\n\nQuick update on how things are going this month. Revenue is up, team is heads-down.\n\nBest,\nJane';
    const result = classifyArtifact(Buffer.from(text), 'update.txt', 'text/plain');
    eq(result.type, 'company_update');
    eq(result.confidence, 'low');
  });

  await test('classifyArtifact: fake PDF buffer -> document, high confidence (stored, not parsed)', () => {
    const result = classifyArtifact(Buffer.from('%PDF-1.4\n%fake pdf bytes for a test fixture'), 'deck.pdf', 'application/pdf');
    eq(result.type, 'document');
    eq(result.confidence, 'high');
    eq(result.parsed, null);
  });

  await test('classifyArtifact: random bytes -> unknown', () => {
    const result = classifyArtifact(randomBytes(256), 'blob', undefined);
    eq(result.type, 'unknown');
  });

  await test('classifyArtifact: empty buffer -> unknown', () => {
    const result = classifyArtifact(Buffer.alloc(0), 'empty', undefined);
    eq(result.type, 'unknown');
  });

  // -------------------------------------------------------------------
  // intakePreview — zero domain writes invariant
  // -------------------------------------------------------------------

  await test('intakePreview: zero writes to domain tables across every artifact family (only pending_intake changes)', async () => {
    const before = await domainCounts();

    await intakePreview({ content: buildInviteEml({ messageId: `msg-zero-write-${stamp}` }), filename: 'invite.eml', mime: 'message/rfc822' });
    const fixture = dealLogFixtures()[0];
    await intakePreview({ content: Buffer.from(fixture.content), filename: fixture.filename, mime: 'text/markdown' });
    await intakePreview({ content: Buffer.from(`---\ncompany: Zero Write Co ${stamp}\nquarter: Q1 2026\ndate: 2026-01-01\narr: 100\n---\nbody`), filename: 'u.md', mime: 'text/markdown' });
    await intakePreview({ content: Buffer.from('%PDF-1.4 zero write test'), filename: 'x.pdf', mime: 'application/pdf' });
    await intakePreview({ content: randomBytes(64), filename: 'blob', mime: undefined });

    const after = await domainCounts();
    eq(after.pipeline_invites, before.pipeline_invites, 'pipeline_invites unchanged');
    eq(after.company_updates, before.company_updates, 'company_updates unchanged');
    eq(after.deal_evaluations, before.deal_evaluations, 'deal_evaluations unchanged');
    eq(after.documents, before.documents, 'documents unchanged');
  });

  // -------------------------------------------------------------------
  // Full commit per type — domain row + document + attachment matrix
  // -------------------------------------------------------------------

  await test('intakeCommit: pipeline_invite -> pipeline_invites row + document attached to it, sha matches', async () => {
    const eml = buildInviteEml({ messageId: `msg-commit-invite-${stamp}` });
    const preview = await intakePreview({ content: eml, filename: 'invite.eml', mime: 'message/rfc822' });
    eq(preview.type, 'pipeline_invite');
    const commit = await intakeCommit({ preview_id: preview.preview_id, overrides: {} });
    eq(commit.idempotent_replay, false);
    eq(commit.created.table, 'pipeline_invites');

    const inviteRows = await query(`SELECT id, company_name, source FROM pipeline_invites WHERE id = $1`, [commit.created.id]);
    eq(inviteRows.length, 1, 'invite row exists');
    eq(inviteRows[0].company_name, 'Acme Autonomy (YC W24)');

    const docRows = await query(`SELECT entity_type, entity_id, sha256, source FROM documents WHERE id = $1`, [commit.document_id]);
    eq(docRows.length, 1, 'document row exists');
    eq(docRows[0].entity_type, 'pipeline_invite', 'attachment matrix: pipeline_invite -> entity_type pipeline_invite');
    eq(docRows[0].entity_id, commit.created.id, 'document attaches to the created invite id');
    eq(docRows[0].sha256, createHash('sha256').update(eml).digest('hex'), 'document sha256 matches source bytes');
    eq(docRows[0].source, 'intake');
  });

  await test('intakeCommit: deal_log_eval -> deal_evaluations row + document attached to it (entity_type deal_evaluation)', async () => {
    const fixture = dealLogFixtures().find(f => f.filename.includes('acme-autonomy'));
    const content = Buffer.from(fixture.content);
    const preview = await intakePreview({ content, filename: `commit-${stamp}-${fixture.filename}`, mime: 'text/markdown' });
    eq(preview.type, 'deal_log_eval');
    const commit = await intakeCommit({ preview_id: preview.preview_id, overrides: {} });
    eq(commit.created.table, 'deal_evaluations');

    const evalRows = await query(`SELECT id, company_name, total_score, raw_content FROM deal_evaluations WHERE id = $1`, [commit.created.id]);
    eq(evalRows.length, 1);
    eq(evalRows[0].company_name, 'Acme Autonomy');
    eq(evalRows[0].raw_content, content.toString('utf-8'), 'verbatim raw_content stored');

    const docRows = await query(`SELECT entity_type, entity_id, sha256 FROM documents WHERE id = $1`, [commit.document_id]);
    eq(docRows[0].entity_type, 'deal_evaluation', 'attachment matrix: deal_log_eval -> entity_type deal_evaluation');
    eq(docRows[0].entity_id, commit.created.id);
    eq(docRows[0].sha256, createHash('sha256').update(content).digest('hex'));
  });

  await test('intakeCommit: company_update (matched company) -> company_updates row + document attached to it', async () => {
    const company = `Intake Commit Update Co ${stamp}`;
    try {
      await upsertInvestment({ ...BASE_INVESTMENT, company_name: company, invest_date: '2025-06-01' });
      const md = `---\ncompany: ${company}\nquarter: Q2 2026\ndate: 2026-07-01\narr: 1200000\nburn: 80000\nheadcount: 12\n---\n\n# ${company} — Q2 2026 Update\n\n## From the Founders\nGreat quarter.\n`;
      const content = Buffer.from(md);
      const preview = await intakePreview({ content, filename: 'update.md', mime: 'text/markdown' });
      eq(preview.type, 'company_update');
      eq(preview.confidence, 'high');
      eq(preview.required_overrides.length, 0, 'matched company needs no override');

      const commit = await intakeCommit({ preview_id: preview.preview_id, overrides: {} });
      eq(commit.created.table, 'company_updates');

      const rows = await query(`SELECT id, company_name, revenue_arr, file_path FROM company_updates WHERE id = $1`, [commit.created.id]);
      eq(rows.length, 1);
      eq(rows[0].company_name, company);
      eq(Number(rows[0].revenue_arr), 1200000);
      ok(rows[0].file_path.startsWith('intake:'), 'synthetic file_path marker for an intake artifact');

      const docRows = await query(`SELECT entity_type, entity_id FROM documents WHERE id = $1`, [commit.document_id]);
      eq(docRows[0].entity_type, 'company_update', 'attachment matrix: company_update -> entity_type company_update');
      eq(docRows[0].entity_id, commit.created.id);
    } finally {
      await cleanupCompany(company);
    }
  });

  await test('intakeCommit: document (PDF) with entity override -> no domain row, document attaches to chosen entity', async () => {
    const company = `Intake Commit PDF Co ${stamp}`;
    try {
      const investment = await upsertInvestment({ ...BASE_INVESTMENT, company_name: company, invest_date: '2025-07-01' });
      const content = Buffer.from('%PDF-1.4 pdf commit test fixture');
      const preview = await intakePreview({ content, filename: 'deck.pdf', mime: 'application/pdf' });
      eq(preview.type, 'document');
      arrEq(preview.required_overrides, ['entity']);

      const commit = await intakeCommit({
        preview_id: preview.preview_id,
        overrides: { entity_type: 'investment', entity_id: investment.id },
      });
      eq(commit.created, null, 'document type creates no domain row');

      const docRows = await query(`SELECT entity_type, entity_id, sha256 FROM documents WHERE id = $1`, [commit.document_id]);
      eq(docRows[0].entity_type, 'investment');
      eq(docRows[0].entity_id, investment.id);
      eq(docRows[0].sha256, createHash('sha256').update(content).digest('hex'));
    } finally {
      await cleanupCompany(company);
    }
  });

  // -------------------------------------------------------------------
  // Idempotent double-commit
  // -------------------------------------------------------------------

  await test('intakeCommit: double-commit same preview_id -> same refs, no duplicates, idempotent_replay true on the 2nd call', async () => {
    const fixture = dealLogFixtures().find(f => f.filename.includes('borealis'));
    const content = Buffer.from(fixture.content);
    const preview = await intakePreview({ content, filename: `dbl-${stamp}-${fixture.filename}`, mime: 'text/markdown' });

    const before = await domainCounts();
    const first = await intakeCommit({ preview_id: preview.preview_id, overrides: {} });
    eq(first.idempotent_replay, false);
    const afterFirst = await domainCounts();
    eq(afterFirst.deal_evaluations, before.deal_evaluations + 1);
    eq(afterFirst.documents, before.documents + 1);

    const second = await intakeCommit({ preview_id: preview.preview_id, overrides: {} });
    eq(second.idempotent_replay, true);
    eq(second.created.id, first.created.id, 'same domain row id on replay');
    eq(second.created.table, first.created.table);
    eq(second.document_id, first.document_id, 'same document id on replay');

    const afterSecond = await domainCounts();
    eq(afterSecond.deal_evaluations, afterFirst.deal_evaluations, 'no duplicate eval row created');
    eq(afterSecond.documents, afterFirst.documents, 'no duplicate document created');
  });

  // -------------------------------------------------------------------
  // Unmet required_overrides
  // -------------------------------------------------------------------

  await test('intakeCommit: unmet required_overrides (unknown, no type override) rejects; nothing created', async () => {
    const before = await domainCounts();
    const preview = await intakePreview({ content: randomBytes(48), filename: 'blob', mime: undefined });
    eq(preview.type, 'unknown');
    arrEq(preview.required_overrides, ['type']);

    await expectRejects(
      () => intakeCommit({ preview_id: preview.preview_id, overrides: {} }),
      /required overrides unmet/
    );

    const after = await domainCounts();
    eq(after.documents, before.documents, 'no document created on rejected commit');

    const pendingRows = await query(`SELECT status FROM pending_intake WHERE id = $1`, [preview.preview_id]);
    eq(pendingRows[0].status, 'pending', 'pending row stays pending after a rejected commit');
  });

  await test('intakeCommit: unmet required_overrides (company_update, no company match, no entity override) rejects; nothing created', async () => {
    const md = `---\ncompany: Nonexistent Match Co ${stamp}\nquarter: Q1 2026\ndate: 2026-01-01\narr: 100\n---\nbody`;
    const before = await domainCounts();
    const preview = await intakePreview({ content: Buffer.from(md), filename: 'u.md', mime: 'text/markdown' });
    eq(preview.type, 'company_update');
    arrEq(preview.required_overrides, ['entity']);

    await expectRejects(
      () => intakeCommit({ preview_id: preview.preview_id, overrides: {} }),
      /required overrides unmet/
    );

    const after = await domainCounts();
    eq(after.company_updates, before.company_updates, 'no company_updates row created on rejected commit');
  });

  // -------------------------------------------------------------------
  // Expired preview
  // -------------------------------------------------------------------

  await test('intakeCommit: expired preview -> error', async () => {
    const preview = await intakePreview({ content: Buffer.from('expired preview fixture'), filename: 'x.txt', mime: 'text/plain' });
    await query(`UPDATE pending_intake SET expires_at = NOW() - interval '1 hour' WHERE id = $1`, [preview.preview_id]);

    await expectRejects(
      () => intakeCommit({ preview_id: preview.preview_id, overrides: { type: 'document', entity_type: 'investment', entity_id: 1 } }),
      /missing or expired/
    );
  });

  // -------------------------------------------------------------------
  // FILE_TOO_LARGE / UNSUPPORTED_MIME preview errors
  // -------------------------------------------------------------------

  await test('intakePreview: FILE_TOO_LARGE for a >10MB artifact', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 1);
    const preview = await intakePreview({ content: big, filename: 'big.bin', mime: 'application/octet-stream' });
    eq(preview.error, 'FILE_TOO_LARGE');
  });

  await test('intakePreview: UNSUPPORTED_MIME for an unclassifiable zip', async () => {
    const preview = await intakePreview({ content: Buffer.from('PK\x03\x04 not a real zip but binary-ish'), filename: 'x.zip', mime: 'application/zip' });
    eq(preview.error, 'UNSUPPORTED_MIME');
  });

  await test('intakePreview: UNSUPPORTED_MIME for an image', async () => {
    const preview = await intakePreview({ content: randomBytes(64), filename: 'photo.png', mime: 'image/png' });
    eq(preview.error, 'UNSUPPORTED_MIME');
  });

  // -------------------------------------------------------------------
  // withTx — transaction honesty (documented in src/intake/index.js)
  // -------------------------------------------------------------------

  await test("withTx: PGlite rolls back on failure (only exercised meaningfully under test:local's PGlite driver)", async () => {
    await query(`CREATE TABLE IF NOT EXISTS _test_withtx (x INT)`);
    try {
      await query(`DELETE FROM _test_withtx`);
      await expectRejects(() => withTx(async () => {
        await query(`INSERT INTO _test_withtx (x) VALUES (1)`);
        throw new Error('forced failure inside withTx');
      }), /forced failure/);

      const rows = await query(`SELECT * FROM _test_withtx`);
      // On PGlite: the INSERT rolls back with the rest of the transaction,
      // so the table is empty. On Neon (no real cross-statement transaction,
      // see withTx's doc comment): the INSERT already committed before the
      // throw, so this assertion is PGlite-specific — skip it there rather
      // than assert a guarantee withTx never claimed to provide.
      const { isPgliteActive } = await import('../db/index.js');
      if (await isPgliteActive()) {
        eq(rows.length, 0, 'PGlite: statements inside a failed withTx roll back');
      }
    } finally {
      await query(`DROP TABLE IF EXISTS _test_withtx`);
    }
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
