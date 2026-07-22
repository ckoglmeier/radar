#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { extractHtmlText, extractPdfText } from './extract-text.js';
import { extractDealFields, isAngelListDealText } from './extract-fields.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}: ${error.message}`);
    failed++;
  }
}

function buildSyntheticAngelListPdf() {
  const lines = [
    'TERMS',
    'Sub-Adviser Example Syndicate LLC',
    'Round Seed+',
    'Post-money cap $48M USD',
    'Allocation $200k USD',
    'Gross carry 20.0%',
    'Min. investment $2,000 USD',
    'Markets Robotics',
    'Northstar Robotics',
    'Confidential: Disclosing deal information will result in removal from AngelList',
    'Northstar Robotics | AngelList',
    'Note from Example Syndicate',
  ];
  const escapePdf = value => value.replace(/([\\()])/g, '\\$1');
  const stream = [
    'BT',
    '/F1 11 Tf',
    '72 740 Td',
    ...lines.flatMap((line, index) => [
      `(${escapePdf(line)}) Tj`,
      ...(index < lines.length - 1 ? ['0 -16 Td'] : []),
    ]),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

await test('extractHtmlText strips executable content and decodes entities', () => {
  const html = '<html><head><style>.x{}</style><script>bad()</script></head><body><h1>Alpha &amp; Beta</h1><p>Carry&nbsp;20&#37;</p></body></html>';
  const text = extractHtmlText(html);
  assert.match(text, /Alpha & Beta/);
  assert.match(text, /Carry 20%/);
  assert.doesNotMatch(text, /bad\(\)|\.x/);
});

await test('extractDealFields parses synthetic AngelList HTML page terms', () => {
  const html = `<!doctype html><html><head><title>Northstar Robotics | AngelList</title></head><body>
    <h2>Co-investors</h2><div>Forge Ventures</div><div>Lead • $10,000,000</div><div>Cedar Fund</div><div>Undisclosed</div>
    <h2>All documents</h2><h2>Note from Example Syndicate</h2>
    <dl><dt>Round</dt><dd>Series A</dd><dt>Post-money valuation</dt><dd>$48M USD</dd>
    <dt>Allocation</dt><dd>$250k USD</dd><dt>Gross carry</dt><dd>20.0%</dd>
    <dt>Min. investment</dt><dd>$5,000 USD</dd><dt>Markets</dt><dd>Robotics &amp; Automation</dd></dl>
    <p>Confidential: Disclosing deal information will result in removal from AngelList</p>
  </body></html>`;
  const text = extractHtmlText(html);
  assert.equal(isAngelListDealText(text), true);
  assert.deepEqual(extractDealFields(text), {
    company_name: 'Northstar Robotics',
    lead: 'Example Syndicate',
    co_investors: 'Forge Ventures, Cedar Fund',
    market: 'Robotics & Automation',
    round: 'Series A',
    allocation_usd: 250000,
    min_investment_usd: 5000,
    carry_pct: 20,
    valuation_text: '$48M USD',
    valuation_usd: 48000000,
    source: 'intake',
    status: 'invite',
    deal_slug: 'northstar-robotics-series-a-angellist',
  });
});

await test('non-AngelList HTML does not satisfy the deal marker', () => {
  const text = extractHtmlText('<html><title>Ordinary Company</title><body><p>Round ideas for the market.</p></body></html>');
  assert.equal(isAngelListDealText(text), false);
});

await test('PDF text extraction feeds the same field parser', async () => {
  const text = await extractPdfText(buildSyntheticAngelListPdf());
  assert.ok(text);
  assert.equal(isAngelListDealText(text), true);
  const fields = extractDealFields(text);
  assert.equal(fields.company_name, 'Northstar Robotics');
  assert.equal(fields.lead, 'Example Syndicate');
  assert.equal(fields.round, 'Seed+');
  assert.equal(fields.allocation_usd, 200000);
  assert.equal(fields.min_investment_usd, 2000);
  assert.equal(fields.carry_pct, 20);
  assert.equal(fields.valuation_usd, 48000000);
  assert.equal(fields.market, 'Robotics');
});

await test('invalid PDF extraction fails gracefully', async () => {
  assert.equal(await extractPdfText(Buffer.from('%PDF-1.4 not actually a PDF')), null);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
