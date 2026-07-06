import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { query } from '../db/index.js';
import { withSyncRun } from '../db/sync-runs.js';
import { parseMoney, parseDate, parsePercent, parseMultiple } from '../utils/format.js';
import { roundToStageBucket } from '../utils/stage.js';
import {
  upsertInvestment,
  createValuationSnapshot,
  snapshotInvestment,
  detectAndLogChanges,
  tagInvestment,
} from '../models/investments.js';
import { getTaggingRules } from '../lenses/loader.js';

export function autoTagTheses(companyName, market) {
  const rules = getTaggingRules();
  const matches = [];
  for (const rule of rules) {
    // Check market match
    if (market && rule.markets.some(m => market.toLowerCase().includes(m.toLowerCase()))) {
      matches.push(rule.thesis);
      continue;
    }
    // Check company name match (partial matching)
    if (rule.companies.some(c => companyName.toLowerCase().includes(c.toLowerCase()))) {
      matches.push(rule.thesis);
    }
  }
  return matches;
}

export async function importAngelListCSV(filePath) {
  return withSyncRun('angellist:holdings-csv', `import ${filePath}`, async () => {
    return runAngelListImport(filePath);
  });
}

async function runAngelListImport(filePath) {
  const raw = readFileSync(filePath, 'utf-8');

  // Skip row 1 (confidentiality notice) — find second line
  const lines = raw.split('\n');
  const csvContent = lines.slice(1).join('\n');

  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  // Get thesis IDs
  const thesesRows = await query('SELECT id, name FROM theses');
  const thesisMap = {};
  for (const t of thesesRows) {
    thesisMap[t.name] = t.id;
  }

  let imported = 0;
  let skipped = 0;
  let tagged = 0;
  let errors = 0;
  const errorDetails = [];
  const results = [];

  for (const row of records) {
    const companyName = row['Company/Fund']?.trim();
    if (!companyName) continue;

    const investDate = parseDate(row['Invest Date']);
    const invested = parseMoney(row['Invested']);
    const unrealizedValue = parseMoney(row['Unrealized Value']);
    const realizedValue = parseMoney(row['Realized Value']);
    const netValue = parseMoney(row['Net Value']);
    const multiple = parseMultiple(row['Multiple']);
    const allocation = parseMoney(row['Allocation']);
    const roundSize = parseMoney(row['Round Size']);
    const valuationCap = parseMoney(row['Valuation or Cap']);
    const discount = parsePercent(row['Discount']);
    const round = row['Round']?.trim() || null;
    const stageBucket = roundToStageBucket(round);

    try {
      // Snapshot before upsert for change detection
      const before = await snapshotInvestment(companyName, investDate);

      const { id: investmentId, isNew } = await upsertInvestment({
        company_name: companyName,
        status: row['Status']?.trim() || null,
        invest_date: investDate,
        invested,
        unrealized_value: unrealizedValue,
        realized_value: realizedValue,
        net_value: netValue,
        multiple,
        investment_entity: row['Investment Entity']?.trim() || null,
        lead: row['Lead']?.trim() || null,
        investment_type: row['Investment Type']?.trim() || null,
        round,
        stage_bucket: stageBucket,
        market: row['Market']?.trim() || null,
        fund_name: row['Fund Name']?.trim() || null,
        allocation,
        instrument: row['Instrument']?.trim() || null,
        round_size: roundSize,
        valuation_cap_type: row['Valuation or Cap Type']?.trim() || null,
        valuation_cap: valuationCap,
        discount,
        carry: row['Carry']?.trim() || null,
        share_class: row['Share Class']?.trim() || null,
        source: 'angellist',
      });

      if (isNew) imported++;
      else {
        skipped++;
        // Log field changes for updated investments
        const after = await query(`SELECT * FROM investments WHERE id = $1`, [investmentId]);
        if (before && after[0]) {
          await detectAndLogChanges(before, after[0], 'angellist_csv');
        }
      }

      // Create valuation snapshot
      await createValuationSnapshot(investmentId, {
        unrealized_value: unrealizedValue,
        realized_value: realizedValue,
        net_value: netValue,
        multiple,
      });

      // Auto-tag theses
      const thesisMatches = autoTagTheses(companyName, row['Market']?.trim());
      const n = thesisMatches.length;
      const baseWeight = n > 1 ? Math.floor(100 / n) : 100;
      const remainder = n > 1 ? 100 - baseWeight * n : 0;
      for (let i = 0; i < n; i++) {
        const thesisId = thesisMap[thesisMatches[i]];
        if (thesisId) {
          const weight = baseWeight + (i < remainder ? 1 : 0);
          await tagInvestment(investmentId, thesisId, {
            isPrimary: i === 0,
            confidence: 'auto',
            taggedBy: 'system',
            weight,
          });
          tagged++;
        }
      }

      results.push({ company: companyName, id: investmentId, isNew, theses: thesisMatches });
    } catch (err) {
      errors++;
      errorDetails.push({ company: companyName, error: err.message });
      console.error(`Error importing ${companyName}: ${err.message}`);
    }
  }

  return {
    imported,
    skipped,
    tagged,
    total: records.length,
    results,
    // sync_runs fields
    records_seen: records.length,
    records_new: imported,
    records_changed: skipped,
    errors,
    error_details: errorDetails.length > 0 ? errorDetails : null,
  };
}
