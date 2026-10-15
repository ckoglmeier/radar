import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Scratch HOME so nothing touches a real workspace or settings.
const scratch = mkdtempSync(join(tmpdir(), 'radar-earned-docs-'));
process.env.HOME = scratch;

const { closeDb, query, withTenant } = await import('../db/index.js');
const { runMigrations } = await import('../db/migrate.js');
const { listDocuments, orphanReport } = await import('./documents.js');
const opportunities = await import('./earned-equity-opportunities.js');
const docs = await import('./earned-equity-documents.js');
const od = await import('../intake/offer-documents.js');

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/earned-equity-docs');
const fixture = name => readFileSync(join(fixtures, name));

function makePdf(lines) {
  const esc = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = `BT /F1 11 Tf 50 750 Td 14 TL\n${lines.map(l => `(${esc(l)}) Tj T*`).join('\n')}\nET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed += 1; } catch (error) { console.log(`  ✗ ${name}: ${error.stack?.split('\n').slice(0, 3).join(' | ') || error.message}`); failed += 1; }
}
const code = expected => error => error.code === expected;

const group = id => ({
  schemaVersion: 1, id, mode: 'employment', currency: 'USD', startDate: '2027-01-12', horizonMonths: 48, discountRateAnnual: '0.10',
  baseline: { kind: 'current_role', annualBase: '150000', annualCashBonus: '10000' }, status: 'open',
});
const opp = (id, groupId) => ({ schemaVersion: 1, id, groupId, companyName: `Synthetic ${id}`, relationship: 'employment', lifecycle: 'offer_received' });

try {
  await withTenant(`file:${join(scratch, 'db')}`, async () => {
    await runMigrations();
    await opportunities.createGroup(group('g1'));
    await opportunities.createOpportunity(opp('opp-a', 'g1'));
    await opportunities.createOpportunity(opp('opp-b', 'g1'));
    const sha = buf => createHash('sha256').update(buf).digest('hex');

    console.log('Migration and attachment');
    await test('migration 085 applies and widens the documents entity-type constraint', async () => {
      const [m] = await query('SELECT version FROM schema_migrations WHERE version = 85');
      assert.ok(m);
      const [t] = await query(`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name = 'earned_equity_document_reviews'`);
      assert.equal(t.n, 1);
      const [c] = await query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'documents_entity_type_check'`);
      for (const kind of ['investment', 'file_vault_entry', 'earned_equity_opportunity']) assert.match(c.def, new RegExp(kind));
    });
    await test('offer documents attach to an opportunity as personal_sensitive and local_only by default', async () => {
      const doc = await docs.attachOfferDocument({ opportunityId: 'opp-a', filename: 'synthetic-notice.txt', mime: 'text/plain', content: fixture('grant-notice.txt') });
      assert.equal(doc.entity_type, 'earned_equity_opportunity');
      assert.equal(doc.entity_id, 'opp-a');
      assert.equal(doc.confidentiality, 'personal_sensitive');
      assert.equal(doc.processing_policy, 'local_only');
      const listed = await listDocuments('earned_equity_opportunity', 'opp-a');
      assert.equal(listed.length, 1);
      assert.deepEqual(await orphanReport(), []);
    });
    await test('attaching to an unknown opportunity is rejected', async () => {
      await assert.rejects(() => docs.attachOfferDocument({ opportunityId: 'nope', filename: 'x.txt', content: Buffer.from('x') }), code('not_found'));
    });

    console.log('Analysis of stored bytes');
    let textDocId;
    let pdfDocId;
    await test('a stored text document is analyzed locally into a deterministic proposal', async () => {
      const [{ id }] = await listDocuments('earned_equity_opportunity', 'opp-a');
      textDocId = id;
      const { proposal, text, document } = await docs.analyzeOfferDocument({ documentId: id });
      assert.equal(proposal.docClass, 'grant_notice');
      assert.equal(proposal.assertions.find(a => a.field === 'grant.units').value, '40000');
      assert.equal(proposal.aiReview.ran, false);
      assert.match(text, /STOCK OPTION GRANT NOTICE/);
      assert.equal(document.processingPolicy, 'local_only');
      assert.equal(proposal.documentId, String(id));
    });
    await test('a PDF text layer is extracted through the shared PDF path', async () => {
      const bytes = makePdf(['STOCK OPTION GRANT NOTICE', 'Date of Grant: February 3, 2027', 'The Company grants you an option to purchase 40,000 shares of Common Stock at an exercise price of $1.85 per share.', 'The option vests over 48 months with a 12 month cliff.']);
      const doc = await docs.attachOfferDocument({ opportunityId: 'opp-a', filename: 'synthetic.pdf', mime: 'application/pdf', content: bytes });
      pdfDocId = doc.id;
      const { proposal } = await docs.analyzeOfferDocument({ documentId: doc.id });
      assert.equal(proposal.failure, null);
      assert.equal(proposal.docClass, 'grant_notice');
      assert.equal(proposal.assertions.find(a => a.field === 'grant.strikePrice').value, '1.85');
    });
    await test('an unreadable PDF (no text layer) is a surfaced failure, not an empty success', async () => {
      const doc = await docs.attachOfferDocument({ opportunityId: 'opp-a', filename: 'scan.pdf', mime: 'application/pdf', content: Buffer.from('%PDF-1.4 not really a pdf, scanned image only') });
      const { proposal } = await docs.analyzeOfferDocument({ documentId: doc.id });
      assert.equal(proposal.failure.code, 'pdf_text_unavailable');
      const review = await docs.recordDocumentReview({ opportunityId: 'opp-a', documentId: doc.id, proposal });
      assert.equal(review.status, 'failed');
      assert.equal(review.proposal.assertions.length, 0);
    });
    await test('garbled and empty text files record as failed reviews', async () => {
      for (const name of ['garbled.txt', 'empty.txt']) {
        const doc = await docs.attachOfferDocument({ opportunityId: 'opp-a', filename: name, mime: 'text/plain', content: fixture(name) });
        const { proposal } = await docs.analyzeOfferDocument({ documentId: doc.id });
        assert.ok(proposal.failure);
        const review = await docs.recordDocumentReview({ opportunityId: 'opp-a', documentId: doc.id, proposal });
        assert.equal(review.status, 'failed');
      }
    });
    await test('binary content that is not a supported format fails clearly', async () => {
      const doc = await docs.attachOfferDocument({ opportunityId: 'opp-a', filename: 'blob.bin', mime: 'application/octet-stream', content: Buffer.from([0, 1, 2, 200, 201, 255, 254, 0, 0, 9]) });
      const { proposal } = await docs.analyzeOfferDocument({ documentId: doc.id });
      assert.equal(proposal.failure.code, 'unreadable_binary');
    });

    console.log('Model consent');
    await test('model access is denied until the user explicitly consents', async () => {
      await assert.rejects(() => docs.loadOfferDocumentText({ documentId: textDocId, purpose: 'model' }), code('DOCUMENT_POLICY_DENIED'));
      await assert.rejects(() => docs.setOfferDocumentModelConsent({ documentId: textDocId, allowed: true }), code('consent_required'));
      await assert.rejects(() => docs.setOfferDocumentModelConsent({ documentId: textDocId, allowed: true, userConfirmed: 'yes' }), code('consent_required'));
      const updated = await docs.setOfferDocumentModelConsent({ documentId: textDocId, allowed: true, userConfirmed: true });
      assert.equal(updated.processing_policy, 'model_allowed');
      const loaded = await docs.loadOfferDocumentText({ documentId: textDocId, purpose: 'model' });
      assert.equal(loaded.document.processingPolicy, 'model_allowed');
      const revoked = await docs.setOfferDocumentModelConsent({ documentId: textDocId, allowed: false, userConfirmed: true });
      assert.equal(revoked.processing_policy, 'local_only');
      await assert.rejects(() => docs.loadOfferDocumentText({ documentId: textDocId, purpose: 'model' }), code('DOCUMENT_POLICY_DENIED'));
    });
    await test('consent cannot be set on non-offer documents', async () => {
      await assert.rejects(() => docs.setOfferDocumentModelConsent({ documentId: 999999, allowed: true, userConfirmed: true }), code('not_found'));
    });
    await test('modelAllowed at upload time is an explicit opt-in', async () => {
      const doc = await docs.attachOfferDocument({ opportunityId: 'opp-b', filename: 'consented.txt', mime: 'text/plain', content: fixture('offer-letter.txt'), modelAllowed: true });
      assert.equal(doc.processing_policy, 'model_allowed');
    });

    console.log('Reviews');
    let proposedReview;
    await test('a proposal persists, round-trips and carries no filename', async () => {
      const { proposal } = await docs.analyzeOfferDocument({ documentId: textDocId });
      proposedReview = await docs.recordDocumentReview({ opportunityId: 'opp-a', documentId: textDocId, proposal });
      assert.equal(proposedReview.status, 'proposed');
      assert.equal(proposedReview.docClass, 'grant_notice');
      assert.equal(proposedReview.confirmedOfferRevisionId, null);
      const read = await docs.getDocumentReview(proposedReview.id);
      assert.deepEqual(read.proposal, proposal);
      assert.ok(!JSON.stringify(read.proposal).includes('synthetic-notice'));
      assert.equal((await docs.listDocumentReviews('opp-a', { documentId: textDocId })).length, 1);
      assert.equal((await docs.listDocumentReviews('opp-b')).length, 0);
    });
    await test('a proposal built from other bytes, or for another opportunity, is refused', async () => {
      const { proposal } = await docs.analyzeOfferDocument({ documentId: textDocId });
      await assert.rejects(() => docs.recordDocumentReview({ opportunityId: 'opp-a', documentId: textDocId, proposal: { ...proposal, documentSha256: sha('other') } }), code('hash_mismatch'));
      await assert.rejects(() => docs.recordDocumentReview({ opportunityId: 'opp-b', documentId: textDocId, proposal }), code('not_found'));
      await assert.rejects(() => docs.recordDocumentReview({ opportunityId: 'opp-a', documentId: textDocId, proposal: { ...proposal, assertions: [{ bad: true }] } }), code('invalid_proposal'));
    });
    await test('a re-run inserts a new row; earlier rows are untouched', async () => {
      const { proposal } = await docs.analyzeOfferDocument({ documentId: textDocId });
      const second = await docs.recordDocumentReview({ opportunityId: 'opp-a', documentId: textDocId, proposal });
      assert.ok(second.seq > proposedReview.seq);
      assert.equal((await docs.getDocumentReview(proposedReview.id)).status, 'proposed');
    });

    console.log('Status transitions');
    await test('proposed -> confirmed needs an offer revision of the same opportunity', async () => {
      const rec = od.reconcileProposals([proposedReview.proposal]);
      const { payload } = od.buildOfferRevisionPayload({
        id: 'rev-a1', opportunityId: 'opp-a', asOfDate: '2027-02-10', reconciliation: rec,
        confirmations: ['grant.units', 'grant.strikePrice', 'grant.instrument'].map(field => ({ field, assertionId: rec.fields[field].candidates[0].assertionId })),
      });
      await opportunities.addOfferRevision(payload);
      await opportunities.addOfferRevision({ ...payload, id: 'rev-b-wrong', opportunityId: 'opp-b' }).catch(() => {});
      await assert.rejects(() => docs.confirmDocumentReview({ id: proposedReview.id, offerRevisionId: 'does-not-exist' }), code('invalid_input'));
      const confirmed = await docs.confirmDocumentReview({ id: proposedReview.id, offerRevisionId: 'rev-a1' });
      assert.equal(confirmed.status, 'confirmed');
      assert.equal(confirmed.confirmedOfferRevisionId, 'rev-a1');
      assert.ok(confirmed.status_changed_at);
      assert.deepEqual(confirmed.proposal, proposedReview.proposal, 'proposal content is unchanged by confirmation');
    });
    await test('confirmed, rejected and failed reviews are terminal', async () => {
      await assert.rejects(() => docs.confirmDocumentReview({ id: proposedReview.id, offerRevisionId: 'rev-a1' }), code('invalid_transition'));
      await assert.rejects(() => docs.rejectDocumentReview(proposedReview.id), code('invalid_transition'));
      const { proposal } = await docs.analyzeOfferDocument({ documentId: textDocId });
      const another = await docs.recordDocumentReview({ opportunityId: 'opp-a', documentId: textDocId, proposal });
      const rejected = await docs.rejectDocumentReview(another.id);
      assert.equal(rejected.status, 'rejected');
      await assert.rejects(() => docs.confirmDocumentReview({ id: another.id, offerRevisionId: 'rev-a1' }), code('invalid_transition'));
      const [failedRow] = await query(`SELECT id FROM earned_equity_document_reviews WHERE status = 'failed' LIMIT 1`);
      await assert.rejects(() => docs.confirmDocumentReview({ id: failedRow.id, offerRevisionId: 'rev-a1' }), code('invalid_transition'));
      await assert.rejects(() => docs.rejectDocumentReview(failedRow.id), code('invalid_transition'));
      await assert.rejects(() => docs.rejectDocumentReview('missing'), code('not_found'));
    });
    await test('the database itself refuses rewrites of proposal content, illegal transitions and deletes', async () => {
      const [row] = await query(`SELECT id FROM earned_equity_document_reviews WHERE status = 'confirmed' LIMIT 1`);
      await assert.rejects(() => query(`UPDATE earned_equity_document_reviews SET proposal = '{}'::jsonb WHERE id = $1`, [row.id]), /append-only/);
      await assert.rejects(() => query(`UPDATE earned_equity_document_reviews SET doc_class = 'other' WHERE id = $1`, [row.id]), /append-only/);
      await assert.rejects(() => query(`UPDATE earned_equity_document_reviews SET status = 'rejected', confirmed_offer_revision_id = NULL WHERE id = $1`, [row.id]), /status cannot change/);
      await assert.rejects(() => query(`DELETE FROM earned_equity_document_reviews WHERE id = $1`, [row.id]), /purge/);
      const { proposal } = await docs.analyzeOfferDocument({ documentId: textDocId });
      const fresh = await docs.recordDocumentReview({ opportunityId: 'opp-a', documentId: textDocId, proposal });
      await assert.rejects(() => query(`UPDATE earned_equity_document_reviews SET status = 'confirmed' WHERE id = $1`, [fresh.id]), /check|violat/i);
      await assert.rejects(() => query(`UPDATE earned_equity_document_reviews SET status = 'proposed' WHERE id = $1`, [row.id]), /check|status cannot change|violat/i);
      await assert.rejects(() => query(`INSERT INTO earned_equity_document_reviews (id, opportunity_id, document_id, document_sha256, doc_class, extraction_version, status, proposal)
        VALUES ('x', 'opp-a', $1, $2, 'grant_notice', 'v', 'confirmed', '{}'::jsonb)`, [textDocId, sha('x')]), /check|violat/i);
    });

    console.log('Purge');
    await test('purging an opportunity deletes its reviews and attached documents, and nothing else', async () => {
      const before = await query('SELECT COUNT(*)::int AS n FROM earned_equity_document_reviews WHERE opportunity_id = $1', ['opp-a']);
      assert.ok(before[0].n >= 5);
      // opp-b gets its own document and review that must survive.
      const [bDoc] = await listDocuments('earned_equity_opportunity', 'opp-b');
      const { proposal: bProposal } = await docs.analyzeOfferDocument({ documentId: bDoc.id });
      await docs.recordDocumentReview({ opportunityId: 'opp-b', documentId: bDoc.id, proposal: bProposal });

      // The opportunity purge removes documents and reviews before the revisions they pin.
      const purged = await opportunities.purgeEarnedEquityOpportunity('opp-a');
      assert.equal(purged.opportunities, 1);
      assert.equal(purged.revisions, 1);
      assert.equal((await query('SELECT COUNT(*)::int AS n FROM earned_equity_document_reviews WHERE opportunity_id = $1', ['opp-a']))[0].n, 0);
      assert.equal((await listDocuments('earned_equity_opportunity', 'opp-a')).length, 0);
      assert.equal((await query('SELECT COUNT(*)::int AS n FROM documents WHERE entity_id = $1', ['opp-a']))[0].n, 0);
      assert.equal((await listDocuments('earned_equity_opportunity', 'opp-b')).length, 1);
      assert.equal((await docs.listDocumentReviews('opp-b')).length, 1);

      const flag = await query(`SELECT current_setting('radar.earned_equity_maintenance', true) AS v`);
      assert.notEqual(flag[0].v, 'on', 'maintenance flag is restored after the purge');
      await assert.rejects(() => query(`DELETE FROM earned_equity_document_reviews`), /purge/);

    });
    await test('the document purge nests inside an outer purge transaction without clearing its flag', async () => {
      await opportunities.createOpportunity(opp('opp-c', 'g1'));
      const doc = await docs.attachOfferDocument({ opportunityId: 'opp-c', filename: 'c.txt', mime: 'text/plain', content: fixture('offer-letter.txt') });
      const { proposal } = await docs.analyzeOfferDocument({ documentId: doc.id });
      await docs.recordDocumentReview({ opportunityId: 'opp-c', documentId: doc.id, proposal });
      const { withAtomicWrite } = await import('../db/index.js');
      await withAtomicWrite(async () => {
        await query(`SELECT set_config('radar.earned_equity_maintenance', 'on', true)`);
        await docs.purgeEarnedEquityDocumentsForOpportunity('opp-c');
        const [flag] = await query(`SELECT current_setting('radar.earned_equity_maintenance', true) AS v`);
        assert.equal(flag.v, 'on');
        await query(`SELECT set_config('radar.earned_equity_maintenance', 'off', true)`);
      });
      assert.equal((await docs.listDocumentReviews('opp-c')).length, 0);
    });
  });
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
