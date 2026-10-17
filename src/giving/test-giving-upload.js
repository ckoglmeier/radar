// Upload extraction: Daffy templates (layouts copied from real Daffy mail, fictional values),
// CSV mapping, OCR text and the upload item builder.
// Optional private check: RADAR_GIVING_REAL_DAFFY_DIR=<dir with receipt.txt, sent.txt,
// recommendation.txt, recommendation.html> runs structural assertions over real Daffy bodies.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isoFromUsDate, parseDaffyEmail } from './parse-daffy.js';
import { mapColumns, parseGivingCsv } from './parse-csv.js';
import { extractUploadCandidates, uploadKind } from './upload-extract.js';
import { buildUploadItems } from './import.js';

const FOOTER = `---

Daffy Charitable Fund is recognized as a tax-exempt public charity as described in Sections 501(c)(3), 509(a)(1), and 170(b)(1)(A)(vi) of the Internal Revenue Code.
EIN: 86-3177440

© 2026 Daffy Charitable Fund™. All rights reserved.`;
const DAFFY_EIN = '86-3177440';

const receipt = `Dear Test Donor,

Thank you for your generous donation to Hillside Library Friends through the Daffy app.

Your donation recommendation to Hillside Library Friends has been approved.

Donation Details

Your donation recommendation to Hillside Library Friends has been approved.

Donation date: 03/04/26 at 9:15:02 am PST

Fund: Test Family Fund

Non-profit: Hillside Library Friends

Tax-ID: 11-2233445

Donation amount: $2,500.00

Donation use: Summer reading program

:D,
The Daffy Team

${FOOTER}`;

const sent = `Your donation is on its way

Good news—we've sent your donation to Hillside Library Friends.

- Charity: Hillside Library Friends
- Amount: $2,500.00
Daffy has partnered with Chariot (<link>) to offer charities electronic donation payment.

${FOOTER}`;

for (const [literal, cents] of [['$1250.00', 125000], ['$1,250.00', 125000], ['$1234567.89', 123456789]]) {
  for (const template of [receipt, sent]) {
    const parsed = parseDaffyEmail({ text: template.replace('$2,500.00', literal) });
    assert.equal(parsed.proposed.amount.cents, cents, 'complete monetary token');
    assert.equal(parsed.proposed.amount.literal, literal);
  }
}
for (const literal of ['$1,25.00', '$1250.123']) {
  const parsed = parseDaffyEmail({ text: receipt.replace('$2,500.00', literal) });
  assert.equal(parsed.proposed.amount.cents, null, 'malformed amount must not become a truncated value');
}

const recommendation = `Thank you for making your donation recommendation to ”Hillside Library Friends”!

TAX-ID
11-2233445

Donation use
Summer reading program

We are currently reviewing your donation recommendation.

${FOOTER}`;
const recommendationHtml = `<html><head><style>p{margin:0}</style></head><body><div>Supported non-profit</div></td></tr><tr><td><div>Hillside Library Friends</div></td></tr><tr><td><div>Tax-ID</div></td></tr><tr><td><div>11-2233445</div></td></tr><tr><td><div>Amount</div></td></tr><tr><td><div style="font-weight:700">$2,500</div></td></tr><tr><td><div>Donation use</div></td></tr><tr><td><div><p>Summer reading program</p></div></body></html>`;

function literalsInExcerpt(result) {
  const p = result.proposed;
  for (const literal of [p.amount.literal, p.date.literal, p.organization.ein_literal]) {
    if (literal) assert.ok(result.excerpt.includes(literal), `literal ${literal} is in the excerpt`);
  }
  assert.ok(!result.excerpt.includes(DAFFY_EIN), 'Daffy footer never enters the excerpt');
  assert.notEqual(p.organization.ein, DAFFY_EIN);
}

// ── Daffy templates ──
assert.equal(isoFromUsDate('03/04/26'), '2026-03-04');
assert.equal(isoFromUsDate('02/30/26'), null);
const r1 = parseDaffyEmail({ text: receipt, receivedAt: '2026-03-04T17:20:00Z' });
assert.equal(r1.stage, 'receipt');
assert.deepEqual(r1.proposed.organization, { name: 'Hillside Library Friends', ein: '11-2233445', ein_literal: '11-2233445' });
assert.deepEqual(r1.proposed.amount, { cents: 250000, currency: 'USD', literal: '$2,500.00' });
assert.deepEqual(r1.proposed.date, { value: '2026-03-04', basis: 'stated_in_excerpt', literal: '03/04/26' });
assert.equal(r1.proposed.purpose, 'Summer reading program');
literalsInExcerpt(r1);
const r2 = parseDaffyEmail({ text: sent, receivedAt: '2026-03-09T12:00:00Z' });
assert.equal(r2.stage, 'sent');
assert.equal(r2.proposed.amount.cents, 250000);
assert.deepEqual(r2.proposed.date, { value: '2026-03-09', basis: 'email_received', literal: null });
literalsInExcerpt(r2);
const r3 = parseDaffyEmail({ text: recommendation, receivedAt: '2026-03-02T12:00:00Z' });
assert.equal(r3.stage, 'recommendation');
assert.equal(r3.proposed.amount.cents, null, 'plain text alone has no amount');
assert.match(r3.proposed.notes, /Not proof/);
const r3html = parseDaffyEmail({ text: recommendation, html: recommendationHtml, receivedAt: '2026-03-02T12:00:00Z' });
assert.equal(r3html.proposed.amount.cents, 250000, 'the HTML part supplies the amount');
literalsInExcerpt(r3html);
assert.equal(parseDaffyEmail({ text: `Your Daffy fund balance is ready.\n\n${FOOTER}` }), null, 'unknown Daffy mail is not guessed');

