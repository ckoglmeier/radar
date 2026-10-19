import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { extractPdfEvidence, recognizePdfPage } from './pdf-text.js';
import { createIsolatedPdfParser } from './pdf-parser-client.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
  const until = Date.now() + 3000;
  while (!predicate() && Date.now() < until) await pause(5);
  assert(predicate(), 'synthetic parser reached the requested stage');
}
function setup(root, stage, busy = false) {
  const marker = join(root, `started-${stage}`);
  let child, processOptions;
  const createParser = () => createIsolatedPdfParser(Buffer.from(JSON.stringify({ marker, stage, busy })), {
    workerUrl: new URL('./fixtures/pdf-parser-stall.js', import.meta.url),
    forkImpl(...args) { processOptions = args[2]; child = fork(...args); return child; },
  });
  return { marker, createParser, child: () => child, options: () => processOptions };
}

for (const stage of ['getText', 'getInfo', 'getScreenshot']) {
  for (const busy of [false, true]) {
    test(`abort kills ${busy ? 'CPU-busy' : 'held'} ${stage} before returning`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'radar-pdf-cancel-'));
      const fixture = setup(root, stage, busy), controller = new AbortController();
      try {
        const result = extractPdfEvidence(Buffer.from('synthetic'), { createParser: fixture.createParser, signal: controller.signal,
          ocr: async () => { assert.fail('cancelled parser cannot reach OCR'); } });
        const rejected = assert.rejects(result, { code: 'PDF_EXTRACTION_CANCELLED' });
        await waitFor(() => existsSync(fixture.marker));
        const pid = Number(readFileSync(fixture.marker, 'utf8'));
        const started = performance.now(); controller.abort(); await rejected;
        assert(performance.now() - started < 1500, 'abort is bounded, not waiting for parse/render cooperation');
        assert.equal(fixture.child().signalCode, 'SIGKILL');
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'child is gone when extraction settles');
        assert.deepEqual(fixture.options().execArgv, []);
        assert.deepEqual(Object.keys(fixture.options().env).filter(k => /KEY|TOKEN|RADAR|NODE_OPTIONS/.test(k)), []);
      } finally { fixture.child()?.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); }
    });
  }
  test(`deadline kills held ${stage}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'radar-pdf-deadline-'));
    const fixture = setup(root, stage);
    try {
      const started = performance.now();
      await assert.rejects(extractPdfEvidence(Buffer.from('synthetic'), { createParser: fixture.createParser, budgetMs: 700 }), { code: 'PDF_OCR_LIMIT' });
      assert(existsSync(fixture.marker), 'deadline exercised an in-flight operation');
      assert(performance.now() - started < 2000);
      assert.equal(fixture.child().signalCode, 'SIGKILL');
    } finally { fixture.child()?.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); }
  });
}

test('pre-abort and zero/invalid budget never start a parser', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const createParser = () => { calls++; throw Error('must not start'); };
  await assert.rejects(extractPdfEvidence(Buffer.from('x'), { signal: controller.signal, createParser }), { code: 'PDF_EXTRACTION_CANCELLED' });
  for (const budgetMs of [0, -1, NaN, Infinity]) {
    await assert.rejects(extractPdfEvidence(Buffer.from('x'), { budgetMs, createParser }), { code: 'PDF_OCR_LIMIT' });
  }
  assert.equal(calls, 0);
});

test('transport failure also kills the actual busy parser before returning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'radar-pdf-transport-'));
  const fixture = setup(root, 'getText', true);
  try {
    const rejected = assert.rejects(extractPdfEvidence(Buffer.from('synthetic'), { createParser: fixture.createParser }), { code: 'PDF_EXTRACTION_FAILED' });
    await waitFor(() => existsSync(fixture.marker));
    fixture.child().emit('error', new Error('Synthetic transport failure'));
    await rejected;
    assert.equal(fixture.child().signalCode, 'SIGKILL');
  } finally { fixture.child()?.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); }
});

test('lost claim stops before parsing, late parser completion cannot return evidence', async () => {
  let spawned = false;
  await assert.rejects(extractPdfEvidence(Buffer.from('x'), {
    onProgress: () => { throw Error('Synthetic lost claim'); },
    createParser: () => { spawned = true; },
  }), { code: 'PDF_EXTRACTION_FAILED' });
  assert.equal(spawned, false);
  let release, destroyed = false;
  const pending = new Promise(resolve => { release = resolve; });
  await assert.rejects(extractPdfEvidence(Buffer.from('x'), { budgetMs: 20, createParser: () => ({
    getText: () => pending, destroy: async () => { destroyed = true; release({ total: 1, pages: [{ num: 1, text: 'Late synthetic text' }] }); },
  }) }), { code: 'PDF_OCR_LIMIT' });
  assert(destroyed);
});

test('active parsing renews claim; a lost claim kills work and stops renewal', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const root = mkdtempSync(join(tmpdir(), 'radar-pdf-claim-'));
  const fixture = setup(root, 'getText', true);
  let renewals = 0;
  try {
    const result = extractPdfEvidence(Buffer.from('synthetic'), { createParser: fixture.createParser,
      onProgress: event => {
        assert.equal(event.phase, 'parsing');
        if (++renewals === 2) throw Error('Synthetic claim revoked during parse');
      },
    });
    const rejected = assert.rejects(result, { code: 'PDF_EXTRACTION_CANCELLED' });
    await waitFor(() => existsSync(fixture.marker));
    assert.equal(renewals, 1);
    t.mock.timers.tick(30000); await rejected;
    assert.equal(fixture.child().signalCode, 'SIGKILL');
    t.mock.timers.tick(90000); await pause(10);
    assert.equal(renewals, 2, 'no claim polling after extraction finishes');
  } finally {
    t.mock.timers.reset(); fixture.child()?.kill('SIGKILL'); rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ['abort', 'deadline']) {
  test(`native OCR ${mode} waits for helper death and removes its private image`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'radar-ocr-cleanup-'));
    const helper = join(root, 'ocr-hold.sh'), controller = new AbortController();
    copyFileSync(new URL('./fixtures/ocr-hold.sh', import.meta.url), helper); chmodSync(helper, 0o700);
    try {
      const operation = recognizePdfPage(Buffer.from('synthetic pixels'), { env: { RADAR_IMAGE_OCR_PATH: helper },
        timeoutMs: mode === 'deadline' ? 700 : 5000, signal: controller.signal });
      const rejected = assert.rejects(operation, { code: 'PDF_OCR_FAILED' });
      await waitFor(() => existsSync(`${helper}.started`));
      const [pid, image] = readFileSync(`${helper}.started`, 'utf8').trim().split('\n');
      if (mode === 'abort') controller.abort();
      await rejected;
      assert.throws(() => process.kill(Number(pid), 0), { code: 'ESRCH' });
      assert.equal(existsSync(dirname(image)), false, 'private OCR image removed before returning');
    } finally { controller.abort(); rmSync(root, { recursive: true, force: true }); }
  });
}
