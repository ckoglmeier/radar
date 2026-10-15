// Earned Equity offer-document intelligence (pure, no I/O, no logging).
//
// Deterministic first: classification, regex extraction, plan-reference detection and
// term-review rules run on plain text. Everything produced here is a PROPOSAL; nothing
// creates positions, grants or revisions. The AI pass (app side) is merged through
// mergeModelOutput(), which only ever accepts model items that are verbatim-evidenced.
//
// Privacy: this module never logs or throws document text, quotes, filenames or amounts.
// Spec: docs/earned-equity/INTELLIGENCE_CONTRACT.md "Document rules (C)", plan §5-6.

import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { SCHEMAS, VALUE_STATES } from '../../packages/earned-equity-core/schema.mjs';

export const EXTRACTION_VERSION = 'earned-equity-docs/1';
export const MAX_QUOTE_CHARS = 300;
export const MAX_LOCATOR_CHARS = 200;

export const DOC_CLASSES = Object.freeze([
  'cover_letter', 'offer_letter', 'grant_notice', 'equity_plan', 'service_agreement',
  'ciia', 'amendment', 'cap_disclosure', 'education', 'benefits_overview', 'other',
]);
const NO_PERSONAL_TERMS = new Set(['education', 'benefits_overview']);
const NO_GRANT_TERMS = new Set(['equity_plan', 'ciia', 'cap_disclosure']);

export const INSTRUMENTS = Object.freeze([...SCHEMAS.offerRevision.properties.grants.items.properties.instrument.enum]);
const MODELED_INSTRUMENTS = new Set(['iso', 'nso']);

export const FINDING_CATEGORIES = Object.freeze([
  'exercise_window', 'vesting_service', 'repurchase_forfeiture', 'transfer_liquidity', 'ownership_basis', 'ip_obligations',
]);
export const SEVERITIES = Object.freeze(['low', 'medium', 'high']);
export const CONFIDENCES = Object.freeze(['low', 'medium', 'high']);
export const FINDING_WORDINGS = Object.freeze(['material_term', 'unclear', 'requires_review']);

// Proposal field names. 'grant.*' fields map onto one grant component; 'capitalization.*'
// are helper facts used only to reconcile a quoted percentage against a share count.
export const FIELDS = Object.freeze([
  'cash.annualBase', 'cash.annualTargetBonus', 'cash.signingBonus', 'cash.signingRepaymentMonths',
  'serviceStartDate',
  'grant.instrument', 'grant.units', 'grant.quotedOwnershipPct', 'grant.ownershipDenominator.basis',
  'grant.ownershipDenominator.asOfDate', 'grant.strikePrice', 'grant.grantDate', 'grant.boardApproval',
  'grant.vesting.commencementDate', 'grant.vesting.totalMonths', 'grant.vesting.cliffMonths',
  'grant.vesting.cadence', 'grant.vesting.acceleration',
  'grant.exercise.postTerminationWindowMonths', 'grant.exercise.expirationYears', 'grant.exercise.earlyExercise',
  'capitalization.fullyDilutedShares', 'capitalization.outstandingShares',
]);

const UNITS_LABEL = {
  'cash.annualBase': 'USD/year', 'cash.annualTargetBonus': 'USD/year', 'cash.signingBonus': 'USD',
  'cash.signingRepaymentMonths': 'months', serviceStartDate: 'date', 'grant.instrument': 'instrument',
  'grant.units': 'units', 'grant.quotedOwnershipPct': 'percent', 'grant.ownershipDenominator.basis': 'enum',
  'grant.ownershipDenominator.asOfDate': 'date', 'grant.strikePrice': 'USD/share', 'grant.grantDate': 'date',
  'grant.boardApproval': 'enum', 'grant.vesting.commencementDate': 'date', 'grant.vesting.totalMonths': 'months',
  'grant.vesting.cliffMonths': 'months', 'grant.vesting.cadence': 'enum', 'grant.vesting.acceleration': 'enum',
  'grant.exercise.postTerminationWindowMonths': 'months', 'grant.exercise.expirationYears': 'years',
  'grant.exercise.earlyExercise': 'boolean', 'capitalization.fullyDilutedShares': 'units',
  'capitalization.outstandingShares': 'units',
};

const DECIMAL = /^\d{1,15}(\.\d{1,12})?$/;
const INTEGER = /^\d{1,15}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SMALL_INT = /^\d{1,3}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ENUM_VALUES = {
  'grant.instrument': INSTRUMENTS,
  'grant.ownershipDenominator.basis': ['fully_diluted', 'outstanding', 'unknown'],
  'grant.boardApproval': ['approved', 'pending'],
  'grant.vesting.cadence': ['monthly', 'quarterly', 'annual', 'performance', 'other'],
  'grant.vesting.acceleration': ['none', 'single_trigger', 'double_trigger', 'unknown'],
  'grant.exercise.earlyExercise': ['true', 'false'],
};
const DATE_FIELDS = new Set(['serviceStartDate', 'grant.ownershipDenominator.asOfDate', 'grant.grantDate', 'grant.vesting.commencementDate']);
const UNIT_FIELDS = new Set(['grant.units', 'capitalization.fullyDilutedShares', 'capitalization.outstandingShares']);
const DECIMAL_FIELDS = new Set([
  'cash.annualBase', 'cash.annualTargetBonus', 'cash.signingBonus', 'grant.quotedOwnershipPct', 'grant.strikePrice',
  'grant.exercise.postTerminationWindowMonths', 'grant.exercise.expirationYears',
]);
const SMALL_INT_FIELDS = new Set(['cash.signingRepaymentMonths', 'grant.vesting.totalMonths', 'grant.vesting.cliffMonths']);

export function isRealIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// Returns an error code or null. Values are validated, never coerced.
export function fieldValueProblem(field, value) {
  if (!FIELDS.includes(field)) return 'unknown_field';
  if (value === null) return null;
  if (typeof value !== 'string') return 'value_not_string';
  if (UNIT_FIELDS.has(field)) return INTEGER.test(value) ? null : 'units_not_integer';
  if (DATE_FIELDS.has(field)) return isRealIsoDate(value) ? null : 'date_not_iso';
  if (DECIMAL_FIELDS.has(field)) return DECIMAL.test(value) ? null : 'not_decimal';
  if (SMALL_INT_FIELDS.has(field)) return SMALL_INT.test(value) ? null : 'not_integer';
  if (ENUM_VALUES[field]) return ENUM_VALUES[field].includes(value) ? null : 'not_in_enum';
  return 'unknown_field';
}

// ---------------------------------------------------------------------------
// Text, lines, evidence
// ---------------------------------------------------------------------------

export function normalizeDocumentText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[   ]/g, ' ')
    .replace(/\f/g, '\n')
    .replace(/[​‌‍﻿]/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

function splitLines(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i === text.length || text[i] === '\n') {
      lines.push({ n: lines.length + 1, start, end: i, text: text.slice(start, i) });
      start = i + 1;
    }
  }
  return lines;
}

function clean(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

export function boundedQuote(value) {
  const text = clean(value);
  return text.length <= MAX_QUOTE_CHARS ? text : text.slice(0, MAX_QUOTE_CHARS);
}

// Evidence for a match inside a line: a ≤300-char window centred on the match.
function evidenceAt(line, index, length) {
  const lineText = line.text;
  let from = 0;
  let to = lineText.length;
  if (to - from > MAX_QUOTE_CHARS) {
    from = Math.max(0, Math.min(index - 100, lineText.length - MAX_QUOTE_CHARS));
    to = Math.min(lineText.length, from + MAX_QUOTE_CHARS);
    if (index + length > to) to = Math.min(lineText.length, index + length);
  }
  const raw = lineText.slice(from, to);
  const lead = raw.length - raw.trimStart().length;
  const quote = boundedQuote(raw);
  const absStart = line.start + from + lead;
  return { locator: `line ${line.n}, chars ${absStart}-${absStart + quote.length}`, quote };
}

function wholeDocumentEvidence() {
  return { locator: 'whole document (term not stated)', quote: '' };
}

function normalizeForSearch(text) {
  const out = [];
  const map = [];
  let lastSpace = true;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!lastSpace) { out.push(' '); map.push(i); lastSpace = true; }
    } else {
      out.push(ch.toLowerCase()); map.push(i); lastSpace = false;
    }
  }
  return { text: out.join(''), map };
}

// Finds a (model-supplied) quote verbatim in the document, ignoring case and whitespace runs.
export function locateQuote(text, quote) {
  const needle = normalizeForSearch(String(quote ?? '')).text.trim();
  if (needle.length < 3) return null;
  const hay = normalizeForSearch(text);
  const at = hay.text.indexOf(needle);
  if (at < 0) return null;
  const start = hay.map[at];
  const end = hay.map[at + needle.length - 1] + 1;
  const line = text.slice(0, start).split('\n').length;
  return { start, end, line, locator: `line ${line}, chars ${start}-${end}`.slice(0, MAX_LOCATOR_CHARS), quote: boundedQuote(text.slice(start, end)) };
}

// ---------------------------------------------------------------------------
// Prompt-injection detection. Matching lines are masked before any extraction and are
// recorded as findings; document text is data, never instructions.
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,60}\b(?:previous|prior|above|earlier|preceding|all|any|your)\b[^.\n]{0,40}\b(?:instructions?|prompts?|rules?|guidelines?|policy|policies)\b/i,
  /\b(?:system prompt|developer message|new instructions?|updated instructions?)\b/i,
  /\byou\s+(?:are\s+now|must\s+now|will\s+now|should\s+now)\b/i,
  /\b(?:as\s+an?\s+(?:ai|assistant|language model)|assistant\s*:|<\/?\s*(?:system|assistant|instructions?)\s*>|\[\s*(?:system|inst)\s*\])/i,
  /\b(?:do not|don't|never)\s+(?:flag|mention|report|reveal|warn|disclose)\b/i,
  /^\s*(?:please\s+)?(?:set|change|mark|record|report|output|return)\s+(?:the\s+)?(?:strike|exercise price|units?|shares|vesting|board approval|grant date|salary|base)\b[^.\n]{0,24}\b(?:to|as)\b/i,
  /\b(?:extract(?:ion)?|parser|model|llm)\b[^.\n]{0,30}\b(?:must|should|shall|will)\s+(?:output|return|record|report|set)\b/i,
];

export function detectInjections(text, lines = splitLines(text)) {
  const found = [];
  for (const line of lines) {
    if (!line.text.trim()) continue;
    for (const pattern of INJECTION_PATTERNS) {
      const match = pattern.exec(line.text);
      if (match) {
        const evidence = evidenceAt(line, match.index, match[0].length);
        found.push({ line: line.n, start: line.start, end: line.end, ...evidence });
        break;
      }
    }
  }
  return found;
}

function maskLines(text, spans) {
  if (!spans.length) return text;
  let out = text;
  for (const span of spans) out = out.slice(0, span.start) + ' '.repeat(span.end - span.start) + out.slice(span.end);
  return out;
}

// What a model is allowed to see: instruction-like lines are replaced by a marker.
export const EMBEDDED_INSTRUCTION_MARKER = '[line removed: embedded instruction]';
export function maskEmbeddedInstructions(text) {
  const normalized = normalizeDocumentText(text);
  const lines = splitLines(normalized);
  const hits = new Set(detectInjections(normalized, lines).map(i => i.line));
  return lines.map(line => (hits.has(line.n) ? EMBEDDED_INSTRUCTION_MARKER : line.text)).join('\n');
}

// ---------------------------------------------------------------------------
// Text quality (OCR / parse failures are surfaced, never an empty success)
// ---------------------------------------------------------------------------

