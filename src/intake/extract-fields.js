const FIELD_LABELS = [
  'post-money valuation',
  'pre-money valuation',
  'post-money cap',
  'valuation cap',
  'estimated round size',
  "lead's investment",
  'min. investment',
  'min investment',
  'minimum investment',
  'gross carry',
  'management fee',
  'sub-adviser',
  'investment adviser',
  'allocation',
  'valuation',
  'markets',
  'market',
  'round',
  'instrument',
  'deadline',
];

const SECTION_BOUNDARIES = new Set([
  'all documents',
  'past financing',
  'note from angellist',
  'terms',
  'team',
  'leadership team',
  'company overview',
]);

function linesFromText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean);
}

function valueForLabel(lines, aliases) {
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    for (const alias of aliases) {
      if (lower === alias) {
        return lines[i + 1] || null;
      }
      if (lower.startsWith(`${alias}:`)) {
        return lines[i].slice(alias.length + 1).trim() || null;
      }
      if (lower.startsWith(`${alias} `)) {
        return lines[i].slice(alias.length).trim() || null;
      }
    }
  }
  return null;
}

function parseMoneyUsd(value) {
  if (!value || /[€£¥₹]/.test(value)) return null;
  const cleaned = value
    .replace(/\bUSD\b/gi, '')
    .replace(/US\$/gi, '$')
    .replace(/[$,\s]/g, '');
  const match = cleaned.match(/^(-?\d+(?:\.\d+)?)([kmb])?$/i);
  if (!match) return null;
  let amount = Number.parseFloat(match[1]);
  const suffix = (match[2] || '').toLowerCase();
  if (suffix === 'k') amount *= 1_000;
  else if (suffix === 'm') amount *= 1_000_000;
  else if (suffix === 'b') amount *= 1_000_000_000;
  return Number.isFinite(amount) ? amount : null;
}

function parsePercent(value) {
  const match = value?.match(/-?\d+(?:\.\d+)?/);
  return match ? Number.parseFloat(match[0]) : null;
}

function slugify(value) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function extractCompanyName(lines) {
  for (const line of lines) {
    const match = line.match(/(?:^|\s)([^|]+?)\s*\|\s*AngelList$/i);
    if (!match) continue;
    let name = match[1].trim();
    name = name.replace(/^\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}\s+(?:AM|PM)\s+/i, '');
    if (name && !/^confidential:/i.test(name)) return name;
  }
  return null;
}

function extractLead(lines) {
  for (const line of lines) {
    const match = line.match(/^note from\s+(.+)$/i);
    if (match && !/^angellist$/i.test(match[1].trim())) return match[1].trim();
  }
  for (const line of lines) {
    const match = line.match(/^(.+?)\s+invested in\s+.+?\s+in a previous funding round\b/i);
    if (match) return match[1].trim();
  }
  return valueForLabel(lines, ['sub-adviser']);
}

function cleanInvestorName(value) {
  let name = value.trim();
  if (/^[A-Z]{1,3}\s+[A-Z][A-Za-z]/.test(name)) name = name.replace(/^[A-Z]{1,3}\s+/, '');
  if (!name || /^(undisclosed|search)$/i.test(name)) return null;
  if (/^(lead\s*[•·]|\$|download|document\b|closing documents)/i.test(name)) return null;
  return name;
}

function extractCoInvestors(lines) {
  const investors = [];
  const start = lines.findIndex(line => /^co-?investors$/i.test(line));
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      const lower = lines[i].toLowerCase();
      if (SECTION_BOUNDARIES.has(lower) || FIELD_LABELS.some(label => lower === label || lower.startsWith(`${label} `))) break;
      const name = cleanInvestorName(lines[i]);
      if (name) investors.push(name);
    }
  }
  for (let i = 1; i < lines.length; i++) {
    if (!/^lead\s*[•·]/i.test(lines[i])) continue;
    const name = cleanInvestorName(lines[i - 1]);
    if (name) investors.push(name);
  }
  const unique = [...new Set(investors)];
  return unique.length > 0 ? unique.join(', ') : null;
}

export function isAngelListDealText(text) {
  const lines = linesFromText(text);
  const hasBrandMarker = lines.some(line => /\|\s*AngelList$/i.test(line))
    || lines.some(line => /removal from AngelList/i.test(line));
  const labelCount = ['round', 'allocation', 'gross carry', 'min. investment', 'markets']
    .filter(label => lines.some(line => {
      const lower = line.toLowerCase();
      return lower === label || lower.startsWith(`${label} `) || lower.startsWith(`${label}:`);
    })).length;
  return hasBrandMarker && labelCount >= 3 && !!extractCompanyName(lines);
}

export function extractDealFields(text) {
  const lines = linesFromText(text);
  const companyName = extractCompanyName(lines);
  if (!companyName) return null;

  const round = valueForLabel(lines, ['round']);
  const valuationText = valueForLabel(lines, [
    'post-money valuation',
    'pre-money valuation',
    'post-money cap',
    'valuation cap',
    'valuation',
  ]);
  const allocationText = valueForLabel(lines, ['allocation']);
  const minInvestmentText = valueForLabel(lines, ['min. investment', 'min investment', 'minimum investment']);
  const carryText = valueForLabel(lines, ['gross carry', 'carry']);
  const market = valueForLabel(lines, ['markets', 'market']);

  return {
    company_name: companyName,
    lead: extractLead(lines),
    co_investors: extractCoInvestors(lines),
    market,
    round,
    allocation_usd: parseMoneyUsd(allocationText),
    min_investment_usd: parseMoneyUsd(minInvestmentText),
    carry_pct: parsePercent(carryText),
    valuation_text: valuationText,
    valuation_usd: parseMoneyUsd(valuationText),
    source: 'intake',
    status: 'invite',
    deal_slug: slugify([companyName, round, 'angellist'].filter(Boolean).join('-')),
  };
}
