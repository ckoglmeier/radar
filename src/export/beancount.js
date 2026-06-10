// Generate a Beancount plain-text ledger from Radar's database.
// Produces a valid .beancount file with accounts, transactions, and price directives.

import { writeFileSync } from 'fs';
import { query } from '../db/index.js';

function sanitizeAccountName(name) {
  // Beancount account components must be CamelCase or PascalCase alphanumeric
  return name
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

function sanitizeCommodity(name) {
  // Beancount commodities: uppercase letters, digits, dots, dashes, underscores. Max ~24 chars.
  return name
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 20);
}

function fmtDate(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function fmtAmount(n) {
  if (n == null) return '0.00';
  return Number(n).toFixed(2);
}

export async function exportBeancount(outputPath) {
  const lines = [];

  // Header
  lines.push('; Radar portfolio export — generated from Neon database');
  lines.push(`; Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('option "operating_currency" "USD"');
  lines.push('option "title" "CK Angel Portfolio"');
  lines.push('');

  // Standard accounts
  lines.push('1900-01-01 open Assets:Cash:AngelList  USD');
  lines.push('1900-01-01 open Assets:Cash:Bank  USD');
  lines.push('1900-01-01 open Income:Angel:CapitalGains  USD');
  lines.push('1900-01-01 open Income:Angel:Distributions  USD');
  lines.push('1900-01-01 open Income:Angel:Refunds  USD');
  lines.push('1900-01-01 open Expenses:Angel:Investments  USD');
  lines.push('1900-01-01 open Expenses:Angel:Losses  USD');
  lines.push('1900-01-01 open Equity:Opening-Balances  USD');
  lines.push('');

  // Fetch investments with thesis tags
  const investments = await query(`
    SELECT i.*,
      COALESCE(
        (SELECT string_agg(t.name, ', ')
         FROM investment_theses it JOIN theses t ON t.id = it.thesis_id
         WHERE it.investment_id = i.id),
        ''
      ) AS theses
    FROM investments i
    ORDER BY i.invest_date, i.company_name
  `);

  // Open accounts + commodity declarations per investment
  lines.push('; ─── Accounts & Commodities ───');
  lines.push('');

  const commodityMap = {}; // company_name -> commodity symbol
  for (const inv of investments) {
    const acctName = sanitizeAccountName(inv.company_name);
    const commodity = sanitizeCommodity(inv.company_name);
    commodityMap[inv.company_name] = commodity;

    const openDate = fmtDate(inv.invest_date) || '2020-01-01';
    lines.push(`${openDate} open Assets:Angel:${acctName}  ${commodity}`);

    // Commodity metadata
    lines.push(`${openDate} commodity ${commodity}`);
    lines.push(`  name: "${inv.company_name}"`);
    if (inv.round) lines.push(`  round: "${inv.round}"`);
    if (inv.market) lines.push(`  market: "${inv.market}"`);
    if (inv.theses) lines.push(`  thesis: "${inv.theses}"`);
    if (inv.stage_bucket) lines.push(`  stage: "${inv.stage_bucket}"`);
    if (inv.lead) lines.push(`  lead: "${inv.lead}"`);
    lines.push('');
  }

  // Fetch cash_flows for transactions
  const cashFlows = await query(`
    SELECT cf.*, i.company_name
    FROM cash_flows cf
    LEFT JOIN investments i ON i.id = cf.investment_id
    ORDER BY cf.flow_date, cf.id
  `);

  lines.push('; ─── Transactions ───');
  lines.push('');

  for (const cf of cashFlows) {
    const date = fmtDate(cf.flow_date);
    if (!date) continue;

    const desc = (cf.description || cf.type).replace(/"/g, '\\"');
    const amount = Number(cf.amount || 0);
    const companyName = cf.company_name || cf.company_raw;
    const acctName = companyName ? sanitizeAccountName(companyName) : null;
    const commodity = companyName ? (commodityMap[companyName] || sanitizeCommodity(companyName)) : null;

    if (cf.type === 'investment' && acctName && commodity) {
      // Capital deployment: cash out, position in
      const invested = Math.abs(amount);
      lines.push(`${date} * "AngelList" "${desc}"`);
      lines.push(`  Assets:Angel:${acctName}  1 ${commodity} {${fmtAmount(invested)} USD}`);
      lines.push(`  Assets:Cash:AngelList  -${fmtAmount(invested)} USD`);
      lines.push('');
    } else if (cf.type === 'distribution' && acctName) {
      // Distribution: cash in
      lines.push(`${date} * "AngelList" "${desc}"`);
      lines.push(`  Assets:Cash:AngelList  ${fmtAmount(amount)} USD`);
      lines.push(`  Income:Angel:Distributions`);
      lines.push('');
    } else if (cf.type === 'refund' && acctName) {
      // Refund: cash in, reduces position
      lines.push(`${date} * "AngelList" "${desc}"`);
      lines.push(`  Assets:Cash:AngelList  ${fmtAmount(amount)} USD`);
      lines.push(`  Income:Angel:Refunds`);
      lines.push('');
    } else if (cf.type === 'deposit') {
      lines.push(`${date} * "AngelList" "${desc}"`);
      lines.push(`  Assets:Cash:AngelList  ${fmtAmount(amount)} USD`);
      lines.push(`  Assets:Cash:Bank`);
      lines.push('');
    } else if (cf.type === 'withdrawal') {
      lines.push(`${date} * "AngelList" "${desc}"`);
      lines.push(`  Assets:Cash:Bank  ${fmtAmount(Math.abs(amount))} USD`);
      lines.push(`  Assets:Cash:AngelList  -${fmtAmount(Math.abs(amount))} USD`);
      lines.push('');
    } else {
      // Generic fallback
      lines.push(`${date} * "AngelList" "${desc}"`);
      lines.push(`  Assets:Cash:AngelList  ${fmtAmount(amount)} USD`);
      lines.push(`  Equity:Opening-Balances`);
      lines.push('');
    }
  }

  // Price directives from valuations
  const valuations = await query(`
    SELECT v.snapshot_date, v.unrealized_value, i.company_name, i.invested
    FROM valuations v
    JOIN investments i ON i.id = v.investment_id
    WHERE v.unrealized_value IS NOT NULL AND i.invested > 0
    ORDER BY v.snapshot_date, i.company_name
  `);

  if (valuations.length > 0) {
    lines.push('; ─── Price Directives (from valuation snapshots) ───');
    lines.push('');

    for (const v of valuations) {
      const commodity = commodityMap[v.company_name] || sanitizeCommodity(v.company_name);
      const date = fmtDate(v.snapshot_date);
      // Price = unrealized_value (total position value serves as the "price" of 1 unit)
      const price = fmtAmount(v.unrealized_value);
      lines.push(`${date} price ${commodity}  ${price} USD`);
    }
    lines.push('');
  }

  // Write-offs: close accounts for realized/dead investments
  const closed = investments.filter(i => i.status === 'Realized' && Number(i.net_value || 0) <= 0);
  if (closed.length > 0) {
    lines.push('; ─── Closed Accounts (written off) ───');
    lines.push('');
    for (const inv of closed) {
      const acctName = sanitizeAccountName(inv.company_name);
      const date = fmtDate(inv.updated_at) || fmtDate(inv.invest_date) || '2026-01-01';
      lines.push(`${date} close Assets:Angel:${acctName}`);
    }
    lines.push('');
  }

  const content = lines.join('\n');
  const path = outputPath || 'radar-portfolio.beancount';
  writeFileSync(path, content, 'utf-8');

  return {
    path,
    investments: investments.length,
    transactions: cashFlows.length,
    valuations: valuations.length,
    lines: lines.length,
  };
}
