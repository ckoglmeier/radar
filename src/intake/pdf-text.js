// PDF text quality and on-device recovery. No provider/network inference.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createIsolatedPdfParser } from './pdf-parser-client.js';
const execute = promisify(execFile);
export const PDF_OCR_MAX_PAGES = 150;
export const PDF_OCR_BUDGET_MS = 10 * 60 * 1000;

// pdf-parse's aggregate page joiners are not source text. Never count them as evidence.
export function cleanPdfText(value) {
  return String(value || '').replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gm, '').trim();
}
export function hasReadablePdfText(value) {
  return /[\p{L}\p{N}]/u.test(cleanPdfText(value));
}
function problem(code, message) { return Object.assign(new Error(message), { code }); }

export async function recognizePdfPage(bytes, { timeoutMs = 30000, env = process.env, signal } = {}) {
  const helper = env.RADAR_IMAGE_OCR_PATH || (env.RADAR_PDF_NORMALIZER_PATH
    ? join(dirname(env.RADAR_PDF_NORMALIZER_PATH), 'radar-image-ocr') : null);
  if (!helper) throw problem('PDF_OCR_UNAVAILABLE', 'This PDF needs local OCR. Open it in an updated Radar Desktop or attach a text-readable copy.');
  const directory = await mkdtemp(join(tmpdir(), 'radar-pdf-ocr-'));
  try {
    const path = join(directory, 'page.png');
    await writeFile(path, bytes, { mode: 0o600 });
    const operation = execute(helper, [path], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, signal, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } });
    const closed = new Promise(resolve => operation.child.once('close', resolve));
    let stdout;
    try { ({ stdout } = await operation); }
    finally { if (signal?.aborted) operation.child.kill('SIGKILL'); await closed; }
    const value = JSON.parse(stdout);
    if (!Array.isArray(value.lines) || value.lines.some(line => typeof line.text !== 'string')) throw Error();
    return value.lines.map(line => line.text).join('\n');
  } catch {
    throw problem('PDF_OCR_FAILED', 'Local PDF OCR failed. Retry extraction or attach a text-readable copy; analysis has not started.');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function extractPdfEvidence(content, { createParser, ocr = recognizePdfPage, now = () => performance.now(), budgetMs = PDF_OCR_BUDGET_MS, onProgress, signal } = {}) {
  let parser, ocrWork;
  const budget = Number.isFinite(budgetMs) ? Math.max(0, Math.min(budgetMs, PDF_OCR_BUDGET_MS)) : 0;
  const deadline = now() + budget;
  const controller = new AbortController();
  let stoppedError, rejectStopped, active = true, reporting = null;
  let progress = { page: 0, total: null, phase: 'parsing' };
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  stopped.catch(() => {});
  const stop = error => {
    if (stoppedError) return;
    stoppedError = error; controller.abort(); rejectStopped(error);
  };
  const cancelled = () => stop(problem('PDF_EXTRACTION_CANCELLED', 'Local PDF extraction stopped; analysis has not started.'));
  const expired = () => stop(problem('PDF_OCR_LIMIT', 'Local PDF extraction reached its time limit; analysis has not started.'));
  const guard = () => {
    if (signal?.aborted) cancelled();
    if (!stoppedError && now() >= deadline) expired();
    if (stoppedError) throw stoppedError;
  };
  signal?.addEventListener('abort', cancelled, { once: true });
  const timer = setTimeout(expired, budget);
  // Renew only an active extraction's claim, including a slow initial parse.
  const report = () => {
    if (!active || !onProgress) return Promise.resolve();
    if (!reporting) reporting = Promise.resolve().then(() => {
      guard(); return onProgress(progress);
    }).finally(() => { reporting = null; });
    return reporting;
  };
  const heartbeat = onProgress ? setInterval(() => {
    void report().catch(() => cancelled());
  }, 30000) : null;
  const step = async operation => {
    guard();
    const result = await Promise.race([Promise.resolve().then(operation), stopped]);
    guard(); return result;
  };
  try {
    guard();
    await step(report);
    parser = (createParser || createIsolatedPdfParser)(Buffer.isBuffer(content) ? content : Buffer.from(content));
    const result = await step(() => parser.getText({ pageJoiner: '' }));
    if (!result.pages?.length || result.pages.length !== result.total ||
        result.pages.some((page, index) => page.num !== index + 1)) throw problem('PDF_EXTRACTION_FAILED', 'The PDF page extraction is incomplete.');
    const missing = result.pages.filter(page => !hasReadablePdfText(page.text));
    if (missing.length && result.total > PDF_OCR_MAX_PAGES) throw problem('PDF_OCR_LIMIT', 'This PDF exceeds the 150-page local OCR limit. Split it into smaller documents; analysis has not started.');
    const pages = [];
    for (const page of result.pages) {
      progress = { page: page.num, total: result.total, phase: 'page' };
      await step(report);
      let text = cleanPdfText(page.text), method = 'pdf_text';
      if (!hasReadablePdfText(text)) {
        if (now() >= deadline) throw problem('PDF_OCR_LIMIT', 'Local PDF OCR reached its time limit; analysis has not started.');
        const info = await step(() => parser.getInfo({ parsePageInfo: true, partial: [page.num] }));
        const size = info.pages?.find(item => item.pageNumber === page.num);
        if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) throw problem('PDF_EXTRACTION_FAILED', 'The PDF page dimensions are invalid.');
        // Limit either edge before allocating a canvas. The native recognizer caps at 4800px.
        const scale = Math.min(2000 / size.width, 2800 / size.height);
        const images = await step(() => parser.getScreenshot({ partial: [page.num], scale, imageBuffer: true, imageDataUrl: false }));
        const image = images.pages?.find(item => item.pageNumber === page.num);
        if (!image?.data?.length) throw problem('PDF_EXTRACTION_FAILED', 'The PDF page could not be rendered for local OCR.');
        const remaining = deadline - now();
        if (remaining <= 0) throw problem('PDF_OCR_LIMIT', 'Local PDF OCR reached its time limit; analysis has not started.');
        text = cleanPdfText(await step(() => {
          ocrWork = Promise.resolve(ocr(Buffer.from(image.data), { timeoutMs: Math.min(30000, remaining), signal: controller.signal }));
          return ocrWork;
        }));
        if (now() > deadline) throw problem('PDF_OCR_LIMIT', 'Local PDF OCR reached its time limit; analysis has not started.');
        if (!hasReadablePdfText(text)) throw problem('PDF_EMPTY_PAGE', `No readable text was found on PDF page ${page.num}. Review that page or attach a readable copy; analysis has not started.`);
        method = 'local_ocr';
      }
      pages.push({ page: page.num, text, method });
    }
    signal?.throwIfAborted();
    const ocrPages = pages.filter(page => page.method === 'local_ocr').length;
    const note = ocrPages ? `PDF text: ${ocrPages} of ${pages.length} pages recognized by local OCR, which may contain errors. Charts and visual meaning are not interpreted. Do not treat OCR as source verification.\n\n` : '';
    return {
      text: note + pages.map(page => `PDF page ${page.page}${page.method === 'local_ocr' ? ' (OCR)' : ''}\n${page.text}`).join('\n\n'),
      pages, method: ocrPages === pages.length ? 'local_ocr' : ocrPages ? 'pdf_text_and_local_ocr' : 'pdf_text', ocrPages,
    };
  } catch (error) {
    if (signal?.aborted) throw problem('PDF_EXTRACTION_CANCELLED', 'Local PDF extraction stopped; analysis has not started.');
    if (stoppedError) throw stoppedError;
    if (/^PDF_/.test(error?.code)) throw error;
    throw problem('PDF_EXTRACTION_FAILED', 'PDF extraction failed. Retry or attach a readable copy; analysis has not started.');
  } finally {
    active = false; clearTimeout(timer); clearInterval(heartbeat);
    signal?.removeEventListener('abort', cancelled);
    // Also cancel an outstanding native OCR child before removing its temp file.
    controller.abort();
    if (parser) await parser.destroy().catch(() => {});
    if (ocrWork) await ocrWork.catch(() => {});
  }
}