export function assessTextQuality(text) {
  const value = String(text ?? '');
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, code: 'empty_text', message: 'No readable text was found in this document. It may be a scan that needs OCR.' };
  if (trimmed.length < 40) return { ok: false, code: 'text_too_short', message: 'Too little readable text was found to review this document.' };
  const nonSpace = trimmed.replace(/\s/g, '');
  const replacement = (nonSpace.match(/�/g) || []).length;
  const letters = (nonSpace.match(/[A-Za-z]/g) || []).length;
  const digits = (nonSpace.match(/\d/g) || []).length;
  if (replacement / nonSpace.length > 0.05 || (letters + digits) / nonSpace.length < 0.55) {
    return { ok: false, code: 'garbled_text', message: 'The extracted text is mostly unreadable symbols. The document may need OCR or a cleaner copy.' };
  }
  const words = trimmed.split(/\s+/).map(token => token.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '')).filter(token => token.length >= 3 && /^[A-Za-z]+$/.test(token));
  if (words.length < 5) return { ok: false, code: 'garbled_text', message: 'The extracted text does not contain readable sentences.' };
  const withVowel = words.filter(word => /[aeiouyAEIOUY]/.test(word)).length;
  if (withVowel / words.length < 0.7) return { ok: false, code: 'garbled_text', message: 'The extracted text looks like OCR noise rather than readable words.' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const HEAD_CHARS = 700;
const CLASS_RULES = [
  { cls: 'grant_notice', head: /\b(?:notice of (?:stock )?(?:option |restricted stock unit |rsu )?(?:grant|award)|(?:stock )?option grant notice|grant notice|notice of grant)\b/i, body: /\bgrant notice\b|\bnotice of (?:stock )?(?:option )?grant\b/i },
  { cls: 'equity_plan', head: /\b(?:equity|stock) (?:incentive|option|compensation) plan\b|\bplan document\b/i, body: /\bplan administrator\b|\bshares? reserved\b|\bcommittee shall (?:administer|have)\b|\bterms? of the plan\b/i },
  { cls: 'ciia', head: /\b(?:confidential information (?:and|&) invention assignment|proprietary information (?:and|&) inventions? agreement|invention assignment agreement|confidentiality and (?:invention|ip) assignment)\b/i, body: /\bhereby assigns?\b[^.\n]{0,80}\b(?:inventions?|work product)\b/i },
  { cls: 'amendment', headWeight: 7, head: /\b(?:(?:first|second|third|\w+) )?amendment (?:no\.? ?\d+ )?to\b|\bamended and restated\b/i, body: /\bhereby (?:amended|amends|revised)\b/i },
  { cls: 'cap_disclosure', head: /\bcapitali[sz]ation (?:table|disclosure|summary)\b|\bcap table\b|\b409a (?:valuation|report)\b/i, body: /\bfully[- ]diluted capitali[sz]ation\b/i },
  { cls: 'service_agreement', head: /\b(?:consulting|advisor(?:y)?|independent contractor|services|employment) agreement\b/i, body: /\bindependent contractor\b|\bscope of services\b/i },
  { cls: 'education', head: /\b(?:guide to|understanding|how (?:stock )?options? work|equity 101|what (?:are|is) (?:stock )?options?|startup equity (?:explained|basics)|learning center)\b/i, body: /\bfor illustrative purposes\b|\bhypothetical (?:example|scenario|company|employee)\b|\bin this example\b|\bthis (?:guide|article) (?:explains|covers)\b|\blet'?s say\b/i },
  { cls: 'benefits_overview', head: /\bbenefits (?:overview|summary|guide)\b|\bemployee benefits\b|\btotal rewards\b|\bbenefits at a glance\b/i, body: /\b401\(?k\)?\b|\bhealth(?:care)? insurance\b|\bpaid time off\b|\bopen enrollment\b|\bparental leave\b/i },
];
const COVER_LETTER = [
  /^\s*(?:dear|hi|hello)\b[^\n]{0,60}[,:]?\s*$/im,
  /\b(?:cover (?:letter|note)|enclosed (?:please find|is|are|you will find)|attached (?:please find|is|are|you will find)|please find (?:attached|enclosed))\b/i,
  /\b(?:official|formal|final|signed|full)\b[^.\n]{0,30}\boffer\b[^.\n]{0,40}\b(?:will (?:follow|be sent|arrive)|to follow|separately|under separate cover|forthcoming|is coming)\b/i,
  /\b(?:will (?:follow|be sent|send you)|to follow|forthcoming)\b[^.\n]{0,60}\b(?:official|formal|final|signed|full)\b[^.\n]{0,20}\boffer\b/i,
];
const OFFER_LETTER = [
  /\b(?:we are (?:pleased|delighted|excited) to (?:offer|extend)|pleased to offer you|offer of employment|this offer letter|offer letter)\b/i,
  /\b(?:accepted and agreed|please sign|sign (?:and return|below)|signature|your signature below)\b/i,
  /\b(?:base salary|annual salary|start date|at-will)\b/i,
];

export function classifyOfferDocument(text) {
  const normalized = normalizeDocumentText(text);
  const head = normalized.slice(0, HEAD_CHARS);
  const scores = new Map(DOC_CLASSES.map(cls => [cls, 0]));
  const signals = [];
  for (const rule of CLASS_RULES) {
    if (rule.head.test(head)) { scores.set(rule.cls, scores.get(rule.cls) + (rule.headWeight || 4)); signals.push(`${rule.cls}:title`); }
    if (rule.body.test(normalized)) { scores.set(rule.cls, scores.get(rule.cls) + 2); signals.push(`${rule.cls}:body`); }
  }
  let cover = 0;
  for (const pattern of COVER_LETTER) if (pattern.test(normalized)) cover += 1;
  if (cover) { scores.set('cover_letter', cover * 2 + (cover >= 2 ? 1 : 0)); signals.push(`cover_letter:${cover}`); }
  let offer = 0;
  for (const pattern of OFFER_LETTER) if (pattern.test(normalized)) offer += 1;
  if (offer) { scores.set('offer_letter', offer * 2); signals.push(`offer_letter:${offer}`); }
  // A document that defers to a not-yet-delivered official offer is a cover letter, never an offer.
  if (cover >= 2 && scores.get('offer_letter') <= scores.get('cover_letter') + 2) scores.set('offer_letter', 0);
  const priority = ['amendment', 'grant_notice', 'equity_plan', 'ciia', 'cap_disclosure', 'education', 'benefits_overview', 'service_agreement', 'cover_letter', 'offer_letter'];
  let best = 'other';
  let bestScore = 0;
  for (const cls of priority) {
    const score = scores.get(cls);
    if (score > bestScore) { best = cls; bestScore = score; }
  }
  if (bestScore < 3) return { docClass: 'other', confidence: 'low', signals };
  return { docClass: best, confidence: bestScore >= 6 ? 'high' : 'medium', signals };
}

// ---------------------------------------------------------------------------
// Referenced-document detection → checklist
// ---------------------------------------------------------------------------

const REFERENCE_RULES = [
  { key: 'official_offer', label: 'Official offer letter', expectedClass: 'offer_letter', pattern: /\b(?:official|formal|final|signed|full)\s+offer(?:\s+(?:letter|package|documents?|paperwork))?\b/i },
  { key: 'ciia', label: 'Confidential information and invention assignment agreement (CIIA)', expectedClass: 'ciia', pattern: /\b(?:CIIA|PIIA|confidential information (?:and|&) invention assignment(?: agreement)?|proprietary information (?:and|&) inventions? (?:assignment )?agreement|invention assignment agreement)\b/i },
  { key: 'ethics_agreement', label: 'Ethics agreement', expectedClass: null, pattern: /\bethics\s+(?:agreement|acknowledg(?:e)?ment|policy|pledge)\b/i },
  { key: 'equity_plan', label: 'Equity incentive plan', expectedClass: 'equity_plan', pattern: /\b(?:(?:20\d\d|\d{4})\s+)?(?:equity|stock)\s+(?:incentive|option|compensation)\s+plan\b/i },
  { key: 'grant_notice', label: 'Stock option agreement or grant notice', expectedClass: 'grant_notice', pattern: /\b(?:stock option agreement|option agreement|notice of (?:stock )?(?:option )?grant|(?:stock option )?grant notice)\b/i },
  { key: 'cap_disclosure', label: 'Capitalization table or 409A valuation', expectedClass: 'cap_disclosure', pattern: /\b(?:409A\s+(?:valuation|report)|cap(?:italization)?\s+table)\b/i },
];

const DOC_KEYS_BY_CLASS = { offer_letter: 'official_offer', ciia: 'ciia', equity_plan: 'equity_plan', grant_notice: 'grant_notice', cap_disclosure: 'cap_disclosure' };

export function detectReferences(text, lines = splitLines(text)) {
  const refs = [];
  for (const rule of REFERENCE_RULES) {
    for (const line of lines) {
      const match = rule.pattern.exec(line.text);
      if (match) {
        refs.push({ key: rule.key, label: rule.label, expectedClass: rule.expectedClass, ...evidenceAt(line, match.index, match[0].length) });
        break;
      }
    }
  }
  return refs;
}

// Which referenced keys this document itself satisfies.
function selfKeys(docClass, text) {
  const keys = new Set();
  if (DOC_KEYS_BY_CLASS[docClass]) keys.add(DOC_KEYS_BY_CLASS[docClass]);
  const titleLines = normalizeDocumentText(text).split('\n').map(l => l.trim()).filter(Boolean).slice(0, 3);
  if (titleLines.some(l => l.length <= 80 && /\bethics\s+(?:agreement|acknowledg(?:e)?ment)\b/i.test(l))) keys.add('ethics_agreement');
  return keys;
}

// Referenced-but-not-provided documents become checklist items. `provided` is a set of keys
// satisfied by other documents; a document never satisfies a reference to itself-as-a-cover.
export function buildChecklist(references, providedKeys = new Set()) {
  const seen = new Set();
  const items = [];
  for (const ref of references) {
    if (seen.has(ref.key)) continue;
    seen.add(ref.key);
    items.push({
      key: ref.key, label: ref.label, expectedClass: ref.expectedClass,
      status: providedKeys.has(ref.key) ? 'provided' : 'missing',
      locator: ref.locator, quote: ref.quote,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Value parsing helpers
// ---------------------------------------------------------------------------

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  eighteen: 18, twenty: 20, 'twenty-four': 24, thirty: 30, 'thirty-six': 36, 'forty-eight': 48, sixty: 60, ninety: 90,
  'one hundred eighty': 180,
};
const NUM_TOKEN = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join('|')})`;

function wordOrInt(token) {
  const lower = String(token).toLowerCase();
  if (/^\d+$/.test(lower)) return Number(lower);
  return NUMBER_WORDS[lower] ?? null;
}

const MONTH_NAMES = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)';

function iso(y, m, d) {
  const value = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isRealIsoDate(value) ? value : null;
}

// Unambiguous dates only. Slash dates with day and month both ≤12 and unequal are skipped.
function parseDates(lineText) {
  const found = [];
  const push = (index, length, value) => { if (value) found.push({ index, length, iso: value }); };
  for (const m of lineText.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) push(m.index, m[0].length, iso(+m[1], +m[2], +m[3]));
  for (const m of lineText.matchAll(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'))) push(m.index, m[0].length, iso(+m[3], MONTH_NAMES[m[1].toLowerCase()], +m[2]));
  for (const m of lineText.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, 'gi'))) push(m.index, m[0].length, iso(+m[3], MONTH_NAMES[m[2].toLowerCase()], +m[1]));
  let ambiguous = 0;
  for (const m of lineText.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) {
    const a = +m[1]; const b = +m[2];
    if (a === b || (a <= 12 && b > 12)) push(m.index, m[0].length, iso(+m[3], a, b));
    else if (b <= 12 && a > 12) push(m.index, m[0].length, iso(+m[3], b, a));
    else ambiguous += 1;
  }
  found.sort((x, y) => x.index - y.index);
  return { dates: found, ambiguous };
}

function parseMoney(raw) {
  const value = String(raw).replace(/,/g, '');
  return DECIMAL.test(value) ? value : null;
}

function parseUnits(raw) {
  const value = String(raw).replace(/,/g, '');
  return INTEGER.test(value) && Number(value) > 0 ? value : null;
}

function decimalPlaces(value) {
  const at = String(value).indexOf('.');
  return at < 0 ? 0 : String(value).length - at - 1;
}

// ---------------------------------------------------------------------------
// Deterministic extraction
// ---------------------------------------------------------------------------

const ILLUSTRATIVE = /\b(?:for example|for instance|e\.g\.|illustrat\w+|hypothetical\w*|suppose|let'?s say|imagine|sample|worked example|as an example|in this example)\b/i;

function candidate(field, value, line, index, length, extra = {}) {
  return { field, value, ...evidenceAt(line, index, length), ...extra };
}

const MONTHS_IN = { month: 1, months: 1, year: 12, years: 12 };

function extractFromLine(line, cls) {
  const out = [];
  const t = line.text;
  if (!t.trim()) return { out, notes: [] };
  const notes = [];
  const grantTerms = !NO_GRANT_TERMS.has(cls);
  const lower = t.toLowerCase();
  const isVestLine = /\bvest/i.test(t);

  // --- capitalization denominators (excluded from unit matching below) ---
  const capSpans = [];
  let m;
  const capPatterns = [
    { field: 'capitalization.fullyDilutedShares', re: /fully[- ]diluted\s+(?:capitali[sz]ation|shares?|share count|capital)[^0-9\n]{0,40}?(\d{1,3}(?:,\d{3})+|\d{4,15})/i },
    { field: 'capitalization.fullyDilutedShares', re: /(\d{1,3}(?:,\d{3})+|\d{4,15})\s+(?:fully[- ]diluted\s+shares?|shares?\s+(?:on a\s+)?fully[- ]diluted(?:\s+basis)?)/i },
    { field: 'capitalization.outstandingShares', re: /(\d{1,3}(?:,\d{3})+|\d{4,15})\s+shares?\s+(?:of\s+(?:common\s+)?stock\s+)?(?:issued and\s+)?outstanding/i },
    { field: 'capitalization.outstandingShares', re: /shares?\s+outstanding[^0-9\n]{0,30}?(\d{1,3}(?:,\d{3})+|\d{4,15})/i },
  ];
  for (const { field, re } of capPatterns) {
    m = re.exec(t);
    if (m) {
      const v = parseUnits(m[1]);
      if (v) { out.push(candidate(field, v, line, m.index, m[0].length)); capSpans.push([m.index, m.index + m[0].length]); }
    }
  }

  // --- instrument ---
  if (grantTerms) {
    const instPatterns = [
      ['iso', [/\bincentive stock options?\b/i, /\bISOs?\b/]],
      ['nso', [/\bnon[- ]?qualified (?:stock )?options?\b/i, /\bnon[- ]?statutory (?:stock )?options?\b/i, /\bNSOs?\b/, /\bNQSOs?\b/]],
      ['rsu', [/\brestricted stock units?\b/i, /\bRSUs?\b/]],
      ['profits_interest', [/\bprofits?[- ]interests?\b/i]],
      ['restricted_stock', [/\brestricted stock (?:award|grant|purchase|agreement)s?\b/i, /\bshares? of restricted stock\b/i]],
    ];
    const hits = new Map();
    for (const [value, res] of instPatterns) {
      for (const re of res) {
        const hit = re.exec(t);
        if (hit) { hits.set(value, hit); break; }
      }
    }
    if (hits.has('rsu')) hits.delete('restricted_stock');
    for (const [value, hit] of hits) out.push(candidate('grant.instrument', value, line, hit.index, hit[0].length));
  }

  // --- units ---
  if (grantTerms) {
    const cue = /\b(?:grant|granted|granting|award|awarded|option|options|purchase|subject to|number of|total of|covering|aggregate|restricted stock units?|rsus?)\b/i;
    const vestOk = !isVestLine || /\b(?:grant|granted|award|awarded|purchase|total|aggregate|covering)\b/i.test(t);
    if (cue.test(t) && vestOk) {
      const re = /\b(\d{1,3}(?:,\d{3})+|\d{1,15})\s+(?:(?:restricted\s+)?(?:shares?|stock options?|options?|RSUs?|restricted stock units?|units?))\b/gi;
      for (const hit of t.matchAll(re)) {
        const at = hit.index;
        if (capSpans.some(([a, b]) => at >= a && at < b)) continue;
        if (/\b(?:per|each)\s*$/i.test(t.slice(Math.max(0, at - 6), at))) continue;
        if (/^\s*(?:will|shall)\s+vest|^\s*vest/i.test(t.slice(at + hit[0].length, at + hit[0].length + 14))) continue;
        const value = parseUnits(hit[1]);
        if (value) out.push(candidate('grant.units', value, line, at, hit[0].length));
      }
    }
  }

  // --- strike ---
  if (grantTerms) {
    const re = /\b(?:exercise|strike)\s+price(?:\s+per\s+share)?[^$\d\n]{0,50}?\$\s*(\d{1,15}(?:\.\d{1,6})?)|\bat\s+(?:an?\s+)?(?:exercise|strike)\s+price\s+of\s+\$\s*(\d{1,15}(?:\.\d{1,6})?)|\$\s*(\d{1,15}(?:\.\d{1,6})?)\s+per\s+share\s+(?:exercise|strike)\s+price/i;
    m = re.exec(t);
    if (m) {
      const value = parseMoney(m[1] ?? m[2] ?? m[3]);
      if (value) out.push(candidate('grant.strikePrice', value, line, m.index, m[0].length));
    }
  }

  // --- percent ownership ---
  if (grantTerms) {
    for (const hit of t.matchAll(/(\d{1,3}(?:\.\d{1,6})?)\s*(?:%|percent\b)/gi)) {
      const after = t.slice(hit.index + hit[0].length, hit.index + hit[0].length + 60);
      const before = t.slice(Math.max(0, hit.index - 45), hit.index);
      const afterCue = /^([^.;\n]{0,40}?)(fully[- ]diluted|outstanding|issued)/i.exec(after);
      const beforeCue = /(ownership|equity|stake|fully[- ]diluted)[^.;%\n]{0,30}$/i.exec(before);
      if (afterCue && /vest|cliff|anniversary|bonus|install?ment|tranche/i.test(afterCue[1])) continue;
      if (!afterCue && !beforeCue) continue;
      if (/\b(?:bonus|salary|interest|discount|commission)\b/i.test(before.slice(-25))) continue;
      const value = String(hit[1]);
      if (!DECIMAL.test(value) || Number(value) > 100) continue;
      out.push(candidate('grant.quotedOwnershipPct', value, line, hit.index, hit[0].length));
      const cueText = `${afterCue ? afterCue[2] : ''} ${beforeCue ? beforeCue[1] : ''}`.toLowerCase();
      const basis = /fully/.test(cueText) || /fully[- ]diluted/i.test(after.slice(0, 70)) ? 'fully_diluted' : /outstanding/.test(cueText) ? 'outstanding' : null;
      if (basis) out.push(candidate('grant.ownershipDenominator.basis', basis, line, hit.index, hit[0].length));
      const asOf = new RegExp(`as of\\s+(.{0,30})`, 'i').exec(t.slice(hit.index));
      if (asOf) {
        const { dates } = parseDates(asOf[1]);
        if (dates[0]) out.push(candidate('grant.ownershipDenominator.asOfDate', dates[0].iso, line, hit.index, hit[0].length));
      }
    }
  }

  // --- dates ---
  const { dates, ambiguous } = parseDates(t);
  if (ambiguous) notes.push('ambiguous_numeric_date');
  const dateCues = [
    ['grant.vesting.commencementDate', /vesting\s+commencement(?:\s+date)?|vesting\s+(?:start|begin\w*)\s+date|vest\w*\s+(?:will\s+)?(?:begin|commence|start)\w*\s+(?:on|as of)|commencement\s+date\s+for\s+vesting/i],
    ['grant.grantDate', /date\s+of\s+grant|grant\s+date|granted\s+(?:on|as of)|effective\s+date\s+of\s+(?:the\s+)?grant|date\s+of\s+(?:this\s+)?award/i],
    ['serviceStartDate', /start\s+date|begin(?:ning)?\s+(?:your\s+)?(?:employment|work|service)|commenc\w+\s+(?:your\s+)?(?:employment|service|work)|employment\s+(?:will\s+)?(?:start|begin|commence)|expected\s+(?:start|first)|first\s+day|join\w*\s+(?:us|the company)\s+on/i],
  ];
  if (grantTerms || cls === 'offer_letter' || cls === 'cover_letter' || cls === 'service_agreement') {
    const used = new Set();
    for (const [field, re] of dateCues) {
      if (field.startsWith('grant.') && !grantTerms) continue;
      const cueMatch = re.exec(t);
      if (!cueMatch) continue;
      const after = dates.find(d => d.index >= cueMatch.index && !used.has(d.index));
      if (!after) continue;
      used.add(after.index);
      out.push(candidate(field, after.iso, line, Math.min(cueMatch.index, after.index), Math.max(cueMatch.index + cueMatch[0].length, after.index + after.length) - Math.min(cueMatch.index, after.index)));
    }
  }

  // --- board approval ---
  if (grantTerms) {
    const pending = /\bsubject to\b[^.\n]{0,40}\b(?:approval|ratification)\b[^.\n]{0,25}\b(?:board|directors)\b|\b(?:pending|contingent (?:up)?on|conditioned (?:up)?on|requires?|subject to)\b[^.\n]{0,25}\bboard(?: of directors)?(?:'s)? (?:approval|ratification)\b|\bboard approval\b[^.\n]{0,25}\b(?:pending|required|is required|has not)\b|\bhas not (?:yet )?been approved by the board\b/i;
    const approved = /\b(?:approved by the board|board(?: of directors)?(?: has)? (?:approved|ratified)|board approval (?:was|has been) (?:granted|obtained|received)|ratified by the board)\b/i;
    const pm = pending.exec(t);
    const am = approved.exec(t);
    if (pm) out.push(candidate('grant.boardApproval', 'pending', line, pm.index, pm[0].length));
    else if (am) out.push(candidate('grant.boardApproval', 'approved', line, am.index, am[0].length));
  }

  // --- vesting ---
  if (grantTerms) {
    const total = [
      new RegExp(`\\bvest(?:s|ing|ed)?\\b[^.\\n]{0,50}?\\b(?:over|during|across|through(?:out)?)\\s+(?:a\\s+|an\\s+|the\\s+)?(?:period\\s+of\\s+)?${NUM_TOKEN}(?:-|\\s)?(years?|months?)\\b`, 'i'),
      new RegExp(`\\b${NUM_TOKEN}[- ](years?|months?)\\s+vesting\\b`, 'i'),
      new RegExp(`\\bvesting\\s+(?:schedule|period|term)\\s+of\\s+${NUM_TOKEN}(?:-|\\s)?(years?|months?)\\b`, 'i'),
    ];
    for (const re of total) {
      m = re.exec(t);
      if (m) {
        const n = wordOrInt(m[1]);
        if (n !== null) { out.push(candidate('grant.vesting.totalMonths', String(n * MONTHS_IN[m[2].toLowerCase()]), line, m.index, m[0].length)); break; }
      }
    }
    m = /\b1\/(24|36|48|60)(?:th)?\b[^.\n]{0,40}\bmonth/i.exec(t);
    if (m) {
      out.push(candidate('grant.vesting.totalMonths', m[1], line, m.index, m[0].length));
      out.push(candidate('grant.vesting.cadence', 'monthly', line, m.index, m[0].length));
    }
    const cliffPatterns = [
      new RegExp(`\\b${NUM_TOKEN}[- ](years?|months?)\\s+cliff\\b`, 'i'),
      new RegExp(`\\bcliff\\b[^.\\n]{0,40}?${NUM_TOKEN}(?:-|\\s)?(years?|months?)\\b`, 'i'),
    ];
    for (const re of cliffPatterns) {
      m = re.exec(t);
      if (m) {
        const n = wordOrInt(m[1]);
        if (n !== null) { out.push(candidate('grant.vesting.cliffMonths', String(n * MONTHS_IN[m[2].toLowerCase()]), line, m.index, m[0].length)); break; }
      }
    }
    if (!out.some(c => c.field === 'grant.vesting.cliffMonths')) {
      m = /(?:25%|one[- ]quarter|1\/4)[^.\n]{0,60}?\b(?:first anniversary|one[- ]year anniversary|one year|12 months)\b/i.exec(t);
      if (m) out.push(candidate('grant.vesting.cliffMonths', '12', line, m.index, m[0].length));
    }
    if (isVestLine && !out.some(c => c.field === 'grant.vesting.cadence')) {
      m = /\b(monthly|quarterly|annual(?:ly)?|yearly)\b/i.exec(t);
      if (m) {
        const word = m[1].toLowerCase();
        out.push(candidate('grant.vesting.cadence', word.startsWith('month') ? 'monthly' : word.startsWith('quarter') ? 'quarterly' : 'annual', line, m.index, m[0].length));
      }
    }
    m = /\bsingle[- ]trigger\b/i.exec(t);
    if (m) out.push(candidate('grant.vesting.acceleration', 'single_trigger', line, m.index, m[0].length));
    m = /\bdouble[- ]trigger\b/i.exec(t);
    if (m) out.push(candidate('grant.vesting.acceleration', 'double_trigger', line, m.index, m[0].length));
    m = /\bno\s+(?:vesting\s+)?acceleration\b|\bnot\s+(?:be\s+)?(?:subject to|eligible for|entitled to)\s+(?:any\s+)?(?:vesting\s+)?acceleration\b/i.exec(t);
    if (m) out.push(candidate('grant.vesting.acceleration', 'none', line, m.index, m[0].length));
  }

  // --- exercise terms ---
  if (grantTerms) {
    const windowPatterns = [
      new RegExp(`\\b${NUM_TOKEN}[- ]?(days?|months?|years?)\\b[^.\\n]{0,60}?(?:following|after|from)\\s+(?:the\\s+)?(?:your\\s+)?(?:date\\s+of\\s+)?(?:termination|separation|cessation|end of (?:your )?(?:service|employment)|last day)`, 'i'),
      new RegExp(`\\bpost[- ]termination\\s+exercis\\w+\\s+(?:period|window)\\b[^.\\n]{0,40}?${NUM_TOKEN}[- ]?(days?|months?|years?)\\b`, 'i'),
      new RegExp(`\\b(?:exercis\\w+\\s+(?:period|window))\\b[^.\\n]{0,40}?${NUM_TOKEN}[- ]?(days?|months?|years?)\\b`, 'i'),
    ];
    for (const re of windowPatterns) {
      m = re.exec(t);
      if (!m) continue;
      const n = wordOrInt(m[1]);
      const unit = m[2].toLowerCase().replace(/s$/, '');
      if (n === null) continue;
      if (unit === 'day') {
        if (n % 30 === 0) {
          out.push(candidate('grant.exercise.postTerminationWindowMonths', String(n / 30), line, m.index, m[0].length,
            { note: `Stated as ${n} days; expressed as ${n / 30} month(s) using 30-day months.` }));
        } else {
          notes.push('exercise_window_days_not_month_multiple');
        }
      } else {
        out.push(candidate('grant.exercise.postTerminationWindowMonths', String(n * (unit === 'year' ? 12 : 1)), line, m.index, m[0].length));
      }
      break;
    }
    if (!isVestLine || /expir/i.test(t)) {
      m = new RegExp(`\\b(?:expires?|expiration|expire)\\b[^.\\n]{0,60}?${NUM_TOKEN}[- ]?years?\\b|\\b(?:term of|for a term of)\\s+${NUM_TOKEN}[- ]?years?\\b[^.\\n]{0,40}\\b(?:grant|option)`, 'i').exec(t);
      if (m) {
        const n = wordOrInt(m[1] ?? m[2]);
        if (n !== null) out.push(candidate('grant.exercise.expirationYears', String(n), line, m.index, m[0].length));
      }
    }
    if (/\bearly[- ]exercis/i.test(t)) {
      const neg = /\b(?:not|no|without|cannot|can't|isn't|prohibit\w*)\b[^.\n]{0,40}\bearly[- ]exercis\w*|\bearly[- ]exercis\w*[^.\n]{0,30}\b(?:is\s+)?(?:not\s+(?:permitted|available|allowed)|prohibited|unavailable)/i.exec(t);
      const pos = /\b(?:may|permitted|allowed|eligible|right|able)\b[^.\n]{0,50}\bearly[- ]exercis\w*|\bearly[- ]exercis\w*[^.\n]{0,30}\b(?:is\s+)?(?:permitted|available|allowed)/i.exec(t);
      if (neg) out.push(candidate('grant.exercise.earlyExercise', 'false', line, neg.index, neg[0].length));
      else if (pos) out.push(candidate('grant.exercise.earlyExercise', 'true', line, pos.index, pos[0].length));
    }
  }

  // --- cash ---
  const notMonthly = hit => !/^\s*(?:per\s+month|monthly|per\s+hour|hourly|bi-?weekly|per\s+week|weekly)/i.test(t.slice(hit.index + hit[0].length, hit.index + hit[0].length + 20));
  if (!NO_GRANT_TERMS.has(cls) || cls === 'ciia') {
    if (!/\bsign(?:ing)?[- ]?on\b|\bsigning\b/i.test(t) || /\bbase\b|\bsalary\b/i.test(t)) {
      m = /\b(?:annual(?:ized)?\s+)?(?:base\s+)?(?:salary|pay|compensation|fee)\b[^$\n%]{0,60}?\$\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{4,15}(?:\.\d{1,2})?)/i.exec(t);
      if (m && /\b(?:salary|base|annual|per year|per annum|annually)\b/i.test(t) && !/\b(?:bonus|signing|sign-on)\b/i.test(t.slice(Math.max(0, m.index - 20), m.index + m[0].length))) {
        if (notMonthly(m) && !/\bper\s+month\b|\bmonthly\b/i.test(m[0])) {
          const value = parseMoney(m[1]);
          if (value) out.push(candidate('cash.annualBase', value, line, m.index, m[0].length));
        } else notes.push('cash_not_annual');
      }
    }
    m = /\b(?:target|annual|performance|discretionary|incentive)?\s*bonus\b[^$\n%]{0,60}?\$\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{4,15}(?:\.\d{1,2})?)/i.exec(t);
    if (m && !/\b(?:sign(?:ing)?|sign-on|retention|relocation|referral)\b/i.test(t.slice(Math.max(0, m.index - 12), m.index + 40))) {
      const value = parseMoney(m[1]);
      if (value) out.push(candidate('cash.annualTargetBonus', value, line, m.index, m[0].length));
    } else if (/\b(?:target|annual)\s+bonus\b[^.\n]{0,50}\d+(?:\.\d+)?\s*%/i.test(t)) {
      notes.push('bonus_percentage_not_converted');
    }
    m = /\bsign(?:ing)?[- ]?on\s+bonus\b[^$\n]{0,60}?\$\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,15}(?:\.\d{1,2})?)|\bsigning\s+bonus\b[^$\n]{0,60}?\$\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,15}(?:\.\d{1,2})?)/i.exec(t);
    if (m) {
      const value = parseMoney(m[1] ?? m[2]);
      if (value) out.push(candidate('cash.signingBonus', value, line, m.index, m[0].length));
    }
    if (/\bsign(?:ing)?[- ]?on\b|\bsigning\b/i.test(t)) {
      m = new RegExp(`\\b(?:repay|reimburs\\w*|refund|clawback|claw back)\\b[^.\\n]{0,120}?(?:within|before|prior to|during)\\s+(?:the\\s+first\\s+)?${NUM_TOKEN}[- ]?months?\\b`, 'i').exec(t);
      if (!m) m = new RegExp(`(?:within|before|prior to|during)\\s+(?:the\\s+first\\s+)?${NUM_TOKEN}[- ]?months?\\b[^.\\n]{0,100}?\\b(?:repay|reimburs\\w*|refund)`, 'i').exec(t);
      if (m) {
        const n = wordOrInt(m[1]);
        if (n !== null) out.push(candidate('cash.signingRepaymentMonths', String(n), line, m.index, m[0].length));
      }
    }
  }
  void lower;
  return { out, notes };
}

function newAssertion(c, docSha, idx, state, origin, extra = {}) {
  return {
    id: `${docSha.slice(0, 12)}:${c.field}:${idx}`,
    field: c.field, value: c.value, units: UNITS_LABEL[c.field] ?? null,
    locator: c.locator, quote: c.quote, documentSha256: docSha, state, origin,
    ...(c.note ? { note: c.note } : {}), ...extra,
  };
}

const AMEND_CUE = /\b(?:hereby\s+)?(?:amend\w*|revis\w*|replac\w*|modif\w*|restat\w*|is changed|are changed|shall be)\b/i;

function dedupeSame(assertions) {
  const seen = new Set();
  return assertions.filter(a => {
    const key = `${a.field}\u0000${a.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Marks every assertion of a field `conflicting` when one document gives it two values.
function markIntraDocumentConflicts(assertions) {
  const byField = new Map();
  for (const a of assertions) {
    if (a.state === 'missing' || a.state === 'not_applicable' || a.state === 'illustrative') continue;
    if (!byField.has(a.field)) byField.set(a.field, []);
    byField.get(a.field).push(a);
  }
  const conflicts = [];
  for (const [field, list] of byField) {
    if (new Set(list.map(a => a.value)).size > 1) {
      conflicts.push(field);
      for (const a of list) a.state = 'conflicting';
    }
  }
  return conflicts;
}

const EXPECTED_BY_CLASS = {
  offer_letter: ['cash.annualBase', 'cash.annualTargetBonus', 'cash.signingBonus', 'serviceStartDate'],
  cover_letter: ['cash.annualBase', 'cash.annualTargetBonus', 'cash.signingBonus', 'serviceStartDate'],
  service_agreement: ['cash.annualBase', 'serviceStartDate'],
};
const GRANT_EXPECTED = [
  'grant.instrument', 'grant.units', 'grant.strikePrice', 'grant.grantDate', 'grant.boardApproval',
  'grant.vesting.commencementDate', 'grant.vesting.totalMonths', 'grant.vesting.cliffMonths', 'grant.vesting.cadence',
  'grant.vesting.acceleration', 'grant.exercise.postTerminationWindowMonths', 'grant.exercise.expirationYears',
  'grant.exercise.earlyExercise', 'grant.quotedOwnershipPct',
];

function missingAssertion(field, docSha, state = 'missing') {
  return {
    id: `${docSha.slice(0, 12)}:${field}:missing`, field, value: null, units: UNITS_LABEL[field] ?? null,
    locator: '', quote: '', documentSha256: docSha, state, origin: 'deterministic',
  };
}

// Reconcile a quoted percentage with a share count. Never back-solves either one.
// Tolerance is the rounding the quoted percentage itself implies: half a unit in its last
// decimal place (e.g. "0.50%" tolerates ±0.005 percentage points).
export function reconcilePercentWithUnits({ units, pct, denominator }) {
  if (!INTEGER.test(units ?? '') || !DECIMAL.test(pct ?? '') || !INTEGER.test(denominator ?? '') || BigInt(denominator) === 0n) {
    return { checked: false };
  }
  const d = decimalPlaces(pct);
  const pctInt = BigInt(pct.replace('.', ''));
  const scale = 10n ** BigInt(d);
  const diff = BigInt(units) * 100n * scale - pctInt * BigInt(denominator);
  const abs = diff < 0n ? -diff : diff;
  const within = abs * 2n <= BigInt(denominator);
  const impliedMicro = (BigInt(units) * 100n * 1_000_000n) / BigInt(denominator);
  const implied = `${impliedMicro / 1_000_000n}.${String(impliedMicro % 1_000_000n).padStart(6, '0')}`;
  const tolerance = `0.${'0'.repeat(d)}5`.replace('0.5', '0.5');
  return { checked: true, withinTolerance: within, impliedPct: implied, quotedPct: pct, tolerancePct: d === 0 ? '0.5' : tolerance, rule: 'half_unit_in_last_quoted_decimal' };
}

// ---------------------------------------------------------------------------
// Term-review rules → findings
// ---------------------------------------------------------------------------

const RULES = [
  {
    id: 'exercise_window_short', category: 'exercise_window', test: /\bpost[- ]termination\b[^.\n]{0,50}\bexercis|\b(?:exercise|exercisable)\b[^.\n]{0,80}\b(?:following|after)\b[^.\n]{0,40}\b(?:termination|separation|cessation|last day)\b|\b(?:following|after)\s+(?:the\s+)?(?:your\s+)?(?:date\s+of\s+)?(?:termination|separation)\b[^.\n]{0,80}\bexercis/i,
    wording: 'material_term', severity: 'high', confidence: 'high',
    reason: 'The document sets a window for exercising vested options after service ends.',
    economicConsequence: 'Vested options that are not exercised inside the window lapse, so keeping them can require paying the full exercise cost, and possibly tax, within that window.',
    question: 'How long is the window in months, can it be extended, and is any cashless or net exercise available?',
  },
  {
    id: 'cliff', category: 'vesting_service', test: /\bcliff\b|\bno (?:portion|part|shares?) (?:of the (?:option|award|grant) )?(?:will |shall )?vest(?:s|ed)? (?:until|before|prior to)\b/i,
    wording: 'material_term', severity: 'medium', confidence: 'high',
    reason: 'Vesting begins only after a cliff, so nothing vests before that date.',
    economicConsequence: 'Leaving before the cliff forfeits the whole grant; leaving just after it vests a single catch-up block.',
    question: 'Which date does the cliff run from, and what service counts toward it?',
  },
  {
    id: 'forfeit_unvested', category: 'vesting_service', test: /\b(?:unvested|unearned)\b[^.\n]{0,80}\b(?:forfeit\w*|terminat\w*|cancel\w*|lapse\w*)\b|\b(?:forfeit\w*|terminat\w*|cancel\w*)\b[^.\n]{0,60}\b(?:unvested|unearned)\b/i,
    wording: 'requires_review', severity: 'medium', confidence: 'medium',
    reason: 'Unvested awards are forfeited or cancelled when service ends.',
    economicConsequence: 'Only units vested on the last day of service can be kept; the service-end date therefore drives how much equity is earned.',
    question: 'How is the last day of service defined, and are there any acceleration or notice-period provisions?',
  },
  {
    id: 'repurchase_vested', category: 'repurchase_forfeiture', test: /\b(?:repurchase|re-?purchase|call right|buy[- ]?back|right to (?:purchase|acquire) (?:back )?)\b[^.\n]{0,120}\b(?:vested|exercised|shares? acquired)\b|\b(?:vested|exercised)\b[^.\n]{0,80}\b(?:repurchase|call right|buy[- ]?back)\b/i,
    wording: 'requires_review', severity: 'high', confidence: 'medium',
    reason: 'The company may repurchase vested or exercised shares in stated circumstances.',
    economicConsequence: 'Vested equity may be bought back at a price set by the document (which could be below value), so vesting alone may not secure the economics.',
    question: 'In which circumstances can vested shares be repurchased, and at what price?',
  },
  {
    id: 'repurchase_general', category: 'repurchase_forfeiture', test: /\b(?:repurchase|call right|buy[- ]?back|forfeiture|clawback|claw back)\b/i,
    wording: 'requires_review', severity: 'medium', confidence: 'medium',
    reason: 'The document contains repurchase, forfeiture or clawback language.',
    economicConsequence: 'The terms may reduce or reverse equity value after it has been earned.',
    question: 'Which events trigger the repurchase, forfeiture or clawback, and does it reach vested equity?',
    skipIf: /\b(?:vested|exercised)\b/i,
  },
  {
    id: 'transfer_restriction', category: 'transfer_liquidity', test: /\b(?:may not|shall not|cannot|no)\s+(?:be\s+)?(?:transfer\w*|sold|sell|assign\w*|pledg\w*)\b|\bright of first refusal\b|\bROFR\b|\block-?up\b|\bmarket stand-?off\b|\bdrag-?along\b|\btransfer restrictions?\b|\bsubject to (?:restrictions on )?transfer\b/i,
    wording: 'material_term', severity: 'medium', confidence: 'high',
    reason: 'The document restricts when or how shares can be transferred or sold.',
    economicConsequence: 'Value cannot be realized except through a liquidity event or permitted transfer, which delays or prevents cash proceeds.',
    question: 'What approvals, lock-ups or rights of first refusal apply, and is any secondary sale ever permitted?',
  },
  {
    id: 'ip_assignment', category: 'ip_obligations', test: /\b(?:hereby\s+)?assigns?\b[^.\n]{0,100}\b(?:inventions?|intellectual property|work product|works of authorship)\b|\b(?:inventions?|work product)\b[^.\n]{0,60}\b(?:belong to|are the property of|shall be owned by)\b/i,
    wording: 'material_term', severity: 'high', confidence: 'high',
    reason: 'The document assigns inventions or work product to the company.',
    economicConsequence: 'Work created by the person, possibly including outside or prior projects unless carved out, becomes company property.',
    question: 'Are prior inventions and outside projects excluded, and does the assignment reach work done outside company time?',
  },
  {
    id: 'ip_agreement_referenced', category: 'ip_obligations', test: /\binvention assignment\b|\bCIIA\b|\bPIIA\b/,
    wording: 'requires_review', severity: 'medium', confidence: 'medium',
    reason: 'The offer depends on an invention assignment agreement that is not part of this document.',
    economicConsequence: 'The scope of the assignment (including outside and prior projects) is set by that separate agreement, so it must be read before accepting.',
    question: 'Can you review the invention assignment agreement now, and does it exclude prior inventions and outside projects?',
  },
  {
    id: 'outside_work', category: 'ip_obligations', test: /\b(?:outside (?:activities|work|business)|moonlight\w*|non-?compet\w*|non-?solicit\w*|conflicts? of interest|exclusive (?:services|employment))\b/i,
    wording: 'requires_review', severity: 'medium', confidence: 'medium',
    reason: 'The document limits outside work or competing activity.',
    economicConsequence: 'Restrictions can limit other income or future roles while the award is being earned and afterward.',
    question: 'What outside activity is allowed, for how long do restrictions last, and how are they enforced in the applicable jurisdiction (a question for qualified counsel)?',
  },
  {
    id: 'repayment_arbitration', category: 'ip_obligations', test: /\b(?:repay|reimburse|refund)\w*\b[^.\n]{0,100}\b(?:bonus|relocation|training|tuition)\b|\bbinding arbitration\b|\bmandatory arbitration\b|\barbitration\b/i,
    wording: 'requires_review', severity: 'medium', confidence: 'medium',
    reason: 'The document contains a repayment obligation or an arbitration clause.',
    economicConsequence: 'A repayment obligation can turn part of the stated pay into a liability if service ends early; arbitration changes how disputes are resolved.',
    question: 'What repayment period applies and on what terms, and what dispute process is required (a question for qualified counsel)?',
  },
  {
    id: 'board_approval_contingent', category: 'ownership_basis', test: /\bsubject to\b[^.\n]{0,40}\b(?:approval|ratification)\b[^.\n]{0,25}\b(?:board|directors)\b|\b(?:pending|contingent (?:up)?on|conditioned (?:up)?on)\b[^.\n]{0,25}\bboard\b|\bboard approval\b[^.\n]{0,25}\b(?:required|pending)\b/i,
    wording: 'unclear', severity: 'high', confidence: 'high',
    reason: 'The grant depends on board approval that the document does not show as given.',
    economicConsequence: 'Until approved, there is no grant: the strike price and grant date are not fixed and the award may not be made on these terms.',
    question: 'When is board approval expected, and will the strike price be the fair market value on the approval date?',
  },
  {
    id: 'preferred_common_confusion', category: 'ownership_basis', test: /\bpreferred\b[^.\n]{0,60}\b(?:price|valuation|value)\b[^.\n]{0,80}\b(?:option|grant|award|strike|exercise|share)|\b(?:option|grant|award|strike|exercise)\b[^.\n]{0,80}\bpreferred\b[^.\n]{0,40}\b(?:price|valuation|value)/i,
    wording: 'unclear', severity: 'medium', confidence: 'low',
    reason: 'The text mentions a preferred-stock price or valuation near the grant terms.',
    economicConsequence: 'Options are normally over common stock; a preferred price can overstate what common shares are worth and what the grant could pay.',
    question: 'Is the quoted price or valuation for common stock or preferred stock?',
  },
  {
    id: 'early_exercise', category: 'exercise_window', test: /\bearly[- ]exercis\w*\b/i,
    wording: 'material_term', severity: 'low', confidence: 'medium',
    reason: 'The document addresses early exercise.',
    economicConsequence: 'Early exercise requires paying the exercise cost before vesting and brings tax and forfeiture-of-unvested-shares considerations.',
    question: 'Is early exercise permitted, what happens to unvested shares on departure, and what does it cost?',
  },
];

function stableId(parts) {
  return `f-${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 14)}`;
}

const UNBASED_CLAIMS = /\b(?:unusual(?:ly)?|atypical|abnormal|off-?market|non-?standard|uncommon|market[- ]standard|typical|customary|industry[- ]standard|standard)\b/i;

// "Unusual" and similar comparative words need a cited, dated, relevant baseline.
export function findingWordingProblem(finding) {
  const text = [finding.reason, finding.economicConsequence, finding.question].join(' ');
  if (!UNBASED_CLAIMS.test(text)) return null;
  const b = finding.baseline;
  if (b && typeof b.source === 'string' && b.source.trim() && isRealIsoDate(b.asOfDate) && typeof b.relevance === 'string' && b.relevance.trim()) return null;
  return 'comparative_wording_without_baseline';
}

export function reviewTerms({ lines, docClass, documentSha256, documentId }) {
  const findings = [];
  const seen = new Set();
  if (NO_PERSONAL_TERMS.has(docClass)) return findings;
  const confidenceCap = docClass === 'cover_letter' ? 'low' : null;
  for (const line of lines) {
    if (!line.text.trim()) continue;
    for (const rule of RULES) {
      const hit = rule.test.exec(line.text);
      if (!hit) continue;
      if (rule.skipIf && rule.skipIf.test(line.text)) continue;
      const key = `${rule.id}:${line.n}`;
      if (seen.has(key)) continue;
      // One finding per rule per document keeps the review proportionate; extra hits stay in the text.
      if (findings.some(f => f.ruleId === rule.id)) continue;
      seen.add(key);
      const evidence = evidenceAt(line, hit.index, hit[0].length);
      findings.push({
        id: stableId([documentSha256, rule.id, evidence.locator]), ruleId: rule.id, origin: 'rule',
        category: rule.category, severity: rule.severity, confidence: confidenceCap || rule.confidence, wording: rule.wording,
        evidenceRef: { ...(documentId == null ? {} : { documentId: String(documentId) }), documentSha256, locator: evidence.locator, quote: evidence.quote },
        reason: rule.reason, economicConsequence: rule.economicConsequence, question: rule.question, resolution: null,
      });
    }
  }
  return findings;
}

function absenceFinding({ ruleId, category, severity, reason, economicConsequence, question, documentSha256, documentId }) {
  const evidence = wholeDocumentEvidence();
  return {
    id: stableId([documentSha256, ruleId, 'absent']), ruleId, origin: 'rule', category, severity, confidence: 'medium', wording: 'unclear',
    evidenceRef: { ...(documentId == null ? {} : { documentId: String(documentId) }), documentSha256, locator: evidence.locator, quote: evidence.quote },
    reason, economicConsequence, question, resolution: null,
  };
}

// ---------------------------------------------------------------------------
// Public: deterministic review of one document's text
// ---------------------------------------------------------------------------

export function failedProposal({ documentSha256, documentId = null, code, message, docClass = 'other' }) {
  return {
    extractionVersion: EXTRACTION_VERSION, documentSha256, ...(documentId == null ? {} : { documentId: String(documentId) }),
    docClass, docClassConfidence: 'low', classificationSignals: [],
    failure: { code, message },
    aiReview: { ran: false, reason: 'document_unreadable', message: 'AI review was not run: the document text could not be read.' },
    assertions: [], excluded: [], abstentions: [], checklist: [], findings: [], injectionFindings: [],
    reconciliation: null, modelDisagreements: [], rejectedModelItems: [], notes: [],
  };
}

export function reviewOfferDocumentText({ text, documentSha256, documentId = null, extractionFailure = null }) {
  if (!SHA256.test(documentSha256 || '')) throw new TypeError('documentSha256 must be a SHA-256 hex digest');
  if (extractionFailure) return failedProposal({ documentSha256, documentId, ...extractionFailure });
  const normalized = normalizeDocumentText(text);
  const quality = assessTextQuality(normalized);
  if (!quality.ok) return failedProposal({ documentSha256, documentId, code: quality.code, message: quality.message });

  const allLines = splitLines(normalized);
  const injections = detectInjections(normalized, allLines);
  const masked = maskLines(normalized, injections);
  const lines = splitLines(masked);
  const classification = classifyOfferDocument(masked);
  const docClass = classification.docClass;
  const noPersonal = NO_PERSONAL_TERMS.has(docClass);

  const assertions = [];
  const excluded = [];
  const notes = new Set();
  let counter = 0;
  for (const line of lines) {
    const { out, notes: lineNotes } = extractFromLine(line, docClass);
    for (const n of lineNotes) notes.add(n);
    const illustrative = ILLUSTRATIVE.test(line.text);
    for (const c of out) {
      counter += 1;
      if (noPersonal || illustrative) {
        excluded.push({
          ...newAssertion(c, documentSha256, counter, 'illustrative', 'deterministic'),
          excludedReason: noPersonal ? (docClass === 'education' ? 'education_material' : 'general_program_description') : 'illustrative_example',
        });
      } else {
        const amends = docClass === 'amendment' && AMEND_CUE.test(line.text);
        assertions.push(newAssertion(c, documentSha256, counter, 'supported_by_document', 'deterministic', amends ? { amends: true } : {}));
      }
    }
  }

  const deduped = dedupeSame(assertions);
  const conflicts = markIntraDocumentConflicts(deduped);

  const abstentions = [];
  const instruments = [...new Set(deduped.filter(a => a.field === 'grant.instrument' && a.state !== 'illustrative').map(a => a.value))];
  const unsupported = instruments.filter(v => !MODELED_INSTRUMENTS.has(v));
  if (instruments.length && unsupported.length === instruments.length) {
    for (const instrument of unsupported) {
      abstentions.push({
        code: 'economic_modeling_abstained', instrument,
        message: `This document describes a ${instrument === 'rsu' ? 'restricted stock unit (RSU)' : instrument.replace(/_/g, ' ')} grant. Radar does not model the economics of this instrument, so no exercise-cost, per-share-proceeds or break-even estimate is produced from it.`,
      });
    }
  }
  const unitsOnlyRsu = abstentions.length > 0;
  if (unitsOnlyRsu) {
    // No strike applies to units/stock awards; do not let a stray "exercise price" line stand.
    for (let i = deduped.length - 1; i >= 0; i -= 1) if (deduped[i].field === 'grant.strikePrice') deduped.splice(i, 1);
  }
  if (notes.has('ambiguous_numeric_date')) abstentions.push({ code: 'ambiguous_date_skipped', message: 'One or more numeric dates (such as 03/04/2026) are ambiguous between day-first and month-first and were not extracted. Enter them manually.' });
  if (notes.has('bonus_percentage_not_converted')) abstentions.push({ code: 'bonus_percentage_not_converted', message: 'The target bonus is stated as a percentage of base pay. Radar does not convert it; enter the dollar amount.' });
  if (notes.has('cash_not_annual')) abstentions.push({ code: 'cash_not_annual', message: 'A pay amount is stated per month, week or hour. Radar does not annualize it; enter the annual amount.' });
  if (notes.has('exercise_window_days_not_month_multiple')) abstentions.push({ code: 'exercise_window_unit_unconverted', message: 'The exercise window is stated in days that are not a whole number of months. Enter the window manually.' });

  // Percentage vs quantity.
  const byField = f => deduped.filter(a => a.field === f && a.state !== 'illustrative');
  const unitsA = byField('grant.units');
  const pctA = byField('grant.quotedOwnershipPct');
  let reconciliation = null;
  const findings = [];
  const rawIdArgs = { documentSha256, documentId };
  if (pctA.length && !unitsA.length && !noPersonal && !NO_GRANT_TERMS.has(docClass)) {
    abstentions.push({
      code: 'percent_without_quantity', message: 'The document states an ownership percentage but no share quantity. The quantity is left missing and is not back-solved from the percentage.',
    });
    findings.push({
      id: stableId([documentSha256, 'percent_no_quantity', pctA[0].locator]), ruleId: 'percent_no_quantity', origin: 'rule',
      category: 'ownership_basis', severity: 'high', confidence: 'high', wording: 'unclear',
      evidenceRef: { ...(documentId == null ? {} : { documentId: String(documentId) }), documentSha256, locator: pctA[0].locator, quote: pctA[0].quote },
      reason: 'The grant is stated as a percentage with no share quantity or strike price.',
      economicConsequence: 'Exercise cost and per-share value cannot be computed from a percentage alone, and a rounded percentage cannot be turned into an exact share count.',
      question: 'What is the exact share quantity, the strike price, and the share denominator and date the percentage is measured against?',
      resolution: null,
    });
  }
  if (unitsA.length === 1 && pctA.length === 1 && unitsA[0].state !== 'conflicting' && pctA[0].state !== 'conflicting') {
    const basisA = byField('grant.ownershipDenominator.basis')[0]?.value;
    const denom = basisA === 'fully_diluted' ? byField('capitalization.fullyDilutedShares')[0] : basisA === 'outstanding' ? byField('capitalization.outstandingShares')[0] : null;
    if (denom && denom.state !== 'conflicting') {
      const r = reconcilePercentWithUnits({ units: unitsA[0].value, pct: pctA[0].value, denominator: denom.value });
      reconciliation = { ...r, basis: basisA };
      if (r.checked && !r.withinTolerance) {
        unitsA[0].state = 'conflicting'; pctA[0].state = 'conflicting';
        findings.push({
          id: stableId([documentSha256, 'percent_quantity_mismatch', pctA[0].locator]), ruleId: 'percent_quantity_mismatch', origin: 'rule',
          category: 'ownership_basis', severity: 'high', confidence: 'high', wording: 'unclear',
          evidenceRef: { ...(documentId == null ? {} : { documentId: String(documentId) }), documentSha256, locator: pctA[0].locator, quote: pctA[0].quote },
          reason: 'The stated share count and ownership percentage do not agree within the percentage’s own rounding.',
          economicConsequence: 'Either the quantity, the percentage or the share denominator is wrong or measured on a different date; the economics depend on which one controls.',
          question: 'Which figure is correct, and what share denominator and date was the percentage computed on?',
          resolution: null,
        });
      }
    }
  }

  // Missing placeholders for expected, unstated fields.
  const present = new Set(deduped.filter(a => a.state !== 'illustrative').map(a => a.field));
  const expected = [...(EXPECTED_BY_CLASS[docClass] || [])];
  if (['offer_letter', 'cover_letter', 'grant_notice', 'service_agreement', 'amendment'].includes(docClass) || (docClass === 'other' && present.size)) {
    if (docClass !== 'service_agreement' || deduped.some(a => a.field.startsWith('grant.'))) expected.push(...GRANT_EXPECTED);
  }
  for (const field of expected) {
    if (present.has(field)) continue;
    if (field === 'grant.strikePrice' && unitsOnlyRsu) { deduped.push(missingAssertion(field, documentSha256, 'not_applicable')); continue; }
    if (docClass === 'amendment') continue; // an amendment states only what it changes
    deduped.push(missingAssertion(field, documentSha256));
  }

  // Findings: rules + absence + safety.
  findings.push(...reviewTerms({ lines, docClass, ...rawIdArgs }));
  const optionDoc = instruments.some(v => MODELED_INSTRUMENTS.has(v)) || (!instruments.length && unitsA.length && /\boptions?\b/i.test(masked));
  if (['grant_notice', 'offer_letter', 'equity_plan'].includes(docClass) && optionDoc && !present.has('grant.exercise.postTerminationWindowMonths')
    && !findings.some(f => f.ruleId === 'exercise_window_short')) {
    findings.push(absenceFinding({
      ruleId: 'exercise_window_absent', category: 'exercise_window', severity: 'high',
      reason: 'No post-termination exercise window is stated in this document.',
      economicConsequence: 'Without a stated window the time allowed to exercise vested options after leaving is unknown, which affects whether vested options can be kept.',
      question: 'What is the post-termination exercise window, and where is it set (grant notice, equity plan or agreement)?',
      ...rawIdArgs,
    }));
  }
  for (const f of findings) {
    const problem = findingWordingProblem(f);
    if (problem) throw new Error(`internal rule produced ${problem}: ${f.ruleId}`);
  }

  const refs = detectReferences(masked, lines);
  const checklist = buildChecklist(refs, selfKeys(docClass, masked));

  const injectionFindings = injections.map(i => ({
    kind: 'prompt_injection', action: 'ignored', locator: i.locator, quote: i.quote,
    message: 'The document contains text that tries to instruct an automated reader. It was ignored and not used for any extracted value.',
  }));

  const proposal = {
    extractionVersion: EXTRACTION_VERSION, documentSha256, ...(documentId == null ? {} : { documentId: String(documentId) }),
    docClass, docClassConfidence: classification.confidence, classificationSignals: classification.signals,
    ...(docClass === 'cover_letter' ? { authority: 'not_a_signed_offer' } : {}),
    ...(docClass === 'education' || docClass === 'benefits_overview' ? { authority: 'no_personal_terms' } : {}),
    failure: null,
    aiReview: { ran: false, reason: 'deterministic_only', message: 'AI review was not run; this proposal comes from deterministic parsing only.' },
    assertions: deduped, excluded, abstentions, checklist, findings, injectionFindings,
    reconciliation, intraDocumentConflicts: conflicts, modelDisagreements: [], rejectedModelItems: [], notes: [...notes],
    textStats: { chars: normalized.length, lines: allLines.length },
  };
  if (docClass === 'amendment') proposal.amendment = parseAmendmentIdentity(masked, lines);
  proposal.identifiers = documentIdentifiers(masked, lines);
  return proposal;
}

// ---------------------------------------------------------------------------
// Amendment identity and cross-document reconciliation
// ---------------------------------------------------------------------------

function documentIdentifiers(text, lines) {
  const refs = new Set();
  for (const line of lines) {
    for (const m of line.text.matchAll(/\b(?:grant|award|agreement|option)\s+(?:no\b\.?|number\b|id\b|#)\s*:?\s*([A-Z0-9][A-Z0-9-]{2,29})\b/gi)) refs.add(m[1].toUpperCase());
  }
  void text;
  return [...refs].slice(0, 10);
}

const TARGET_CLASS_RULES = [
  ['grant_notice', /\b(?:stock )?(?:option )?grant notice\b|\bnotice of (?:stock )?(?:option )?grant\b|\bstock option agreement\b/i],
  ['offer_letter', /\boffer letter\b/i],
  ['equity_plan', /\b(?:equity|stock) (?:incentive|option|compensation) plan\b/i],
  ['service_agreement', /\b(?:consulting|advisor(?:y)?|services|employment) agreement\b/i],
];

function parseAmendmentIdentity(text, lines) {
  const out = { targetClass: null, targetDate: null, targetRefs: documentIdentifiers(text, lines) };
  for (const line of lines) {
    const head = /\bamendment\b.{0,40}?\bto\b(.{0,160})/i.exec(line.text);
    if (head) {
      for (const [cls, re] of TARGET_CLASS_RULES) if (re.test(head[1])) { out.targetClass = cls; break; }
      const { dates } = parseDates(head[1]);
      if (dates[0]) out.targetDate = dates[0].iso;
    }
    if (!out.targetDate) {
      const m = /\b(?:dated|originally (?:granted|dated|issued|entered)|original grant date|made as of)\b(.{0,40})/i.exec(line.text);
      if (m) { const { dates } = parseDates(m[1]); if (dates[0]) out.targetDate = dates[0].iso; }
    }
    if (out.targetClass && out.targetDate) break;
  }
  return out;
}

function evidenceOf(a) {
  return { documentSha256: a.documentSha256, locator: a.locator, quote: a.quote, assertionId: a.id };
}

// Merge proposals from several documents. Contradictions are preserved; recency is never used.
// An amendment supersedes another document's value only when it explicitly amends that field
// AND names the target document's class and identity (shared grant/agreement number or the
// target's own grant date).
export function reconcileProposals(proposals) {
  const usable = proposals.filter(p => p && !p.failure);
  const checklist = [];
  const providedKeys = new Set();
  for (const p of usable) {
    if (DOC_KEYS_BY_CLASS[p.docClass]) providedKeys.add(DOC_KEYS_BY_CLASS[p.docClass]);
    for (const item of p.checklist || []) if (item.status === 'provided') providedKeys.add(item.key);
  }
  const seen = new Set();
  for (const p of usable) {
    for (const item of p.checklist || []) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      checklist.push({ ...item, status: providedKeys.has(item.key) ? 'provided' : 'missing' });
    }
  }

  const candidates = new Map();
  for (const p of usable) {
    for (const a of p.assertions || []) {
      if (['missing', 'not_applicable', 'illustrative'].includes(a.state)) continue;
      if (!candidates.has(a.field)) candidates.set(a.field, []);
      candidates.get(a.field).push({ a, p });
    }
  }

  const identityMatches = (amendP, targetP) => {
    const id = amendP.amendment;
    if (!id || !id.targetClass || id.targetClass !== targetP.docClass) return false;
    const refMatch = id.targetRefs?.length && (targetP.identifiers || []).some(r => id.targetRefs.includes(r));
    const grantDates = (targetP.assertions || []).filter(x => x.field === 'grant.grantDate' && x.state !== 'illustrative').map(x => x.value);
    const dateMatch = id.targetDate && grantDates.includes(id.targetDate);
    return Boolean(refMatch || dateMatch);
  };

  const fields = {};
  const conflicts = [];
  for (const [field, list] of candidates) {
    const distinct = new Set(list.map(({ a }) => a.value));
    const shape = ({ a, p }, state, extra = {}) => ({ ...evidenceOf(a), value: a.value, state, docClass: p.docClass, origin: a.origin, ...extra });
    // A document that contradicts itself stays conflicting even if another document repeats one side.
    if (distinct.size === 1 && !list.some(({ a }) => a.state === 'conflicting')) {
      fields[field] = { status: list.length > 1 ? 'agreed' : 'single', value: [...distinct][0], candidates: list.map(x => shape(x, 'supported_by_document')) };
      continue;
    }
    const superseded = new Map();
    for (const amend of list.filter(({ a, p }) => p.docClass === 'amendment' && a.amends && a.state !== 'conflicting')) {
      for (const other of list) {
        if (other === amend || other.p === amend.p || other.a.value === amend.a.value) continue;
        if (identityMatches(amend.p, other.p)) superseded.set(other, amend);
      }
    }
    const remaining = list.filter(x => !superseded.has(x));
    const remainingValues = new Set(remaining.map(({ a }) => a.value));
    if (superseded.size && remainingValues.size === 1 && !remaining.some(({ a }) => a.state === 'conflicting')) {
      fields[field] = {
        status: 'resolved_by_amendment', value: [...remainingValues][0],
        candidates: list.map(x => shape(x, 'supported_by_document', superseded.has(x) ? { supersededBy: superseded.get(x).a.id } : {})),
      };
    } else {
      fields[field] = { status: 'conflicting', value: null, candidates: list.map(x => shape(x, 'conflicting')) };
      conflicts.push(field);
    }
  }
  return { fields, conflicts, checklist };
}

// ---------------------------------------------------------------------------
// Proposal schema + validation
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const evidenceRefSchema = {
  type: 'object', additionalProperties: false, required: ['documentSha256', 'locator', 'quote'],
  properties: {
    documentId: { type: 'string', minLength: 1, maxLength: 128 },
    documentSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    locator: { type: 'string', minLength: 1, maxLength: MAX_LOCATOR_CHARS },
    quote: { type: 'string', maxLength: MAX_QUOTE_CHARS },
  },
};
const assertionSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'field', 'value', 'units', 'locator', 'quote', 'documentSha256', 'state', 'origin'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 160 },
    field: { type: 'string', enum: [...FIELDS] },
    value: { type: ['string', 'null'], maxLength: 64 },
    units: { type: ['string', 'null'], maxLength: 32 },
    locator: { type: 'string', maxLength: MAX_LOCATOR_CHARS },
    quote: { type: 'string', maxLength: MAX_QUOTE_CHARS },
    documentSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    state: { type: 'string', enum: [...VALUE_STATES] },
    origin: { type: 'string', enum: ['deterministic', 'model'] },
    note: { type: 'string', maxLength: 300 },
    amends: { type: 'boolean' },
    excludedReason: { type: 'string', maxLength: 64 },
  },
};
const findingSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'origin', 'category', 'severity', 'confidence', 'wording', 'evidenceRef', 'reason', 'economicConsequence', 'question', 'resolution'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 64 },
    ruleId: { type: 'string', maxLength: 64 },
    origin: { type: 'string', enum: ['rule', 'model'] },
    category: { type: 'string', enum: [...FINDING_CATEGORIES] },
    severity: { type: 'string', enum: [...SEVERITIES] },
    confidence: { type: 'string', enum: [...CONFIDENCES] },
    wording: { type: 'string', enum: [...FINDING_WORDINGS] },
    evidenceRef: evidenceRefSchema,
    reason: { type: 'string', minLength: 1, maxLength: 600 },
    economicConsequence: { type: 'string', minLength: 1, maxLength: 600 },
    question: { type: 'string', minLength: 1, maxLength: 600 },
    resolution: { type: 'null' },
    baseline: {
      type: 'object', additionalProperties: false, required: ['source', 'asOfDate', 'relevance'],
      properties: { source: { type: 'string', maxLength: 300 }, asOfDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, relevance: { type: 'string', maxLength: 300 } },
    },
  },
};
const proposalSchema = {
  type: 'object', additionalProperties: false,
  required: ['extractionVersion', 'documentSha256', 'docClass', 'failure', 'aiReview', 'assertions', 'excluded', 'abstentions', 'checklist', 'findings', 'injectionFindings'],
  properties: {
    extractionVersion: { type: 'string', maxLength: 64 },
    documentSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    documentId: { type: 'string', maxLength: 128 },
    docClass: { type: 'string', enum: [...DOC_CLASSES] },
    docClassConfidence: { type: 'string', enum: [...CONFIDENCES] },
    classificationSignals: { type: 'array', maxItems: 40, items: { type: 'string', maxLength: 80 } },
    authority: { type: 'string', enum: ['not_a_signed_offer', 'no_personal_terms'] },
    failure: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['code', 'message'], properties: { code: { type: 'string', maxLength: 64 }, message: { type: 'string', maxLength: 400 } } }] },
    aiReview: {
      type: 'object', additionalProperties: true, required: ['ran', 'reason', 'message'],
      properties: { ran: { type: 'boolean' }, reason: { type: 'string', maxLength: 64 }, message: { type: 'string', maxLength: 400 } },
    },
    assertions: { type: 'array', maxItems: 300, items: assertionSchema },
    excluded: { type: 'array', maxItems: 300, items: assertionSchema },
    abstentions: { type: 'array', maxItems: 40, items: { type: 'object', additionalProperties: true, required: ['code', 'message'], properties: { code: { type: 'string', maxLength: 64 }, message: { type: 'string', maxLength: 600 } } } },
    checklist: {
      type: 'array', maxItems: 40,
      items: {
        type: 'object', additionalProperties: false, required: ['key', 'label', 'expectedClass', 'status', 'locator', 'quote'],
        properties: {
          key: { type: 'string', maxLength: 64 }, label: { type: 'string', maxLength: 200 },
          expectedClass: { type: ['string', 'null'], maxLength: 64 }, status: { type: 'string', enum: ['missing', 'provided'] },
          locator: { type: 'string', maxLength: MAX_LOCATOR_CHARS }, quote: { type: 'string', maxLength: MAX_QUOTE_CHARS },
        },
      },
    },
    findings: { type: 'array', maxItems: 100, items: findingSchema },
    injectionFindings: {
      type: 'array', maxItems: 100,
      items: {
        type: 'object', additionalProperties: false, required: ['kind', 'action', 'locator', 'quote', 'message'],
        properties: {
          kind: { const: 'prompt_injection' }, action: { const: 'ignored' }, locator: { type: 'string', maxLength: MAX_LOCATOR_CHARS },
          quote: { type: 'string', maxLength: MAX_QUOTE_CHARS }, message: { type: 'string', maxLength: 400 },
          source: { type: 'string', maxLength: 64 },
        },
      },
    },
    reconciliation: { type: ['object', 'null'], additionalProperties: true },
    intraDocumentConflicts: { type: 'array', maxItems: 40, items: { type: 'string', maxLength: 80 } },
    modelDisagreements: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: true } },
    rejectedModelItems: { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: true } },
    notes: { type: 'array', maxItems: 40, items: { type: 'string', maxLength: 80 } },
    textStats: { type: 'object', additionalProperties: true },
    amendment: { type: 'object', additionalProperties: true },
    identifiers: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } },
  },
};
const validateProposalSchema = ajv.compile(proposalSchema);

