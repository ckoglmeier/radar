const BLOCK_TAGS = 'address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul';

const NAMED_ENTITIES = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
  mdash: '—',
  ndash: '–',
  bull: '•',
};

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1].toLowerCase() === 'x';
      const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      return String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function extractHtmlText(html) {
  if (!html) return '';
  return decodeEntities(String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// PDF extraction is deliberately best-effort. A malformed, scanned, or
// unsupported PDF remains a provenance document instead of failing intake.
export async function extractPdfText(content) {
  let parser;
  try {
    const { PDFParse } = await import('pdf-parse');
    parser = new PDFParse({ data: Buffer.isBuffer(content) ? content : Buffer.from(content) });
    const result = await parser.getText();
    const text = result?.text?.trim();
    return text || null;
  } catch {
    return null;
  } finally {
    if (parser) {
      try { await parser.destroy(); } catch { /* extraction already has its result */ }
    }
  }
}
