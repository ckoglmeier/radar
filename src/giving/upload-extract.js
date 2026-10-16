// Deterministic extraction of giving proposals from an uploaded file (no model).
//
//   .eml   parse the message; Daffy templates are parsed exactly (HTML part used for amounts
//          that only appear there).
//   .pdf   text layer; Daffy templates parsed exactly.
//   .csv   column mapping (parse-csv.js).
//   image  the caller supplies on-device OCR text; Daffy templates parsed exactly.
//   .txt   as text.
// Anything not recognized returns its text with no candidates, so the caller can offer
// optional model extraction or manual entry. Nothing here contacts a network service.

import { parseEml } from '../intake/parse-eml.js';
import { extractPdfText } from '../intake/extract-text.js';
import { isDaffyEmail, parseDaffyEmail } from './parse-daffy.js';
import { parseGivingCsv } from './parse-csv.js';

export const UPLOAD_KINDS = Object.freeze({ eml: 'Email file', pdf: 'PDF', csv: 'Spreadsheet (CSV)', image: 'Screenshot', text: 'Text' });

export function uploadKind(fileName = '', mime = '') {
  const name = String(fileName).toLowerCase();
  if (name.endsWith('.eml') || mime === 'message/rfc822') return 'eml';
  if (name.endsWith('.pdf') || mime === 'application/pdf') return 'pdf';
  if (name.endsWith('.csv') || mime === 'text/csv') return 'csv';
  if (/\.(png|jpe?g|heic|webp|gif|tiff?)$/.test(name) || /^image\//.test(mime)) return 'image';
  if (name.endsWith('.txt') || mime === 'text/plain') return 'text';
  return null;
}

const domainOf = from => (/@([A-Za-z0-9.-]+)/.exec(String(from || '')) || [])[1] || '';
const nameOf = from => String(from || '').replace(/<[^>]*>/, '').replace(/"/g, '').trim();

function fromDaffy(text, { html = null, receivedAt = null, source }) {
  const parsed = parseDaffyEmail({ text, html, receivedAt });
  return parsed ? [{ excerpt: parsed.excerpt, proposed: parsed.proposed, source }] : [];
}

// Returns { kind, text, candidates, recognized, mapping?, missing? }.
export async function extractUploadCandidates({ fileName, mime = '', bytes, ocrText = null, csvVehicle = 'unknown' }) {
  const kind = uploadKind(fileName, mime);
  if (!kind) return { kind: null, text: null, candidates: [], recognized: false };
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);

  if (kind === 'csv') {
    const result = parseGivingCsv(buffer.toString('utf8'), { vehicle: csvVehicle });
    return {
      kind, text: null, mapping: result.mapping, missing: result.missing, recognized: result.rows.length > 0,
      candidates: result.rows.map(row => ({ excerpt: row.excerpt, proposed: row.proposed, extraIssues: row.extraIssues, source: { subject: fileName, from_name: 'Spreadsheet' } })),
    };
  }
  if (kind === 'eml') {
    const email = parseEml(buffer);
    const source = { subject: email.subject, from_name: nameOf(email.from), from_domain: domainOf(email.from), received_at: email.receivedAt };
    const candidates = isDaffyEmail({ from: email.from, text: email.text }) ? fromDaffy(email.text, { html: email.html, receivedAt: email.receivedAt, source }) : [];
    return { kind, text: email.text, candidates, recognized: candidates.length > 0, source };
  }
  const text = kind === 'pdf' ? await extractPdfText(buffer) : kind === 'image' ? ocrText : buffer.toString('utf8');
  if (!text) return { kind, text: null, candidates: [], recognized: false };
  const source = { subject: fileName, from_name: kind === 'image' ? 'Screenshot' : 'Uploaded file' };
  const candidates = isDaffyEmail({ text }) || /donation recommendation|sent your donation/i.test(text) ? fromDaffy(text, { source }) : [];
  return { kind, text, candidates, recognized: candidates.length > 0, source };
}
