// AngelList individual transaction ledger importer.
// Parses the CSV export at transactions-files/*.csv into cash_flows rows.
//
// Ledger row shape:
//   Date,Transaction,Description,Amount,Balance
//   2026-03-16,Disbursement,Acme Robotics - Distribution Proceeds - Example Ventures SPV,1234.56,5678.90
//
// Transaction types observed:
//   - Deposit      (ACH in from external bank; not linked to an investment)
//   - Investment   (capital deployed into a named company; negative amount)
//   - Refund       ("Refund for X (deal oversubscribed)"; positive; reduces net invested)
//   - Disbursement (distribution from an SPV; positive; various subtypes)
//   - Withdrawal   (ACH out to external bank; not linked to an investment)
//   - Transfer     (ACH to external bank; variant of withdrawal)
//   - Adjustment   (e.g., failed ACH reversal)
//
// The importer is idempotent via an external_hash on each row.

import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { query } from '../db/index.js';
import { withSyncRun } from '../db/sync-runs.js';
import { matchCompanyToInvestment, loadInvestmentUniverse } from '../utils/match.js';
import { detectAndLogChanges } from '../models/investments.js';
import { insertCashFlow } from '../models/cash-flows.js';

const __dirname = dirname(fileURLToPath(String(import.meta.url)));
const LEAD_PREFIXES_PATH = join(__dirname, '../config/lead-prefixes.json');

/** Load GP/syndicate lead prefixes from src/config/lead-prefixes.json, or [] if missing. */
function loadLeadPrefixes() {
  if (!existsSync(LEAD_PREFIXES_PATH)) return [];
  try {
    const raw = readFileSync(LEAD_PREFIXES_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.prefixes) ? parsed.prefixes : [];
  } catch {
    return [];
  }
}

// ---------- Parsing ----------

/**
 * Extract the company name + SPV/lead + subtype from a transaction description.
 * Returns { company, spv, subtype } — any may be null.
 *
 * @param {string} type - Transaction type (Investment, Refund, Disbursement, …)
 * @param {string} description - Raw description string from the CSV
 * @param {string[]} [leadPrefixes] - GP/syndicate name prefixes to strip when extracting
 *   company from an SPV string. Defaults to loading src/config/lead-prefixes.json.
 *   Pass an explicit array in tests so tests never depend on the local config file.
 */
export function parseDescription(type, description, leadPrefixes) {
  if (!description) return { company: null, spv: null, subtype: null };
  const d = description.trim();

  if (type === 'Investment') {
    // "Investment in Company Name"
    const m = d.match(/^Investment in\s+(.+)$/i);
    if (m) return { company: m[1].trim(), spv: null, subtype: 'primary' };
  }

  if (type === 'Refund') {
    // "Refund for Company Name (deal oversubscribed)"
    const m = d.match(/^Refund for\s+(.+?)(?:\s*\(.*\))?$/i);
    if (m) return { company: m[1].trim(), spv: null, subtype: 'oversubscription' };
  }

  if (type === 'Disbursement') {
    // Shape 1: "Return of Capital - Example Ventures Sample Pay SPV"
    //   (no clean "Company - ..." prefix, subtype is first, SPV contains company)
    // Shape 2: "Company Acquisition - Closing Proceeds - Sample Syndicate SPV"
    // Shape 3: "Company - Subtype Proceeds - SPV Name"
    // Shape 4: "Company - Subtype Proceeds (Nth Tranche) - SPV Name"
    const parts = d.split(/\s*-\s*/).map(s => s.trim());

    // Detect "Return of Capital" / "Failed X" patterns where no company prefix
    if (/^Return of Capital$/i.test(parts[0])) {
      // e.g., "Return of Capital - Example Ventures Sample Pay SPV"
      // SPV string typically ends with "SPV" or "Fund" and contains the company
      const spv = parts.slice(1).join(' - ') || null;
      // Try to extract a company token from SPV: strip known lead prefixes
      const company = extractCompanyFromSpv(spv, leadPrefixes);
      return { company, spv, subtype: 'return_of_capital' };
    }

    // Standard shape: "<Company> - <Subtype Proceeds> - <SPV>"
    // Company may itself contain " Acquisition" or " Closing" noise — strip those.
    if (parts.length >= 2) {
      let company = parts[0];
      const middle = parts.slice(1, parts.length - 1).join(' - ');
      const spv = parts[parts.length - 1] || null;

      // Normalize subtype from middle
      let subtype = null;
      const sub = (middle || parts[1] || '').toLowerCase();
      if (sub.includes('distribution proceeds')) subtype = 'distribution';
      else if (sub.includes('secondary sale') || sub.includes('secondary proceeds')) subtype = 'secondary';
      else if (sub.includes('closing proceeds')) subtype = 'closing';
      else if (sub.includes('escrow release')) subtype = 'escrow_release';
      else if (sub.includes('dissolution')) subtype = 'dissolution';
      else if (sub.includes('redemption')) subtype = 'redemption';
      else if (sub.includes('deferred consideration')) subtype = 'deferred_consideration';
      else if (sub.includes('return of capital')) subtype = 'return_of_capital';

      // Strip common company-side noise
      company = company
        .replace(/\s+Acquisition$/i, '')
        .trim();

      return { company, spv, subtype };
    }

    return { company: null, spv: d, subtype: 'unknown' };
  }

  // Deposit / Withdrawal / Transfer / Adjustment — no company link
  return { company: null, spv: null, subtype: null };
}

