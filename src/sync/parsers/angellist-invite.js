// Parses an AngelList "invited you to invest" email into structured data.
//
// Input: { subject, from, receivedAt, text, html, messageId }
//   - text: plain-text body OR text extracted from html
//   - html: raw html body (used to find dataroom UUID URL)
// Output: structured invite object suitable for upserting into pipeline_invites.

const FIELD_LABELS = ['Market', 'Stage', 'Round', 'Valuation', 'Allocation', 'Min. Investment', 'Min Investment', 'Carry', "Syndicate's Investment", 'Syndicate Investment'];

export function parseInviteEmail({ subject, from, receivedAt, text, html, messageId }) {
  if (!text) throw new Error('parseInviteEmail: text body is required');

  // Normalize the text into trimmed non-empty lines
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  // --- Lead + company from the "X has invited you to invest in Y" line ---
  let lead = null;
  let companyName = null;
  for (const line of lines) {
    const m = line.match(/^(.+?)\s+has\s+invited\s+you\s+to\s+invest\s+in\s+(.+)$/i);
    if (m) {
      lead = m[1].trim();
      companyName = m[2].trim();
      break;
    }
  }
  // Fallback: use the subject line "X invited you to invest in Y"
  if (!lead && subject) {
    const m = subject.match(/^(.+?)\s+invited\s+you\s+to\s+invest\s+in\s+(.+)$/i);
    if (m) {
      lead = m[1].trim();
      if (!companyName) companyName = m[2].trim();
    }
  }
  if (!companyName) throw new Error('parseInviteEmail: could not extract company name');

  // --- Co-investors line ---
  let coInvestors = null;
  for (const line of lines) {
    const m = line.match(/^Co-?investors?:\s*(.+)$/i);
    if (m) {
      coInvestors = m[1].trim();
      break;
    }
  }

  // --- GP message: between "Message from the GP" and the first structured label ---
  // The first structured label can be its own line OR glued to its value (e.g. "MarketFinance").
  let gpMessage = null;
  const gpStart = lines.findIndex(l => /^message\s+from\s+the\s+gp$/i.test(l));
  if (gpStart >= 0) {
    let gpEnd = lines.length;
    for (let i = gpStart + 1; i < lines.length; i++) {
      const lc = lines[i].toLowerCase();
      const isLabel = FIELD_LABELS.some(label => {
        const ll = label.toLowerCase();
        return lc === ll || lc.startsWith(ll);
      });
      if (isLabel) { gpEnd = i; break; }
    }
    gpMessage = lines.slice(gpStart + 1, gpEnd).join('\n\n').trim();
  }

  // --- Structured fields ---
  // The HTML often glues label and value into one line (e.g. "MarketFinance"),
  // but sometimes splits them across two lines. Handle both.
  const fields = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const label of FIELD_LABELS) {
      const lc = label.toLowerCase();
      if (fields[lc]) continue;

      // Case A: label is the entire line, value is next line
      if (line.toLowerCase() === lc) {
        const next = lines[i + 1];
        if (next && !FIELD_LABELS.some(l => l.toLowerCase() === next.toLowerCase())) {
          fields[lc] = next;
        }
        break;
      }

      // Case B: label is a prefix of the line and value follows in the same line
      if (line.toLowerCase().startsWith(lc) && line.length > label.length) {
        const value = line.slice(label.length).trim();
        // Reject if the rest looks like another label
        if (value && !FIELD_LABELS.some(l => value.toLowerCase().startsWith(l.toLowerCase()))) {
          fields[lc] = value;
        }
        break;
      }
    }
  }

  const market = fields['market'] || null;
  const round = fields['stage'] || fields['round'] || null;
  const valuationText = fields['valuation'] || null;
  const allocationText = fields['allocation'] || null;
  const minInvestmentText = fields['min. investment'] || fields['min investment'] || null;
  const carryText = fields['carry'] || null;
  const syndicateInvestmentText = fields["syndicate's investment"] || fields['syndicate investment'] || null;

  // --- Dataroom URL from the html ---
  let dataroomUrl = null;
  if (html) {
    const m = html.match(/https:\/\/portal\.angellist\.com\/start\/data-room-invite\/[a-f0-9-]+/i);
    if (m) dataroomUrl = m[0];
  }

  // --- Generate a deal_slug for upserts (lead + company + round, lowercased + dashed) ---
  const dealSlug = slugify([lead, companyName, round].filter(Boolean).join('-'));

  return {
    gmail_message_id: messageId || null,
    email_received_at: receivedAt || null,
    source: 'email',
    deal_slug: dealSlug,
    company_name: companyName,
    lead,
    co_investors: coInvestors,
    market,
    round,
    allocation_usd: parseMoneyUSD(allocationText),
    min_investment_usd: parseMoneyUSD(minInvestmentText),
    carry_pct: parsePercent(carryText),
    syndicate_investment_usd: parseMoneyUSD(syndicateInvestmentText),
    valuation_text: valuationText,
    valuation_usd: parseMoneyUSD(valuationText),
    gp_message: gpMessage,
    dataroom_url: dataroomUrl,
    detail_url: null,
    status: 'invite',
  };
}

function slugify(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

// Parses things like "$1,000,000", "$10M", "€52M", "$500k". Returns USD-ish number,
// or null if non-USD currency or unparseable. Stores raw in valuation_text either way.
function parseMoneyUSD(s) {
  if (!s) return null;
  const trimmed = s.trim();
  // Reject explicit non-USD currencies
  if (/[€£¥₹]/.test(trimmed)) return null;
  // Strip $ and commas
  const cleaned = trimmed.replace(/[$,\s]/g, '');
  // Suffixes
  const m = cleaned.match(/^(-?\d+(?:\.\d+)?)([kKmMbB])?$/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const suffix = (m[2] || '').toLowerCase();
  if (suffix === 'k') n *= 1_000;
  else if (suffix === 'm') n *= 1_000_000;
  else if (suffix === 'b') n *= 1_000_000_000;
  return Number.isFinite(n) ? n : null;
}

function parsePercent(s) {
  if (!s) return null;
  const m = s.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

// Strips HTML to plain text. Handles <br>, block tags, scripts, styles.
// Used by the sync orchestrator when gmail returns html-only bodies.
export function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|td|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}
