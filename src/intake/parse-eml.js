// Minimal RFC822/MIME parser for .eml intake artifacts.
//
// Scope is intentionally narrow: this exists to feed the EXISTING AngelList
// invite parser (src/sync/parsers/angellist-invite.js), which wants
// { subject, from, receivedAt, text, html, messageId } — the same shape the
// Gmail sync path already produces. It is not a general-purpose mail client:
// no attachment extraction, no nested message/rfc822 parts, one
// Content-Transfer-Encoding layer per leaf part. That's sufficient for the
// invite/founder-update emails intake needs to classify.

import { htmlToText } from '../sync/parsers/angellist-invite.js';

function decodeRFC2047(value) {
  if (!value) return value;
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    try {
      const isUtf8 = /utf-?8/i.test(charset);
      if (enc.toUpperCase() === 'B') {
        return Buffer.from(text, 'base64').toString(isUtf8 ? 'utf-8' : 'latin1');
      }
      // Q-encoding: underscore = space, =XX = hex byte
      const raw = text
        .replace(/_/g, ' ')
        .replace(/=([0-9A-Fa-f]{2})/g, (__, hex) => String.fromCharCode(parseInt(hex, 16)));
      return Buffer.from(raw, 'latin1').toString(isUtf8 ? 'utf-8' : 'latin1');
    } catch {
      return text;
    }
  });
}

function decodeQuotedPrintable(str) {
  return str
    .replace(/=\r?\n/g, '') // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Unfold header continuation lines (a line starting with space/tab continues
// the previous header) then split into a lowercased-key map. Duplicate
// headers keep the first occurrence — fine for the handful we read.
function parseHeaders(headerBlock) {
  const lines = headerBlock.split(/\r?\n/);
  const unfolded = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += ' ' + line.trim();
    } else if (line.trim() !== '') {
      unfolded.push(line);
    }
  }
  const headers = {};
  for (const line of unfolded) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!(key in headers)) headers[key] = value;
  }
  return headers;
}

function parseContentType(value) {
  if (!value) return { type: 'text/plain', params: {} };
  const parts = value.split(';').map(s => s.trim());
  const type = parts[0].toLowerCase();
  const params = {};
  for (const part of parts.slice(1)) {
    const m = part.match(/^([^=]+)=(.*)$/);
    if (m) {
      let v = m[2].trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      params[m[1].trim().toLowerCase()] = v;
    }
  }
  return { type, params };
}

function decodeBody(raw, transferEncoding) {
  const enc = (transferEncoding || '7bit').toLowerCase();
  if (enc === 'base64') {
    return Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf-8');
  }
  if (enc === 'quoted-printable') {
    return decodeQuotedPrintable(raw);
  }
  return raw; // 7bit/8bit/binary: already plain text
}

// Splits a multipart body on its boundary into raw { headers, body } parts.
function splitMultipart(body, boundary) {
  const marker = `--${boundary}`;
  const segments = body.split(marker);
  const parts = [];
  for (const seg of segments) {
    const trimmed = seg.replace(/^\r?\n/, '');
    if (trimmed.startsWith('--') || trimmed.trim() === '') continue; // closing boundary / preamble / epilogue
    const headerEnd = trimmed.search(/\r?\n\r?\n/);
    if (headerEnd === -1) continue;
    const headerBlock = trimmed.slice(0, headerEnd);
    const partBody = trimmed.slice(headerEnd).replace(/^\r?\n\r?\n/, '');
    parts.push({ headers: parseHeaders(headerBlock), body: partBody });
  }
  return parts;
}

// Walks a (possibly nested multipart) MIME structure, collecting the first
// text/plain and text/html leaf parts found. Non-text leaves (attachments)
// are skipped rather than falling through to "text" by default.
function extractTextParts(headers, body, acc = { text: null, html: null }) {
  const { type, params } = parseContentType(headers['content-type']);
  if (type.startsWith('multipart/')) {
    if (!params.boundary) return acc;
    for (const part of splitMultipart(body, params.boundary)) {
      extractTextParts(part.headers, part.body, acc);
    }
    return acc;
  }
  if (!type.startsWith('text/')) return acc;
  const decoded = decodeBody(body, headers['content-transfer-encoding']);
  if (type === 'text/html') {
    if (acc.html == null) acc.html = decoded;
  } else if (acc.text == null) {
    acc.text = decoded;
  }
  return acc;
}

/**
 * Parse a raw RFC822 message (Buffer or string) into the shape
 * src/sync/parsers/angellist-invite.js's parseInviteEmail expects:
 * { subject, from, receivedAt, text, html, messageId }.
 */
export function parseEml(input) {
  const raw = Buffer.isBuffer(input) ? input.toString('utf-8') : String(input);
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const headerBlock = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
  const bodyBlock = headerEnd === -1 ? '' : raw.slice(headerEnd).replace(/^\r?\n\r?\n/, '');

  const headers = parseHeaders(headerBlock);
  const { text, html } = extractTextParts(headers, bodyBlock);

  const dateHeader = headers['date'];
  let receivedAt = null;
  if (dateHeader) {
    const d = new Date(dateHeader);
    if (!Number.isNaN(d.getTime())) receivedAt = d.toISOString();
  }

  const messageIdRaw = headers['message-id'];
  const messageId = messageIdRaw ? messageIdRaw.replace(/^<|>$/g, '') : null;

  return {
    subject: decodeRFC2047(headers['subject'] || ''),
    from: decodeRFC2047(headers['from'] || ''),
    receivedAt,
    messageId,
    text: text || (html ? htmlToText(html) : ''),
    html: html || null,
  };
}

/**
 * Heuristic: does this content look like an RFC822 message? Used by
 * classifyArtifact alongside the .eml filename extension. Requires a
 * From:/Subject: header pair ahead of a header/body blank-line separator —
 * enough to distinguish a real email from markdown/text that merely
 * contains the word "From" somewhere in its body.
 */
export function looksLikeRFC822(text) {
  if (!text) return false;
  const head = text.slice(0, 4000);
  const sepIdx = head.search(/\r?\n\r?\n/);
  if (sepIdx === -1) return false;
  const headerSection = head.slice(0, sepIdx);
  const hasFrom = /^From:\s*.+/im.test(headerSection);
  const hasSubject = /^Subject:\s*.+/im.test(headerSection);
  return hasFrom && hasSubject;
}
