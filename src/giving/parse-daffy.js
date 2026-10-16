// Deterministic parser for Daffy donor-advised-fund emails (pure, no model).
//
// Templates seen in real Daffy mail (2026):
//   receipt         "Your donation recommendation to X has been approved." + Donation date / Non-profit /
//                   Tax-ID / Donation amount / Donation use lines. The date is stated, so it is the gift date.
//   sent            "we've sent your donation to X" + "- Charity:" / "- Amount:" bullets.
//   recommendation  "Thank you for making your donation recommendation to ”X”!" + TAX-ID / Donation use.
//                   Pending review, so never proof of payment. Its plain text has no amount; the amount is
//                   only in the HTML part, which is used when supplied.
// Every Daffy email ends with Daffy's own EIN in a footer; the footer is removed before parsing so it can
// never be read as the charity's EIN. Values are copied verbatim into the excerpt so the import literal
// rule (every literal appears in the excerpt) holds. Unrecognized Daffy mail returns null.

const FOOTER = /\n-{3,}\s*\n[\s\S]*Daffy Charitable Fund is recognized[\s\S]*$/;
const MONEY = /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\$\s?\d+(?:\.\d{2})?/;
const EIN = /\b\d{2}-\d{7}\b/;

export function isDaffyEmail({ from = '', text = '' } = {}) {
  return /@daffy\.org\b|\bDaffy\b/i.test(from) || /Daffy Charitable Fund/i.test(text);
}

export function centsFromMoney(literal) {
  const clean = String(literal).replace(/[$,\s]/g, '');
  return /^\d+(\.\d{1,2})?$/.test(clean) ? Math.round(Number(clean) * 100) : null;
}

// MM/DD/YY or MM/DD/YYYY → YYYY-MM-DD (two-digit years are 20YY).
export function isoFromUsDate(literal) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(String(literal).trim());
  if (!match) return null;
  const [, m, d, y] = match;
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  const iso = `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const probe = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(probe.getTime()) && probe.toISOString().slice(0, 10) === iso ? iso : null;
}

const body = text => String(text || '').replace(/\r\n/g, '\n').replace(FOOTER, '').trim();
const line = (text, pattern) => text.split('\n').find(entry => pattern.test(entry)) || null;
// The value on "Label: value" or on the line after a bare "Label" heading.
function labeled(text, label) {
  const lines = text.split('\n').map(entry => entry.trim());
  for (let i = 0; i < lines.length; i += 1) {
    const inline = new RegExp(`^-?\\s*${label}\\s*:\\s*(.+)$`, 'i').exec(lines[i]);
    if (inline) return { value: inline[1].trim(), line: lines[i] };
    if (new RegExp(`^${label}$`, 'i').test(lines[i]) && lines[i + 1]) return { value: lines[i + 1], line: `${lines[i]}\n${lines[i + 1]}` };
  }
  return null;
}

function proposal({ kind, stage, name, ein, amountLiteral, dateLiteral, dateValue, dateBasis, purpose, receivedAt, notes, excerptLines }) {
  return {
    kind,
    stage,
    excerpt: [...new Set(excerptLines.filter(Boolean))].join('\n'),
    proposed: {
      kind,
      organization: { name: name || null, ein: ein || null, ein_literal: ein || null },
      amount: amountLiteral ? { cents: centsFromMoney(amountLiteral), currency: 'USD', literal: amountLiteral } : { cents: null, currency: null, literal: null },
      date: dateValue
        ? { value: dateValue, basis: dateBasis, literal: dateLiteral || null }
        : receivedAt ? { value: String(receivedAt).slice(0, 10), basis: 'email_received', literal: null } : { value: null, basis: 'unknown', literal: null },
      purpose: purpose || null,
      vehicle: 'daffy',
      confidence: 'high',
      notes: notes || null,
    },
  };
}

// Returns { kind, stage, excerpt, proposed } or null when the text is not a known Daffy template.
export function parseDaffyEmail({ text, html = null, receivedAt = null }) {
  const main = body(text);
  const approved = /Your\s+donation\s+recommendation\s+to\s+([^\n]+?(?:\n[^\n]+?)?)\s+has\s+been\s+approved\./.exec(main);
  if (approved) {
    const date = labeled(main, 'Donation date');
    const dateLiteral = date ? (/\d{1,2}\/\d{1,2}\/\d{2,4}/.exec(date.value) || [])[0] : null;
    const org = labeled(main, 'Non-profit');
    const ein = labeled(main, 'Tax-ID');
    const amount = labeled(main, 'Donation amount');
    const use = labeled(main, 'Donation use');
    const amountLiteral = amount ? (MONEY.exec(amount.value) || [])[0] : null;
    return proposal({
      kind: 'daf_grant', stage: 'receipt',
      name: org?.value || approved[1].replace(/\s+/g, ' '), ein: ein ? (EIN.exec(ein.value) || [])[0] : null,
      amountLiteral, dateLiteral, dateValue: dateLiteral ? isoFromUsDate(dateLiteral) : null, dateBasis: 'stated_in_excerpt',
      purpose: use?.value, receivedAt,
      excerptLines: [approved[0], date?.line, labeled(main, 'Fund')?.line, org?.line, ein?.line, amount?.line, use?.line],
    });
  }
  const sent = /we['’]ve\s+sent\s+your\s+donation\s+to\s+([^\n]+?)\.(?:\s|$)/i.exec(main);
  if (sent) {
    const charity = labeled(main, 'Charity');
    const amount = labeled(main, 'Amount');
    return proposal({
      kind: 'daf_grant', stage: 'sent',
      name: charity?.value || sent[1], amountLiteral: amount ? (MONEY.exec(amount.value) || [])[0] : null,
      receivedAt, notes: 'Daffy sent the payment; the date is when this email arrived.',
      excerptLines: [line(main, /we['’]ve sent your donation to/i), charity?.line, amount?.line],
    });
  }
  const recommended = /donation recommendation to [”“"](.+?)[”“"]/.exec(main);
  if (recommended) {
    const ein = labeled(main, 'TAX-ID') || labeled(main, 'Tax-ID');
    const use = labeled(main, 'Donation use');
    // The amount appears only in the HTML part of real recommendation emails.
    const htmlText = html ? String(html).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&') : '';
    const htmlAmount = htmlText ? /Amount\s*\n*\s*(\$\s?[\d,]+(?:\.\d{2})?)/.exec(htmlText) : null;
    return proposal({
      kind: 'daf_grant', stage: 'recommendation',
      name: recommended[1], ein: ein ? (EIN.exec(ein.value) || [])[0] : null,
      amountLiteral: htmlAmount ? htmlAmount[1] : null, receivedAt, purpose: use?.value,
      notes: 'Daffy recommendation, still under review when sent. Not proof the grant was paid.',
      excerptLines: [line(main, /donation recommendation to/), ein?.line, use?.line, htmlAmount ? `Amount ${htmlAmount[1]}` : null],
    });
  }
  return null;
}