export class OfferDocumentError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'OfferDocumentError';
    this.code = code;
    this.details = details;
  }
}

// Errors name schema paths and field names only, never values or quotes.
export function validateProposal(proposal) {
  if (!validateProposalSchema(proposal)) {
    const paths = [...new Set(validateProposalSchema.errors.map(error => `${error.instancePath || '/'} ${error.message}`))].slice(0, 8);
    throw new OfferDocumentError('invalid_proposal', `Invalid document proposal: ${paths.join('; ')}`, { paths });
  }
  for (const a of [...proposal.assertions, ...proposal.excluded]) {
    if (a.state === 'missing' || a.state === 'not_applicable') {
      if (a.value !== null) throw new OfferDocumentError('invalid_proposal', `Assertion for ${a.field} must have a null value when state is ${a.state}.`);
      continue;
    }
    if (a.state === 'illustrative' && a.value === null) continue;
    const problem = fieldValueProblem(a.field, a.value);
    if (problem || a.value === null) throw new OfferDocumentError('invalid_proposal', `Assertion for ${a.field} failed validation: ${problem || 'value_required'}.`);
  }
  for (const f of proposal.findings) {
    if (!f.evidenceRef.locator) throw new OfferDocumentError('invalid_proposal', 'Every finding needs an evidence locator.');
    const problem = findingWordingProblem(f);
    if (problem) throw new OfferDocumentError('invalid_proposal', `Finding ${f.category} uses comparative wording without a cited baseline.`);
  }
  if (proposal.failure && (proposal.assertions.length || proposal.findings.length)) {
    throw new OfferDocumentError('invalid_proposal', 'A failed review cannot carry extracted values.');
  }
  return proposal;
}