/**
 * Strip a known GP/syndicate prefix from an SPV name to reveal the embedded company.
 * e.g., "Example Ventures Acme Robotics SPV" → "Acme Robotics"
 *       "Sample Syndicate SPV" → null (nothing left after stripping prefix + suffix)
 *
 * @param {string|null} spv
 * @param {string[]} [leadPrefixes] - Prefix list to use. Defaults to loadLeadPrefixes().
 */
function extractCompanyFromSpv(spv, leadPrefixes) {
  if (!spv) return null;
  const prefixes = leadPrefixes !== undefined ? leadPrefixes : loadLeadPrefixes();
  let cleaned = spv;
  for (const p of prefixes) {
    const re = new RegExp('^' + p.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '\\s*', 'i');
    if (re.test(cleaned)) {
      cleaned = cleaned.replace(re, '');
      break;
    }
  }
  // Strip trailing SPV/Fund/LP suffixes (or exact match if remainder is just the suffix)
  cleaned = cleaned.replace(/^(SPV|Fund|LP|Access Fund)$|\s+(SPV|Fund|LP|Access Fund)$/i, '').trim();
  if (!cleaned || cleaned.length < 2) return null;
  return cleaned;
}

// ---------- Import ----------

/** Normalize type names to the set we use internally. */
function normalizeType(t) {
  const x = t.toLowerCase();
  if (x === 'investment') return 'investment';
  if (x === 'refund') return 'refund';
  if (x === 'disbursement') return 'distribution';
  if (x === 'deposit') return 'deposit';
  if (x === 'withdrawal' || x === 'transfer') return 'withdrawal';
  if (x === 'adjustment') return 'adjustment';
  return x;
}

function hashRow(row) {
  return createHash('sha1')
    .update(`${row.Date}|${row.Transaction}|${row.Description}|${row.Amount}|${row.Balance || ''}`)
    .digest('hex')
    .slice(0, 16);
}

export async function importTransactionLedger(csvPath) {
  return withSyncRun('angellist:transaction-ledger', `import ${csvPath}`, async () => {
    const raw = readFileSync(csvPath, 'utf-8');
    const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
    return runTransactionImportRows(rows, { source: 'angellist_ledger' });
  });
}

export async function importTransactionRows(rows, options = {}) {
  const source = options.source || 'angellist_ledger';
  return withSyncRun('angellist:transaction-ledger', `import ${source}`, async () => {
    return runTransactionImportRows(rows, { source });
  });
}

async function runTransactionImportRows(rows, options = {}) {
  const source = options.source || 'angellist_ledger';
  const results = {
    total: rows.length,
    inserted: 0,
    skipped: 0,
    errors: 0,
    matched: 0,
    unmatched_company_refs: new Set(),
    details: [],
  };

  // Load the investments universe once per batch — amortizes 300+ matches.
  const universe = await loadInvestmentUniverse();

  // Load lead prefixes once per batch.
  const leadPrefixes = loadLeadPrefixes();

  for (const row of rows) {
    try {
      const flowDate = row.Date; // YYYY-MM-DD already
      const rawType = row.Transaction;
      const type = normalizeType(rawType);
      const amount = parseFloat(String(row.Amount).replace(/[$,]/g, ''));
      const balance = row.Balance != null && row.Balance !== ''
        ? parseFloat(String(row.Balance).replace(/[$,]/g, ''))
        : null;
      const description = row.Description || '';
      const { company, spv, subtype } = parseDescription(rawType, description, leadPrefixes);

      const external_hash = hashRow(row);

      // Link to investment if we have a company reference
      let investment_id = null;
      if (company) {
        const match = await matchCompanyToInvestment(company, { universe });
        if (match.confidence === 'exact' || match.confidence === 'token') {
          investment_id = match.investment_id;
          results.matched++;
        } else {
          results.unmatched_company_refs.add(company);
        }
      }

      const inserted = await insertCashFlow({
        investment_id,
        flow_date: flowDate,
        type,
        subtype,
        amount,
        running_balance: balance,
        description,
        company_raw: company,
        spv_raw: spv,
        source,
        external_hash,
      });

      if (inserted) {
        results.inserted++;
      } else {
        results.skipped++;
        continue;
      }
    } catch (err) {
      results.errors++;
      results.details.push({ row, error: err.message });
    }
  }

  results.unmatched_company_refs = Array.from(results.unmatched_company_refs).sort();

  // sync_runs fields
  results.records_seen = results.total;
  results.records_new = results.inserted;
  results.records_changed = results.skipped;
  results.error_details = results.details.length > 0 ? results.details : null;

  return results;
}

