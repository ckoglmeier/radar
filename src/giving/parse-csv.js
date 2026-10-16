// Giving CSV import (pure). Recognizes common column names from DAF exports and donation
// histories. Each row becomes a proposal whose excerpt is the row's own "Column: value"
// text, so every literal is verbatim from the file. Rows whose status is not a completed
// payment are flagged, never silently counted.

import { parse } from 'csv-parse/sync';
import { centsFromMoney, isoFromUsDate } from './parse-daffy.js';

const ALIASES = {
  date: ['date', 'donation date', 'gift date', 'transaction date', 'payment date', 'paid date', 'date sent', 'created at', 'created'],
  organization: ['organization', 'organization name', 'charity', 'charity name', 'non-profit', 'nonprofit', 'non profit', 'recipient', 'payee', 'grantee'],
  ein: ['ein', 'tax id', 'tax-id', 'taxid', 'ein/tax id'],
  amount: ['amount', 'donation amount', 'gift amount', 'grant amount', 'total', 'amount (usd)'],
  status: ['status', 'donation status', 'state'],
  purpose: ['purpose', 'designation', 'donation use', 'fund designation', 'program', 'memo', 'note', 'notes'],
};
const PAID = /^(completed?|sent|paid|approved|disbursed|succeeded|successful|delivered)$/i;
const normalizeHeader = value => String(value || '').toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

export function mapColumns(headers) {
  const mapping = {};
  headers.forEach((header, index) => {
    const name = normalizeHeader(header);
    for (const [field, aliases] of Object.entries(ALIASES)) {
      if (mapping[field] == null && aliases.includes(name)) mapping[field] = index;
    }
  });
  return mapping;
}

function isoDate(value) {
  const text = String(value || '').trim();
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  if (iso) return { value: iso[1], literal: iso[1] };
  const us = /^(\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2}))/.exec(text);
  if (us && isoFromUsDate(us[1])) return { value: isoFromUsDate(us[1]), literal: us[1] };
  return null;
}

// Returns { mapping, missing, rows: [{ excerpt, proposed, extraIssues }] }.
export function parseGivingCsv(text, { vehicle = 'unknown' } = {}) {
  const records = parse(String(text || ''), { bom: true, relax_column_count: true, skip_empty_lines: true, trim: true });
  if (records.length < 2) return { mapping: {}, missing: ['organization', 'amount'], rows: [] };
  const [headers, ...data] = records;
  const mapping = mapColumns(headers);
  const missing = ['organization', 'amount'].filter(field => mapping[field] == null);
  if (missing.length) return { mapping, missing, rows: [] };
  const rows = data.map(cells => {
    const cell = field => (mapping[field] == null ? '' : String(cells[mapping[field]] ?? '').trim());
    const excerpt = headers.map((header, index) => (cells[index] ? `${header}: ${cells[index]}` : null)).filter(Boolean).join('\n');
    const amountText = cell('amount');
    const amountLiteral = (/\$?\s?\d[\d,]*(?:\.\d{1,2})?/.exec(amountText) || [])[0] || null;
    const cents = amountLiteral ? centsFromMoney(amountLiteral) : null;
    const date = isoDate(cell('date'));
    const status = cell('status');
    const einText = cell('ein');
    const ein = (/\b\d{2}-?\d{7}\b/.exec(einText) || [])[0] || null;
    const extraIssues = status && !PAID.test(status) ? [{ field: 'status', code: 'STATUS_NOT_PAID' }] : [];
    return {
      excerpt,
      extraIssues,
      proposed: {
        kind: vehicle === 'daffy' || vehicle === 'other_daf' ? 'daf_grant' : 'receipt',
        organization: { name: cell('organization') || null, ein, ein_literal: ein },
        amount: cents ? { cents, currency: 'USD', literal: amountLiteral } : { cents: null, currency: null, literal: null },
        date: date ? { value: date.value, basis: 'stated_in_excerpt', literal: date.literal } : { value: null, basis: 'unknown', literal: null },
        purpose: cell('purpose') || null,
        vehicle,
        confidence: extraIssues.length ? 'low' : 'high',
        notes: status && !PAID.test(status) ? `Status in the file: ${status}` : null,
      },
    };
  });
  return { mapping, missing, rows };
}