// ---------------------------------------------------------------------------
// Merging the (untrusted) model proposal
// ---------------------------------------------------------------------------

// JSON schema the app hands to the provider. Kept simple and flat on purpose.
export const MODEL_OUTPUT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['docClass', 'assertions', 'findings', 'referencedDocuments'],
  properties: {
    docClass: { type: 'string', enum: [...DOC_CLASSES] },
    assertions: {
      type: 'array', maxItems: 80,
      items: {
        type: 'object', additionalProperties: false, required: ['field', 'value', 'quote'],
        properties: {
          field: { type: 'string', enum: [...FIELDS] },
          value: { type: ['string', 'null'], maxLength: 64 },
          quote: { type: 'string', maxLength: MAX_QUOTE_CHARS },
        },
      },
    },
    findings: {
      type: 'array', maxItems: 20,
      items: {
        type: 'object', additionalProperties: false, required: ['category', 'severity', 'confidence', 'quote', 'reason', 'economicConsequence', 'question'],
        properties: {
          category: { type: 'string', enum: [...FINDING_CATEGORIES] },
          severity: { type: 'string', enum: [...SEVERITIES] },
          confidence: { type: 'string', enum: [...CONFIDENCES] },
          quote: { type: 'string', maxLength: MAX_QUOTE_CHARS },
          reason: { type: 'string', maxLength: 600 },
          economicConsequence: { type: 'string', maxLength: 600 },
          question: { type: 'string', maxLength: 600 },
        },
      },
    },
    referencedDocuments: {
      type: 'array', maxItems: 20,
      items: {
        type: 'object', additionalProperties: false, required: ['key', 'quote'],
        properties: { key: { type: 'string', enum: REFERENCE_RULES.map(r => r.key) }, quote: { type: 'string', maxLength: MAX_QUOTE_CHARS } },
      },
    },
  },
});
const validateModelOutputSchema = ajv.compile(MODEL_OUTPUT_SCHEMA);

