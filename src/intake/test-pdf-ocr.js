import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticImagePdf } from './fixtures/pdf-images.js';
import { extractPdfText, extractPdfEvidence, cleanPdfText, hasReadablePdfText } from './extract-text.js';
import { chunkRoomDocuments } from '../council/room-evidence.js';
import { PDF_OCR_MAX_PAGES } from './pdf-text.js';

function fixture(texts) {
  const calls = { destroyed: 0, rendered: [], info: [] };
  const parser = {
    async getText(options) { assert.equal(options.pageJoiner, ''); return { total: texts.length, pages: texts.map((text, i) => ({ text, num: i + 1 })) }; },
    async getInfo(options) { calls.info.push(options.partial[0]); return { pages: options.partial.map(pageNumber => ({ pageNumber, width: 960, height: 540 })) }; },
    async getScreenshot(options) {
      assert(options.scale * 960 <= 2000.001 && options.scale * 540 <= 2800.001);
      assert.equal(options.imageDataUrl, false);
      calls.rendered.push(options.partial[0]);
      return { pages: options.partial.map(pageNumber => ({ pageNumber, data: Buffer.from(`synthetic page ${pageNumber}`) })) };
    },
    async destroy() { calls.destroyed++; },
  };
  return { calls, parser, createParser: () => parser };
}
const input = Buffer.from('%PDF synthetic dependency-injected fixture');
test('page markers and whitespace are never readable evidence', () => {
  const markers = Array.from({ length: 12 }, (_, i) => `-- ${i + 1} of 12 --`).join('\n\n\n\n');
  assert.equal(markers.length, 203);
  assert.throws(() => chunkRoomDocuments([{ filename: 'scan.pdf', text: markers }]), /no readable text/);
  assert.equal(cleanPdfText(markers), ''); assert.equal(hasReadablePdfText(markers), false);
  assert.equal(hasReadablePdfText(' \n'), false); assert.equal(hasReadablePdfText('Revenue $42,000'), true);
});
test('text PDF uses per-page text and never calls OCR', async () => {
  const f = fixture(['Known team', 'Revenue $42,000']);
  const value = await extractPdfEvidence(input, { createParser: f.createParser, ocr: () => { throw Error('must not run'); } });
  assert.equal(value.method, 'pdf_text'); assert.equal(value.ocrPages, 0);
  assert.match(value.text, /Revenue \$42,000/); assert.deepEqual(f.calls.rendered, []); assert.equal(f.calls.destroyed, 1);
});
test('image-only and mixed PDFs recover every missing page with labelled local OCR', async () => {
  for (const texts of [['', ''], ['Known founder', '']]) {
    const f = fixture(texts); let calls = 0;
    const result = await extractPdfEvidence(input, { createParser: f.createParser, ocr: async (bytes, { timeoutMs }) => {
      assert(timeoutMs > 0 && timeoutMs <= 30000); assert.match(bytes.toString(), /synthetic page/); calls++;
      return 'Synthetic revenue $42,000';
    } });
    assert.equal(result.pages.length, 2); assert.equal(calls, texts.filter(t => !t).length);
    assert.equal(result.ocrPages, calls); assert.match(result.text, /recognized by local OCR/);
    assert.match(result.text, /PDF page 2 \(OCR\)/); assert.match(result.text, /\$42,000/);
    assert.equal(f.calls.destroyed, 1);
  }
});
test('failed, empty, marker-only or unavailable OCR cannot yield partial success', async () => {
  for (const ocr of [async () => '', async () => '-- 2 of 2 --', async () => { throw Error('private failure text'); }]) {
    const f = fixture(['Readable first page', '']);
    await assert.rejects(extractPdfEvidence(input, { createParser: f.createParser, ocr }), /PDF|page|OCR/);
    assert.equal(f.calls.destroyed, 1);
    assert.equal(await extractPdfText(input, { createParser: f.createParser, ocr }), null);
  }
});
test('page and time limits stop OCR; malformed/incomplete data is not accepted', async () => {
  const oversized = fixture(Array(PDF_OCR_MAX_PAGES + 1).fill(''));
  await assert.rejects(extractPdfEvidence(input, { createParser: oversized.createParser }), /150-page/);
  assert.deepEqual(oversized.calls.rendered, []); assert.equal(oversized.calls.destroyed, 1);
  const timed = fixture(['']); let n = 0;
  await assert.rejects(extractPdfEvidence(input, { createParser: timed.createParser, budgetMs: 1, now: () => n++ * 100 }), /time limit/);
  assert.deepEqual(timed.calls.rendered, []); assert.equal(timed.calls.destroyed, 0, 'expired budget must not create a parser');
  const incomplete = fixture(['']); incomplete.parser.getText = async () => ({ total: 2, pages: [{ num: 1, text: 'Partial' }] });
  await assert.rejects(extractPdfEvidence(input, { createParser: incomplete.createParser }), /incomplete/);
  assert.equal(incomplete.calls.destroyed, 1);
  assert.equal(await extractPdfText(Buffer.from('%PDF broken')), null);
});

test('invalid dimensions fail before rendering and page progress supports cancellation', async () => {
  const bad = fixture(['']); bad.parser.getInfo = async () => ({ pages: [{ pageNumber: 1, width: Infinity, height: 540 }] });
  await assert.rejects(extractPdfEvidence(input, { createParser: bad.createParser }), /dimensions/);
  assert.deepEqual(bad.calls.rendered, []); assert.equal(bad.calls.destroyed, 1);
  const f = fixture(['', '']); const progress = [], controller = new AbortController();
  await assert.rejects(extractPdfEvidence(input, {
    createParser: f.createParser, signal: controller.signal,
    onProgress: async event => { progress.push(event.page); if (event.page === 2) controller.abort(); },
    ocr: async () => 'First synthetic page',
  }), /stopped/);
  assert.deepEqual(progress, [0, 1, 2]); assert.deepEqual(f.calls.rendered, [1]); assert.equal(f.calls.destroyed, 1);
});

// An actual two-page raster PDF containing only synthetic financial text.

test('real parser plus native Vision reads all synthetic image pages and numeric evidence', { skip: !process.env.RADAR_IMAGE_OCR_PATH }, async () => {
  const bytes = syntheticImagePdf();
  const { PDFParse } = await import('pdf-parse'); const original = new PDFParse({ data: bytes });
  try { const r = await original.getText(); assert.deepEqual(r.pages.map(p => p.text.trim()), ['', '']); } finally { await original.destroy(); }
  const result = await extractPdfEvidence(bytes);
  assert.equal(result.ocrPages, 2); assert.equal(result.method, 'local_ocr');
  for (const page of result.pages) { assert.match(page.text, /Synthetic PDF OCR fixture/i); assert.match(page.text, /42,000/); assert.match(page.text, /20 percent/); }
});