// ---------- Recompute investment realized/multiple from cash_flows ----------

/**
 * For every investment that has cash_flows rows, recompute:
 *   - computed_realized   = sum of distribution cash_flows only (NOT refunds).
 *                           Refunds are tracked separately in computed_refunds.
 *   - computed_refunds    = sum of refund cash_flows (audit trail, NOT subtracted
 *                           from invested — AngelList's "Invested" column already
 *                           nets out refunds at the source, so subtracting again
 *                           would double-count).
 *   - computed_net_invested = investments.invested as reported by AngelList
 *                             (i.e. originalInvested; refunds are not re-subtracted here)
 *   - computed_total_value  = distributions + unrealized_value
 *   - computed_multiple     = computed_total_value / computed_net_invested
 *
 * Writes the computed values into dedicated computed_* columns rather than
 * overwriting AngelList's native columns. This preserves the source-of-truth
 * distinction between what AL reports and what we derive.
 */
export async function recomputeInvestmentReturns() {
  // Computed columns are created by migration 002_computed_investment_columns.sql.
  // Run `radar db:migrate` if they don't exist yet.

  // Aggregate cash_flows per investment — one round trip.
  const agg = await query(
    `SELECT
        investment_id,
        COALESCE(SUM(CASE WHEN type = 'distribution' THEN amount ELSE 0 END), 0) AS distributions,
        COALESCE(SUM(CASE WHEN type = 'refund' THEN amount ELSE 0 END), 0) AS refunds
     FROM cash_flows
     WHERE investment_id IS NOT NULL
     GROUP BY investment_id`
  );

  if (agg.length === 0) return [];

  // Bulk-fetch all investment rows in one round trip (before-state for change logging).
  const investmentIds = agg.map(r => r.investment_id);
  const invRows = await query(
    `SELECT * FROM investments WHERE id = ANY($1)`,
    [investmentIds]
  );
  const invById = Object.fromEntries(invRows.map(r => [r.id, r]));

  // Compute updates in JS.
  const computed = [];
  for (const row of agg) {
    const inv = invById[row.investment_id];
    if (!inv) continue;
    const originalInvested = Number(inv.invested || 0);
    const unrealized = Number(inv.unrealized_value || 0);
    const distributions = Number(row.distributions || 0);
    const refunds = Number(row.refunds || 0);
    // Note: the AL "Invested" column already nets out refunds. We expose both for audit.
    const netInvested = originalInvested; // keep as reported; refunds tracked separately
    const totalValue = distributions + unrealized;
    const multiple = netInvested > 0 ? totalValue / netInvested : null;
    computed.push({ inv, distributions, refunds, netInvested, totalValue, multiple });
  }

  // Apply all updates in one round trip via unnest arrays.
  await query(
    `UPDATE investments AS i
        SET computed_realized    = v.computed_realized::numeric,
            computed_refunds     = v.computed_refunds::numeric,
            computed_net_invested = v.computed_net_invested::numeric,
            computed_total_value = v.computed_total_value::numeric,
            computed_multiple    = v.computed_multiple::numeric,
            computed_at          = NOW()
       FROM (
         SELECT
           unnest($1::int[])     AS id,
           unnest($2::numeric[]) AS computed_realized,
           unnest($3::numeric[]) AS computed_refunds,
           unnest($4::numeric[]) AS computed_net_invested,
           unnest($5::numeric[]) AS computed_total_value,
           unnest($6::numeric[]) AS computed_multiple
       ) AS v
      WHERE i.id = v.id`,
    [
      computed.map(c => c.inv.id),
      computed.map(c => c.distributions),
      computed.map(c => c.refunds),
      computed.map(c => c.netInvested),
      computed.map(c => c.totalValue),
      computed.map(c => c.multiple),
    ]
  );

  // Build after-rows in JS (only the 5 computed_* fields changed; computed_at is
  // excluded from TRACKED_COMPUTED so its new value doesn't matter for diffing).
  const updates = [];
  for (const { inv, distributions, refunds, netInvested, totalValue, multiple } of computed) {
    const after = {
      ...inv,
      computed_realized: distributions,
      computed_refunds: refunds,
      computed_net_invested: netInvested,
      computed_total_value: totalValue,
      computed_multiple: multiple,
    };
    await detectAndLogChanges(inv, after, 'transactions_recompute');
    updates.push({
      investment_id: inv.id,
      company_name: inv.company_name,
      distributions,
      refunds,
      total_value: totalValue,
      multiple,
    });
  }

  return updates;
}