// Numbers in a quote, as normalized strings, for exact token equality (never substring).
function numberTokens(quote) {
  const out = new Set();
  for (const m of quote.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) {
    out.add(m[0].replace(/,/g, ''));
    if (m[0].includes('.')) out.add(m[0].replace(/,/g, '').replace(/0+$/, '').replace(/\.$/, ''));
  }
  return out;
}

// Does the quote itself carry the claimed value? Enumerated values need keyword evidence.
function quoteSupportsValue(field, value, quote) {
  if (value === null) return false;
  const q = quote.toLowerCase();
  if (UNIT_FIELDS.has(field) || DECIMAL_FIELDS.has(field)) {
    if (field === 'grant.exercise.postTerminationWindowMonths' || field === 'grant.exercise.expirationYears') {
      const { out } = extractFromLine({ n: 1, start: 0, end: quote.length, text: quote }, 'grant_notice');
      return out.some(c => c.field === field && c.value === value);
    }
    const tokens = numberTokens(quote);
    return tokens.has(value) || tokens.has(value.replace(/0+$/, '').replace(/\.$/, ''));
  }
  if (DATE_FIELDS.has(field)) return parseDates(quote).dates.some(d => d.iso === value);
  if (SMALL_INT_FIELDS.has(field)) {
    const { out } = extractFromLine({ n: 1, start: 0, end: quote.length, text: quote }, 'grant_notice');
    if (out.some(c => c.field === field && c.value === value)) return true;
    return numberTokens(quote).has(value);
  }
  switch (field) {
    case 'grant.instrument':
      return ({
        iso: /\b(?:incentive stock option|iso)s?\b/, nso: /\b(?:non[- ]?qualified|non[- ]?statutory|nso|nqso)/, rsu: /\b(?:restricted stock unit|rsu)/,
        restricted_stock: /\brestricted stock\b/, profits_interest: /\bprofits?[- ]interest/, other: /./,
      }[value] || /$^/).test(q);
    case 'grant.boardApproval':
      return value === 'approved'
        ? /\bboard\b/.test(q) && /\b(?:approved|ratified)\b/.test(q) && !/\b(?:subject to|pending|contingent|upon|until|if|unless|require|not (?:yet )?(?:been )?approved|has not)\b/.test(q)
        : /\bboard\b/.test(q) && /\b(?:subject to|pending|contingent|require|not (?:yet )?(?:been )?approved)\b/.test(q);
    case 'grant.vesting.cadence': return new RegExp(value === 'annual' ? 'annual|yearly' : value === 'other' ? '.' : value.replace(/ly$/, ''), 'i').test(q);
    case 'grant.vesting.acceleration': return value === 'none' ? /\bno\b[^.]{0,20}accelerat/.test(q) : value === 'unknown' ? /accelerat/.test(q) : new RegExp(value.replace('_', '[- ]'), 'i').test(q);
    case 'grant.exercise.earlyExercise': return /early[- ]exercis/.test(q);
    case 'grant.ownershipDenominator.basis': return value === 'fully_diluted' ? /fully[- ]diluted/.test(q) : value === 'outstanding' ? /outstanding/.test(q) : false;
    default: return false;
  }
}