// ── Upload extraction ──
assert.equal(uploadKind('Receipt.EML'), 'eml');
assert.equal(uploadKind('x.jpeg'), 'image');
assert.equal(uploadKind('x.docx'), null);
const eml = Buffer.from([
  'From: Daffy <support@daffy.org>',
  'Subject: Thank you for making a donation recommendation',
  'Date: Mon, 02 Mar 2026 12:00:00 +0000',
  'Message-ID: <fixture-1@daffy.org>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  recommendation,
  '--b1',
  'Content-Type: text/html; charset=utf-8',
  '',
  recommendationHtml,
  '--b1--',
  '',
].join('\r\n'));
const fromEml = await extractUploadCandidates({ fileName: 'rec.eml', bytes: eml });
assert.equal(fromEml.candidates.length, 1);
assert.equal(fromEml.candidates[0].proposed.amount.cents, 250000);
assert.equal(fromEml.candidates[0].source.from_domain, 'daffy.org');
// On-device OCR of a screenshot yields the same lines.
const ocrText = 'Your donation recommendation to Hillside Library Friends has been\napproved.\nDonation date: 03/04/26 at 9:15:02 am PST\nNon-profit: Hillside Library Friends\nTax-ID: 11-2233445\nDonation amount: $2,500.00';
const fromImage = await extractUploadCandidates({ fileName: 'daffy.png', bytes: Buffer.from([0]), ocrText });
assert.equal(fromImage.candidates[0].proposed.date.value, '2026-03-04');
const notDaffy = await extractUploadCandidates({ fileName: 'letter.txt', bytes: Buffer.from('Thank you for your gift of $100 to the Food Shelf.') });
assert.equal(notDaffy.recognized, false);
assert.match(notDaffy.text, /Food Shelf/);

// ── CSV ──
assert.deepEqual(mapColumns(['Date', 'Charity Name', 'Tax ID', 'Amount', 'Status']), { date: 0, organization: 1, ein: 2, amount: 3, status: 4 });
const csv = 'Date,Charity,EIN,Amount,Status,Donation use\n2026-03-04,Hillside Library Friends,11-2233445,"$2,500.00",Completed,Summer reading\n03/20/2026,Lakeside Youth Camp,98-7654321,750,Pending,\n';
const parsedCsv = parseGivingCsv(csv, { vehicle: 'daffy' });
assert.equal(parsedCsv.rows.length, 2);
assert.equal(parsedCsv.rows[0].proposed.kind, 'daf_grant');
assert.equal(parsedCsv.rows[0].proposed.amount.cents, 250000);
assert.equal(parsedCsv.rows[1].proposed.date.value, '2026-03-20');
assert.deepEqual(parsedCsv.rows[1].extraIssues, [{ field: 'status', code: 'STATUS_NOT_PAID' }]);
assert.deepEqual(parseGivingCsv('Date,Memo\n2026-01-01,x\n').missing, ['organization', 'amount']);

// ── Upload items (same literal rule as the scan import) ──
const sha = 'a'.repeat(64);
const items = buildUploadItems({ fileName: 'gifts.csv', fileSha256: sha, candidates: parsedCsv.rows.map(row => ({ ...row, source: { subject: 'gifts.csv' } })) });
assert.equal(items[0].external_key, `upload:${sha}:0`);
assert.equal(items[0].proposed.organization.ein, '112233445');
assert.ok(items[1].issues.some(issue => issue.code === 'STATUS_NOT_PAID'));
const tampered = structuredClone(parsedCsv.rows[0]);
tampered.proposed.amount.literal = '$9,999.00';
assert.equal(buildUploadItems({ fileName: 'x.csv', fileSha256: sha, candidates: [tampered] })[0].proposed.amount.cents, null, 'a literal missing from the file is cleared');
assert.throws(() => buildUploadItems({ fileName: 'x', fileSha256: 'nope', candidates: [] }), /sha256/);
assert.throws(() => buildUploadItems({ fileName: 'x', fileSha256: sha, candidates: [{ excerpt: 'x', proposed: { kind: 'bogus' } }] }), /malformed/);

// ── Optional: real Daffy bodies kept outside git ──
const realDir = process.env.RADAR_GIVING_REAL_DAFFY_DIR;
if (realDir && existsSync(join(realDir, 'receipt.txt'))) {
  const read = name => readFileSync(join(realDir, name), 'utf8');
  const meta = JSON.parse(read('meta.json'));
  const real = {
    receipt: parseDaffyEmail({ text: read('receipt.txt'), receivedAt: meta['receipt.txt'].received_at }),
    sent: parseDaffyEmail({ text: read('sent.txt'), receivedAt: meta['sent.txt'].received_at }),
    recommendation: parseDaffyEmail({ text: read('recommendation.txt'), html: existsSync(join(realDir, 'recommendation.html')) ? read('recommendation.html') : null, receivedAt: meta['recommendation.txt'].received_at }),
  };
  for (const [stage, result] of Object.entries(real)) {
    assert.equal(result.stage, stage);
    assert.ok(result.proposed.organization.name, `${stage}: organization found`);
    literalsInExcerpt(result);
  }
  assert.equal(real.receipt.proposed.date.basis, 'stated_in_excerpt');
  assert.ok(real.receipt.proposed.amount.cents && real.receipt.proposed.organization.ein);
  assert.ok(real.sent.proposed.amount.cents);
  console.log('giving upload: real Daffy receipt, sent and recommendation bodies parsed');
}

console.log('giving upload: Daffy templates, email files, OCR text, CSV and upload items ok');
