// giving-import/v1 validation and normalization (pure).
//
// The file is a set of PROPOSALS. Validation enforces the schema, then the literal rule:
// every *literal must appear verbatim in the item's excerpt. A proposed value whose
// literal is missing from the excerpt is cleared and flagged, so invented numbers never
// reach the confirm screen as if they were read from the source.

import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { assertDate, GivingError } from './report.js';
import { normalizeEin } from './matching.js';

const schema = JSON.parse(readFileSync(new URL('./giving-import-v1.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const validateSchema = ajv.compile(schema);
ajv.addSchema(schema, 'giving-import-v1');
const validateProposed = ajv.compile({ $ref: 'giving-import-v1#/$defs/item/properties/proposed' });

const isDate = value => {
  try { assertDate(value); return true; } catch { return false; }
};
const isDateTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));

export function externalKeyFor(item) {
  return `gmail:${item.source_ref.message_id}`;
}

// Returns { source, items: [{external_key, kind, excerpt, proposed, issues, source_ref}] }.
export function parseGivingImport(doc) {
  if (!validateSchema(doc)) {
    const first = validateSchema.errors[0];
    throw new GivingError(`Import file does not match giving-import/v1: ${first.instancePath || '/'} ${first.message}`, first.instancePath || 'file');
  }
  if (!isDateTime(doc.generated_at)) throw new GivingError('generated_at must be a date-time', 'generated_at');
  if (!isDate(doc.scan.period.from) || !isDate(doc.scan.period.to)) throw new GivingError('scan.period dates must be YYYY-MM-DD', 'scan.period');
  if (doc.scan.items_proposed !== doc.items.length) throw new GivingError('scan.items_proposed does not match the number of items', 'scan.items_proposed');
  const seen = new Set();
  const items = doc.items.map(item => {
    const key = externalKeyFor(item);
    if (seen.has(key)) throw new GivingError(`Message ${item.source_ref.message_id} appears twice`, item.item_id);
    seen.add(key);
    return normalizeItem(item);
  });
  return {
    source: {
      kind: doc.generator.kind === 'sample' ? 'sample' : 'gmail_scan',
      member_display_name: doc.household_member.display_name,
      metadata: {
        format: doc.format,
        generated_at: doc.generated_at,
        generator: doc.generator,
        period: doc.scan.period,
        queries: doc.scan.queries,
        messages_examined: doc.scan.messages_examined,
        items_proposed: doc.scan.items_proposed,
        known_gaps: doc.scan.known_gaps || [],
      },
    },
    items,
  };
}

// Uploaded files (email files, PDFs, CSVs, screenshots) yield proposals in the same shape and
// pass the same literal rule. external_key is upload:<file sha256>:<index>, so re-uploading
// the same file adds nothing.
// candidates: [{ excerpt, proposed, source: { subject, from_name, from_domain, received_at }, extraIssues }]
export function buildUploadItems({ fileName, fileSha256, candidates }) {
  if (!/^[0-9a-f]{64}$/.test(fileSha256 || '')) throw new GivingError('An uploaded file needs its sha256.', 'fileSha256');
  return candidates.map((candidate, index) => {
    if (!validateProposed(candidate.proposed)) {
      const first = validateProposed.errors[0];
      throw new GivingError(`Upload proposal ${index + 1} is malformed: ${first.instancePath || '/'} ${first.message}`, 'proposed');
    }
    if (typeof candidate.excerpt !== 'string' || !candidate.excerpt.trim()) throw new GivingError(`Upload proposal ${index + 1} has no source text.`, 'excerpt');
    const source = candidate.source || {};
    const normalized = normalizeItem({
      item_id: `u${index + 1}`,
      excerpt: candidate.excerpt.slice(0, 6000),
      proposed: candidate.proposed,
      source_ref: {
        kind: 'upload',
        file_name: String(fileName || 'upload').slice(0, 300),
        file_sha256: fileSha256,
        index,
        subject: String(source.subject || fileName || 'Uploaded file').slice(0, 500),
        from_name: String(source.from_name || 'Uploaded file').slice(0, 200),
        from_domain: String(source.from_domain || '').slice(0, 200),
        received_at: source.received_at || null,
      },
    });
    return {
      ...normalized,
      external_key: `upload:${fileSha256}:${index}`,
      issues: [...normalized.issues, ...(candidate.extraIssues || [])],
    };
  });
}

function normalizeItem(item) {
  const excerpt = item.excerpt;
  const issues = [];
  const p = structuredClone(item.proposed);
  const check = (literal, field, clear) => {
    if (literal == null) return;
    if (!excerpt.includes(literal)) {
      issues.push({ field, code: 'LITERAL_NOT_IN_EXCERPT' });
      clear();
    }
  };

  check(p.amount.literal, 'amount', () => { p.amount = { cents: null, currency: null, literal: null }; });
  if (p.amount.cents != null && p.amount.literal == null) {
    issues.push({ field: 'amount', code: 'AMOUNT_WITHOUT_LITERAL' });
    p.amount = { cents: null, currency: null, literal: null };
  }
  check(p.date.literal, 'date', () => { p.date = { value: null, basis: 'unknown', literal: null }; });
  if (p.date.value != null && !isDate(p.date.value)) {
    issues.push({ field: 'date', code: 'INVALID_DATE' });
    p.date = { value: null, basis: 'unknown', literal: null };
  }
  if (p.date.basis === 'stated_in_excerpt' && p.date.literal == null) {
    issues.push({ field: 'date', code: 'STATED_DATE_WITHOUT_LITERAL' });
    p.date = { ...p.date, basis: 'email_received' };
  }
  if (p.date.basis === 'email_received') issues.push({ field: 'date', code: 'DATE_IS_EMAIL_PROXY' });
  if (p.date.value == null) issues.push({ field: 'date', code: 'DATE_UNKNOWN' });

  check(p.organization.ein_literal, 'organization.ein', () => { p.organization = { ...p.organization, ein: null, ein_literal: null }; });
  if (p.organization.ein != null) {
    if (p.organization.ein_literal == null) {
      issues.push({ field: 'organization.ein', code: 'EIN_WITHOUT_LITERAL' });
      p.organization = { ...p.organization, ein: null };
    } else {
      p.organization = { ...p.organization, ein: normalizeEin(p.organization.ein) };
    }
  }
  if (p.request) {
    check(p.request.requested_literal, 'request.requested', () => { p.request = { ...p.request, requested_cents: null, requested_literal: null }; });
    check(p.request.deadline_literal, 'request.deadline', () => { p.request = { ...p.request, deadline: null, deadline_literal: null }; });
    if (p.request.requested_cents != null && p.request.requested_literal == null) p.request = { ...p.request, requested_cents: null };
    if (p.request.deadline != null && (p.request.deadline_literal == null || !isDate(p.request.deadline))) p.request = { ...p.request, deadline: null };
  }
  if (p.pledge) {
    check(p.pledge.total_literal, 'pledge.total', () => { p.pledge = { ...p.pledge, total_cents: null, total_literal: null }; });
    if (p.pledge.total_cents != null && p.pledge.total_literal == null) p.pledge = { ...p.pledge, total_cents: null };
  }
  if (p.recurring) check(p.recurring.literal, 'recurring', () => { p.recurring = { cadence: 'unknown', literal: null }; });

  return {
    external_key: externalKeyFor(item),
    kind: p.kind,
    excerpt,
    proposed: { ...p, item_id: item.item_id, source_ref: item.source_ref },
    issues,
  };
}