export function isModelOutputWellFormed(output) {
  return validateModelOutputSchema(output) === true;
}

// Merges a model proposal into a deterministic one. The model can only ADD verbatim-evidenced
// items; it can never overwrite, upgrade or confirm anything. `text` is the document text.
export function mergeModelOutput({ proposal, modelOutput, text, usage = null }) {
  const merged = structuredClone(proposal);
  const normalized = normalizeDocumentText(text);
  const injections = detectInjections(normalized);
  const rejected = [];
  const reject = (kind, reason, extra = {}) => rejected.push({ kind, reason, ...extra });
  const note = merged.aiReview && typeof merged.aiReview === 'object' ? merged.aiReview : {};

  if (!isModelOutputWellFormed(modelOutput)) {
    merged.aiReview = { ...note, ran: true, reason: 'model_output_invalid', message: 'AI review ran but its output did not match the required format and was discarded; this proposal comes from deterministic parsing only.', ...(usage ? { usage } : {}) };
    return merged;
  }

  const inInjection = loc => injections.some(i => loc.start < i.end && loc.end > i.start);
  const noPersonal = NO_PERSONAL_TERMS.has(merged.docClass);

  if (merged.docClass === 'other' && modelOutput.docClass !== 'other' && !['offer_letter'].includes(modelOutput.docClass)) {
    merged.docClass = modelOutput.docClass;
    merged.classificationSignals = [...(merged.classificationSignals || []), 'model_suggested'];
  } else if (modelOutput.docClass !== merged.docClass) {
    merged.notes = [...new Set([...(merged.notes || []), 'model_class_disagreed'])];
  }

  const existingByField = new Map();
  for (const a of merged.assertions) {
    if (['missing', 'not_applicable'].includes(a.state)) continue;
    if (!existingByField.has(a.field)) existingByField.set(a.field, []);
    existingByField.get(a.field).push(a);
  }
  let counter = merged.assertions.length + merged.excluded.length + 1000;
  for (const item of modelOutput.assertions) {
    const loc = locateQuote(normalized, item.quote);
    if (noPersonal) { reject('assertion', 'document_has_no_personal_terms', { field: item.field }); continue; }
    if (!FIELDS.includes(item.field)) { reject('assertion', 'unknown_field', { field: item.field }); continue; }
    if (item.value === null) { reject('assertion', 'no_value', { field: item.field }); continue; }
    if (!loc) { reject('assertion', 'quote_not_in_document', { field: item.field }); continue; }
    if (inInjection(loc)) { reject('assertion', 'quote_is_embedded_instruction', { field: item.field }); continue; }
    if (ILLUSTRATIVE.test(loc.quote)) { reject('assertion', 'illustrative_context', { field: item.field }); continue; }
    if (NO_GRANT_TERMS.has(merged.docClass) && item.field.startsWith('grant.')) { reject('assertion', 'document_class_has_no_grant_terms', { field: item.field }); continue; }
    const problem = fieldValueProblem(item.field, item.value);
    if (problem) { reject('assertion', problem, { field: item.field }); continue; }
    if (!quoteSupportsValue(item.field, item.value, loc.quote)) { reject('assertion', 'quote_does_not_support_value', { field: item.field }); continue; }
    const existing = existingByField.get(item.field) || [];
    if (existing.some(a => a.value === item.value)) continue;
    counter += 1;
    const assertion = newAssertion({ field: item.field, value: item.value, locator: loc.locator, quote: loc.quote }, merged.documentSha256, counter, 'supported_by_document', 'model');
    if (existing.length) {
      // A real, evidenced second value in the same document: both stay, both conflicting.
      merged.modelDisagreements.push({ field: item.field, deterministicValues: existing.map(a => a.value), modelValue: item.value, locator: loc.locator, resolution: 'conflicting' });
      for (const a of existing) a.state = 'conflicting';
      assertion.state = 'conflicting';
    }
    merged.assertions.push(assertion);
    existingByField.set(item.field, [...existing, assertion]);
  }
  // Placeholders the model filled in are no longer missing.
  merged.assertions = merged.assertions.filter(a => !(a.state === 'missing' && existingByField.has(a.field) && a.origin === 'deterministic'));

  for (const item of modelOutput.findings) {
    const loc = locateQuote(normalized, item.quote);
    if (!loc) { reject('finding', 'quote_not_in_document', { category: item.category }); continue; }
    if (inInjection(loc)) { reject('finding', 'quote_is_embedded_instruction', { category: item.category }); continue; }
    if (noPersonal) { reject('finding', 'document_has_no_personal_terms', { category: item.category }); continue; }
    const finding = {
      id: stableId([merged.documentSha256, 'model', item.category, loc.locator]), origin: 'model', category: item.category,
      severity: item.severity, confidence: item.confidence === 'high' ? 'medium' : item.confidence, wording: 'requires_review',
      evidenceRef: { ...(merged.documentId ? { documentId: merged.documentId } : {}), documentSha256: merged.documentSha256, locator: loc.locator, quote: loc.quote },
      reason: item.reason, economicConsequence: item.economicConsequence, question: item.question, resolution: null,
    };
    if (findingWordingProblem(finding)) { reject('finding', 'comparative_wording_without_baseline', { category: item.category }); continue; }
    if (merged.findings.some(f => f.category === item.category && f.evidenceRef.locator === loc.locator)) continue;
    merged.findings.push(finding);
  }

  const have = new Set(merged.checklist.map(c => c.key));
  for (const item of modelOutput.referencedDocuments) {
    const loc = locateQuote(normalized, item.quote);
    const rule = REFERENCE_RULES.find(r => r.key === item.key);
    if (!loc || !rule || inInjection(loc)) { reject('reference', 'quote_not_in_document', { key: item.key }); continue; }
    if (have.has(item.key)) continue;
    have.add(item.key);
    merged.checklist.push({
      key: rule.key, label: rule.label, expectedClass: rule.expectedClass,
      status: selfKeys(merged.docClass, normalized).has(rule.key) ? 'provided' : 'missing', locator: loc.locator, quote: loc.quote,
    });
  }

  for (const i of injections) {
    const loc = i.locator;
    if (!merged.injectionFindings.some(f => f.locator === loc)) {
      merged.injectionFindings.push({
        kind: 'prompt_injection', action: 'ignored', locator: loc, quote: i.quote, source: 'document',
        message: 'The document contains text that tries to instruct an automated reader. It was ignored and not used for any extracted value.',
      });
    }
  }
  // A model value that was attributable to embedded instructions is itself an injection finding.
  for (const r of rejected) {
    if (r.reason === 'quote_is_embedded_instruction' && !merged.injectionFindings.some(f => f.source === 'model_output')) {
      merged.injectionFindings.push({
        kind: 'prompt_injection', action: 'ignored', locator: 'model output', quote: '', source: 'model_output',
        message: 'The AI review returned a value that came from instruction-like text inside the document. The value was discarded.',
      });
    }
  }
  // Model-claimed values with no evidence that match known injected assertions also trip this.
  if (injections.length && rejected.some(r => ['quote_is_embedded_instruction', 'quote_not_in_document', 'quote_does_not_support_value'].includes(r.reason))
    && !merged.injectionFindings.some(f => f.source === 'model_output')) {
    merged.injectionFindings.push({
      kind: 'prompt_injection', action: 'ignored', locator: 'model output', quote: '', source: 'model_output',
      message: 'The AI review returned values that are not supported by the document while the document contains instruction-like text. Those values were discarded.',
    });
  }

  merged.rejectedModelItems = [...(merged.rejectedModelItems || []), ...rejected].slice(0, 200);
  merged.aiReview = {
    ...note, ran: true, reason: 'ok',
    message: 'AI review ran on this document. Its output is a proposal: every item below needs your confirmation.',
    ...(usage ? { usage } : {}),
  };
  const conflictFields = new Set();
  for (const [field, list] of existingByField) if (list.some(a => a.state === 'conflicting')) conflictFields.add(field);
  merged.intraDocumentConflicts = [...new Set([...(merged.intraDocumentConflicts || []), ...conflictFields])];
  return merged;
}

export function aiNotRunProposal(proposal, reason, message) {
  return { ...proposal, aiReview: { ran: false, reason, message } };
}

// ---------------------------------------------------------------------------
// Converter: confirmed proposal → OfferRevision payload (pure)
// ---------------------------------------------------------------------------

const offerAjv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const validateOfferRevisionShape = offerAjv.compile(SCHEMAS.offerRevision);

const FACT_FIELDS = {
  annualBase: 'cash.annualBase', annualTargetBonus: 'cash.annualTargetBonus', signingBonus: 'cash.signingBonus',
};

// confirmations: [{ field, assertionId }] — the candidate the user accepted for a field.
// edits: { [field]: { value, state? } } — values the user typed or corrected (user_reported
// unless they state otherwise). Anything neither confirmed nor edited is NOT carried as a
// value: it stays missing (candidate sources retained) or conflicting.
export function buildOfferRevisionPayload({
  id, opportunityId, supersedesRevisionId = null, asOfDate, status = 'proposed', note = null,
  reconciliation, confirmations = [], edits = {}, componentId = 'g1',
}) {
  if (!reconciliation || typeof reconciliation !== 'object' || !reconciliation.fields) throw new OfferDocumentError('invalid_input', 'A reconciliation result is required.');
  for (const [field, edit] of Object.entries(edits)) {
    if (!FIELDS.includes(field)) throw new OfferDocumentError('invalid_input', `Unknown edited field: ${field}`);
    const problem = fieldValueProblem(field, edit.value ?? null);
    if (problem) throw new OfferDocumentError('invalid_input', `Edited value for ${field} failed validation: ${problem}`);
    if (edit.state != null && !['user_reported', 'confirmed_by_user', 'not_applicable'].includes(edit.state)) {
      throw new OfferDocumentError('invalid_input', `Edited field ${field} has an invalid state.`);
    }
  }
  const chosen = new Map();
  for (const { field, assertionId } of confirmations) {
    const entry = reconciliation.fields[field];
    const candidate = entry?.candidates.find(c => c.assertionId === assertionId);
    if (!candidate) throw new OfferDocumentError('invalid_input', `Confirmation for ${field} does not match a proposed assertion.`);
    chosen.set(field, candidate);
  }

  const unresolved = [];
  const sourcesOf = field => (reconciliation.fields[field]?.candidates || []).slice(0, 20).map(c => ({
    documentSha256: c.documentSha256, locator: c.locator || 'n/a', quote: c.quote || '', assertionId: c.assertionId,
  }));
  const resolve = field => {
    if (edits[field]) {
      const e = edits[field];
      if (e.value == null || e.state === 'not_applicable') return { value: null, state: e.state === 'not_applicable' ? 'not_applicable' : 'missing', source: 'edit' };
      return { value: e.value, state: e.state || 'user_reported', source: 'edit' };
    }
    if (chosen.has(field)) {
      const c = chosen.get(field);
      return { value: c.value, state: 'confirmed_by_user', source: 'confirmed', sources: [{ documentSha256: c.documentSha256, locator: c.locator || 'n/a', quote: c.quote || '', assertionId: c.assertionId }] };
    }
    const entry = reconciliation.fields[field];
    if (entry?.status === 'conflicting') { unresolved.push({ field, reason: 'conflicting' }); return { value: null, state: 'conflicting', source: 'none', sources: sourcesOf(field) }; }
    if (entry) { unresolved.push({ field, reason: 'not_confirmed' }); return { value: null, state: 'missing', source: 'none', sources: sourcesOf(field), note: 'A value was proposed from a document but has not been confirmed by the user.' }; }
    unresolved.push({ field, reason: 'missing' });
    return { value: null, state: 'missing', source: 'none' };
  };
  const fact = (field, transform = v => v) => {
    const r = resolve(field);
    const out = { value: r.value == null ? null : transform(r.value), state: r.state };
    if (r.sources?.length) out.sources = r.sources;
    if (r.note) out.note = r.note;
    return out;
  };
  const intOf = field => {
    const r = resolve(field);
    return r.state === 'confirmed_by_user' || r.state === 'user_reported' ? Number(r.value) : null;
  };
  const enumOf = field => {
    const r = resolve(field);
    return r.state === 'confirmed_by_user' || r.state === 'user_reported' ? r.value : null;
  };

  const cash = {
    annualBase: fact(FACT_FIELDS.annualBase), annualTargetBonus: fact(FACT_FIELDS.annualTargetBonus), signingBonus: fact(FACT_FIELDS.signingBonus),
  };
  const repay = intOf('cash.signingRepaymentMonths');
  cash.signingRepaymentMonths = repay;

  const grantFields = FIELDS.filter(f => f.startsWith('grant.'));
  const anyGrant = grantFields.some(f => reconciliation.fields[f] || edits[f] || chosen.has(f));
  let grants = [];
  if (anyGrant) {
    const instrument = enumOf('grant.instrument') || 'other';
    const total = intOf('grant.vesting.totalMonths');
    const cliff = intOf('grant.vesting.cliffMonths');
    const cadence = enumOf('grant.vesting.cadence');
    const modelable = total !== null && cliff !== null && cadence && cadence !== 'other' && cadence !== 'performance';
    const accel = enumOf('grant.vesting.acceleration') || 'unknown';
    const basis = enumOf('grant.ownershipDenominator.basis');
    const asOf = enumOf('grant.ownershipDenominator.asOfDate');
    grants = [{
      componentId,
      instrument,
      units: fact('grant.units'),
      quotedOwnershipPct: fact('grant.quotedOwnershipPct'),
      ownershipDenominator: { basis: basis || 'unknown', asOfDate: asOf || null },
      strikePrice: fact('grant.strikePrice'),
      grantDate: fact('grant.grantDate'),
      boardApproval: fact('grant.boardApproval'),
      vesting: {
        commencementDate: fact('grant.vesting.commencementDate'),
        // Without a confirmed total, cliff and cadence the schedule is declared unmodeled
        // ('other'), never defaulted to a made-up schedule.
        totalMonths: modelable ? total : 0,
        cliffMonths: modelable ? cliff : 0,
        cadence: modelable ? cadence : (cadence === 'performance' ? 'performance' : 'other'),
        acceleration: accel,
      },
      exercise: {
        postTerminationWindowMonths: fact('grant.exercise.postTerminationWindowMonths'),
        expirationYears: fact('grant.exercise.expirationYears'),
        earlyExercise: fact('grant.exercise.earlyExercise', v => v === 'true'),
      },
    }];
  }

  const payload = {
    schemaVersion: 1, id, opportunityId, supersedesRevisionId, asOfDate, status, currency: 'USD',
    cash, serviceStartDate: fact('serviceStartDate'), grants, note,
  };
  if (!validateOfferRevisionShape(payload)) {
    const paths = [...new Set(validateOfferRevisionShape.errors.map(e => `${e.instancePath || '/'} ${e.message}`))].slice(0, 8);
    throw new OfferDocumentError('invalid_offer_revision', `Converted payload is not a valid offer revision: ${paths.join('; ')}`, { paths });
  }
  return { payload, unresolved: unresolved.filter(u => !(u.reason === 'missing' && u.field.startsWith('capitalization.'))) };
}
