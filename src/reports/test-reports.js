#!/usr/bin/env node

// Golden integration tests for the financial report layer.
// Hits the real DATABASE_URL — seeds fixture rows in a 1995-1996 date window
// that is empty in the real portfolio (real portfolio starts ~2017+).
//
// Fixture company names are prefixed "ZZGOLDEN " so they sort last and are easy
// to identify. Cleanup runs in a finally block even when assertions fail.
//
// Run: node src/reports/test-reports.js

import { query } from '../db/index.js';
import { portfolioSummary, portfolioList } from './portfolio.js';
import { thesisPerformance } from './thesis.js';
import { performanceWindows } from './performance.js';
import { calculateIRR } from '../utils/irr.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function eq(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(
      `${msg ? msg + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

// Approximate equality for floating-point ratios.
function approx(actual, expected, tol = 1e-4, msg = '') {
  const diff = Math.abs(Number(actual) - Number(expected));
  if (diff > tol) {
    throw new Error(
      `${msg ? msg + ': ' : ''}expected ≈${expected} (tol=${tol}), got ${actual} (diff=${diff})`
    );
  }
}

// ------------------------------------------------------------------
// Cleanup helper
// ------------------------------------------------------------------
async function cleanupFixtures() {
  const rows = await query(
    `SELECT id FROM investments WHERE company_name LIKE 'ZZGOLDEN %'`
  );
  if (rows.length === 0) return;
  const ids = rows.map(r => r.id);

  await query(`DELETE FROM cash_flows WHERE investment_id = ANY($1::int[])`, [ids]);
  await query(`DELETE FROM investment_theses WHERE investment_id = ANY($1::int[])`, [ids]);

  // valuations is append-only — disable trigger to allow test-row deletion
  let triggerDisabled = false;
  try {
    await query(`ALTER TABLE valuations DISABLE TRIGGER valuations_immutable`);
    triggerDisabled = true;
    await query(`DELETE FROM valuations WHERE investment_id = ANY($1::int[])`, [ids]);
  } finally {
    if (triggerDisabled) {
      await query(`ALTER TABLE valuations ENABLE TRIGGER valuations_immutable`);
    }
  }

  await query(`DELETE FROM investments WHERE id = ANY($1::int[])`, [ids]);
}

// ------------------------------------------------------------------
// Seed helpers
// ------------------------------------------------------------------
async function insertInvestment(fields) {
  const {
    company_name, status, invest_date, invested,
    unrealized_value, realized_value, net_value, multiple, stage_bucket,
  } = fields;
  const rows = await query(`
    INSERT INTO investments
      (company_name, status, invest_date, invested,
       unrealized_value, realized_value, net_value, multiple, stage_bucket)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (company_name, invest_date) DO UPDATE
      SET status = EXCLUDED.status,
          invested = EXCLUDED.invested,
          unrealized_value = EXCLUDED.unrealized_value,
          realized_value = EXCLUDED.realized_value,
          net_value = EXCLUDED.net_value,
          multiple = EXCLUDED.multiple,
          stage_bucket = EXCLUDED.stage_bucket
    RETURNING id
  `, [
    company_name, status, invest_date, invested,
    unrealized_value ?? null, realized_value ?? null,
    net_value ?? null, multiple ?? null,
    stage_bucket ?? null,
  ]);
  return rows[0].id;
}

async function insertCashFlow(investmentId, type, amount, flowDate) {
  await query(`
    INSERT INTO cash_flows (investment_id, flow_date, type, amount)
    VALUES ($1, $2, $3, $4)
  `, [investmentId, flowDate, type, amount]);
}

async function tagThesis(investmentId, thesisId, weight = 100) {
  await query(`
    INSERT INTO investment_theses (investment_id, thesis_id, weight)
    VALUES ($1, $2, $3)
    ON CONFLICT (investment_id, thesis_id) DO UPDATE SET weight = EXCLUDED.weight
  `, [investmentId, thesisId, weight]);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
async function run() {
  // Safety check: confirm the 1995-96 window is free of real data.
  const realRows = await query(`
    SELECT id, company_name FROM investments
    WHERE invest_date BETWEEN '1995-01-01' AND '1996-12-31'
      AND company_name NOT LIKE 'ZZGOLDEN %'
  `);
  if (realRows.length > 0) {
    console.error('ABORT: real investments found in 1995-96 window — cannot isolate fixtures safely.');
    console.error(realRows.map(r => `  id=${r.id} ${r.company_name}`).join('\n'));
    process.exit(2);
  }

  // Look up active thesis IDs by name.
  const thesisRows = await query(`SELECT id, name FROM theses WHERE active = TRUE`);
  const thesisIdByName = {};
  for (const t of thesisRows) thesisIdByName[t.name] = t.id;
  const aiInfraId   = thesisIdByName['AI Infrastructure & Safety'];
  const hardTechId  = thesisIdByName["Hard Tech That Reprices What's Possible"];
  if (!aiInfraId || !hardTechId) {
    console.error('ABORT: expected active thesis names not found in DB');
    process.exit(2);
  }

  let alphaId, betaId, gammaId, deltaId;

  try {
    // ----------------------------------------------------------------
    // Seed fixtures (pre-delete in case a prior run died before cleanup)
    // ----------------------------------------------------------------
    await cleanupFixtures();

    // Fixture 1: ZZGOLDEN Alpha — normal Live position with known valuation
    alphaId = await insertInvestment({
      company_name: 'ZZGOLDEN Alpha',
      status: 'Live', invest_date: '1995-01-01',
      invested: 10000, unrealized_value: 30000, realized_value: 5000,
      net_value: 35000, multiple: 3.5, stage_bucket: 'seed',
    });
    await insertCashFlow(alphaId, 'investment',  -10000, '1995-01-01');
    await insertCashFlow(alphaId, 'distribution',  5000, '1996-01-01');
    await tagThesis(alphaId, aiInfraId, 100);

    // Fixture 2: ZZGOLDEN Beta — LOCKED position (unrealized_value NULL)
    betaId = await insertInvestment({
      company_name: 'ZZGOLDEN Beta',
      status: 'Live', invest_date: '1995-06-01',
      invested: 5000, unrealized_value: null, realized_value: null,
      net_value: null, multiple: null, stage_bucket: 'pre-seed',
    });
    await insertCashFlow(betaId, 'investment',    -5000, '1995-06-01');
    await insertCashFlow(betaId, 'distribution',   1000, '1996-06-01');
    // Beta is intentionally NOT tagged to any thesis.

    // Fixture 3: ZZGOLDEN Gamma — multi-thesis weighted (50/50)
    gammaId = await insertInvestment({
      company_name: 'ZZGOLDEN Gamma',
      status: 'Live', invest_date: '1996-03-01',
      invested: 9000, unrealized_value: 18000, realized_value: 0,
      net_value: 18000, multiple: 2.0, stage_bucket: 'seed',
    });
    await insertCashFlow(gammaId, 'investment', -9000, '1996-03-01');
    await tagThesis(gammaId, aiInfraId, 50);
    await tagThesis(gammaId, hardTechId, 50);

    // Fixture 4: ZZGOLDEN Delta — refund case (invested NET of refund = 5000,
    //   but raw investment flow = -8000 and refund = +3000)
    deltaId = await insertInvestment({
      company_name: 'ZZGOLDEN Delta',
      status: 'Live', invest_date: '1995-09-01',
      invested: 5000, unrealized_value: 5000, realized_value: 0,
      net_value: 5000, multiple: 1.0, stage_bucket: null,
    });
    await insertCashFlow(deltaId, 'investment', -8000, '1995-09-01');
    await insertCashFlow(deltaId, 'refund',      3000, '1995-10-01');

    const today = new Date().toISOString().slice(0, 10);
    const OPTS  = { since: '1995-01-01', until: '1996-12-31' };

    // ================================================================
    // Section A: portfolioSummary
    // ================================================================
    console.log('\n  portfolioSummary');

    const { summary: s, locked, lockedInvested } = await portfolioSummary(OPTS);

    await test('total_invested = 10000+5000+9000+5000 = 29000', async () => {
      eq(Number(s.total_invested), 29000);
    });

    await test('total_unrealized = COALESCE fallback: 30000+5000(Beta locked→invested)+18000+5000 = 58000', async () => {
      // Beta: unrealized_value IS NULL → COALESCE(NULL, 5000) = 5000
      eq(Number(s.total_unrealized), 58000);
    });

    await test('total_realized = SUM(realized_value): Alpha=5000, Beta=NULL, Gamma=0, Delta=0 → 5000', async () => {
      // NULL in SUM is ignored. Gamma and Delta have realized_value=0 so they contribute 0.
      eq(Number(s.total_realized), 5000);
    });

    await test('total_net_value = SUM(net_value): Alpha=35000, Beta=NULL(excluded), Gamma=18000, Delta=5000 → 58000', async () => {
      // Beta has net_value=NULL which SQL SUM ignores — differs from total_unrealized behavior.
      // This is an intentional asymmetry: total_unrealized applies COALESCE, total_net_value does not.
      eq(Number(s.total_net_value), 58000);
    });

    await test('tvpi = SUM(COALESCE(net_value, invested)) / SUM(invested) = (35000+5000+18000+5000)/29000', async () => {
      // Numerator: COALESCE(35000,10000)+COALESCE(NULL,5000)+COALESCE(18000,9000)+COALESCE(5000,5000)
      //           = 35000 + 5000 + 18000 + 5000 = 63000
      // Denominator: 29000
      // TVPI = 63000/29000 ≈ 2.17241
      approx(Number(s.tvpi), 63000 / 29000, 1e-4, 'tvpi');
    });

    await test('locked count = 1 (only Beta has status=Live AND unrealized_value IS NULL)', async () => {
      eq(Number(locked), 1);
    });

    await test('lockedInvested = 5000 (Beta invested)', async () => {
      eq(Number(lockedInvested), 5000);
    });

    // IRR flow assembly check for portfolioSummary.
    // The SQL fetches cash_flows WHERE type IN ('investment','distribution','refund','adjustment'),
    // joined to investments in the since/until window. Then appends terminal = total_unrealized = 58000.
    //
    // Expected flows (sorted by date):
    //   -10000 @ 1995-01-01  (Alpha investment)
    //   -5000  @ 1995-06-01  (Beta investment)
    //   -8000  @ 1995-09-01  (Delta investment)
    //   +3000  @ 1995-10-01  (Delta refund)
    //   +5000  @ 1996-01-01  (Alpha distribution)
    //   -9000  @ 1996-03-01  (Gamma investment)
    //   +1000  @ 1996-06-01  (Beta distribution)
    //   +58000 @ today        (terminal = total_unrealized)
    await test('portfolio IRR matches calculateIRR over assembled flow set', async () => {
      const expectedFlows = [
        { date: '1995-01-01', amount: -10000 },
        { date: '1995-06-01', amount: -5000 },
        { date: '1995-09-01', amount: -8000 },
        { date: '1995-10-01', amount:  3000 },
        { date: '1996-01-01', amount:  5000 },
        { date: '1996-03-01', amount: -9000 },
        { date: '1996-06-01', amount:  1000 },
        { date: today,        amount: 58000 }, // terminal = total_unrealized
      ];
      const expectedIRR = calculateIRR(expectedFlows);
      if (expectedIRR === null) throw new Error('reference IRR solve returned null');
      if (s.irr === null) throw new Error('report IRR is null');
      const diff = Math.abs(s.irr - expectedIRR);
      // Tolerance 1e-6: the terminal value comes from Postgres numeric SUM which
      // can differ from our hand-assembled literal by a small floating-point delta.
      if (diff > 1e-6) {
        throw new Error(`IRR mismatch: report=${s.irr}, expected=${expectedIRR}, diff=${diff}`);
      }
    });

    // ================================================================
    // Section B: portfolioList
    // ================================================================
    console.log('\n  portfolioList');

    const listRows = await portfolioList('invest_date', OPTS);
    const byCompany = {};
    for (const r of listRows) byCompany[r.company_name] = r;

    await test('portfolioList returns all 4 ZZGOLDEN fixtures', async () => {
      const names = Object.keys(byCompany);
      const missing = ['ZZGOLDEN Alpha','ZZGOLDEN Beta','ZZGOLDEN Gamma','ZZGOLDEN Delta']
        .filter(n => !names.includes(n));
      if (missing.length > 0) throw new Error('missing: ' + missing.join(', '));
    });

    // net_value = COALESCE(best_total_value, invested) from portfolioList SELECT
    // best_total_value from investments_effective view (no valuation snapshots, no computed_* set):
    //   Alpha: unrealized_value=30000 (not NULL) → COALESCE(computed_total_value=NULL, lv.net_value=NULL, net_value=35000) = 35000
    //   Beta:  unrealized_value=NULL, net_value=NULL, lv.net_value=NULL → locked case → invested=5000
    //   Gamma: unrealized_value=18000 → COALESCE(NULL, NULL, 18000) = 18000
    //   Delta: unrealized_value=5000  → COALESCE(NULL, NULL, 5000) = 5000
    await test('Alpha net_value = 35000 (from i.net_value via COALESCE chain)', async () => {
      eq(Number(byCompany['ZZGOLDEN Alpha'].net_value), 35000);
    });

    await test('Beta net_value = 5000 (locked: best_total_value=invested=5000)', async () => {
      // Beta: unrealized_value IS NULL, net_value IS NULL, lv.net_value IS NULL
      // investments_effective locked-case fires → best_total_value = invested = 5000
      // portfolioList: COALESCE(5000, 5000) = 5000
      eq(Number(byCompany['ZZGOLDEN Beta'].net_value), 5000);
    });

    await test('Gamma net_value = 18000 (from i.net_value)', async () => {
      eq(Number(byCompany['ZZGOLDEN Gamma'].net_value), 18000);
    });

    await test('Delta net_value = 5000 (from i.net_value)', async () => {
      eq(Number(byCompany['ZZGOLDEN Delta'].net_value), 5000);
    });

    // multiple = COALESCE(best_multiple, 1.0) from portfolioList
    // best_multiple from investments_effective:
    //   Alpha: unrealized_value not NULL → COALESCE(NULL, NULL, 3.5) = 3.5
    //   Beta:  locked case (unrealized=NULL, multiple=NULL, lv.multiple=NULL) → 1.0
    //   Gamma: COALESCE(NULL, NULL, 2.0) = 2.0
    //   Delta: COALESCE(NULL, NULL, 1.0) = 1.0
    await test('Alpha multiple = 3.5', async () => {
      approx(Number(byCompany['ZZGOLDEN Alpha'].multiple), 3.5, 1e-6);
    });

    await test('Beta multiple = 1.0 (locked fallback)', async () => {
      approx(Number(byCompany['ZZGOLDEN Beta'].multiple), 1.0, 1e-6);
    });

    await test('Gamma multiple = 2.0', async () => {
      approx(Number(byCompany['ZZGOLDEN Gamma'].multiple), 2.0, 1e-6);
    });

    // Beta IRR (T5 + migration 019): portfolioList now reads best_unrealized_value as the
    // terminal. Beta is locked — no valuation snapshot (lv.unrealized_value NULL) and
    // table unrealized_value NULL — so best_unrealized_value = COALESCE(NULL, NULL, invested)
    // = invested = 5000. The locked stake is held at cost as the terminal instead of being
    // treated as worthless. This matches the COALESCE(unrealized_value, invested) fallback
    // that portfolioSummary/thesis/performance already use, and makes list agree with detail.
    // Flows: [-5000@1995-06-01, +1000@1996-06-01, +5000-terminal@today].
    await test('Beta IRR matches calculateIRR([-5000,+1000,+5000-terminal]) — locked→cost terminal (T5)', async () => {
      const betaFlows = [
        { date: '1995-06-01', amount: -5000 },
        { date: '1996-06-01', amount:  1000 },
        { date: today,        amount:  5000 }, // terminal = best_unrealized_value = invested (locked)
      ];
      const expectedBetaIRR = calculateIRR(betaFlows);
      if (expectedBetaIRR === null) throw new Error('reference Beta IRR solve returned null');
      const reportIRR = byCompany['ZZGOLDEN Beta'].irr;
      if (reportIRR === null) throw new Error(`Expected non-null IRR for Beta (${expectedBetaIRR}), got null`);
      const diff = Math.abs(reportIRR - expectedBetaIRR);
      // Tolerance 1e-6: terminal is dated `today`, so the Newton solve converges to a
      // slightly different precision than the hand-assembled reference (same reason the
      // portfolioSummary IRR test uses 1e-6).
      if (diff > 1e-6) {
        throw new Error(`Beta IRR mismatch: report=${reportIRR}, expected=${expectedBetaIRR}`);
      }
    });

    // Alpha IRR (inconsistency #1 fix via migration 019): portfolioList now reads
    // best_unrealized_value instead of eff_unrealized_value. Alpha has no valuation snapshot
    // (lv.unrealized_value NULL) but unrealized_value=30000 on the investments table, so
    // best_unrealized_value = COALESCE(NULL, 30000, invested) = 30000. Previously list used
    // eff_unrealized_value (NULL → no terminal); now the table-level unrealized is the terminal,
    // so list and summary agree on Alpha's residual value.
    // Flows: [-10000@1995-01-01, +5000@1996-01-01, +30000-terminal@today].
    await test('Alpha IRR from portfolioList uses best_unrealized_value (table 30000 → terminal)', async () => {
      const alphaFlows = [
        { date: '1995-01-01', amount: -10000 },
        { date: '1996-01-01', amount:   5000 },
        { date: today,        amount:  30000 }, // terminal = best_unrealized_value = table unrealized_value
      ];
      const expectedAlphaIRR = calculateIRR(alphaFlows);
      const reportIRR = byCompany['ZZGOLDEN Alpha'].irr;
      if (expectedAlphaIRR === null) {
        if (reportIRR !== null) {
          throw new Error(`Expected null IRR for Alpha, got ${reportIRR}`);
        }
      } else {
        if (reportIRR === null) throw new Error(`Expected non-null IRR for Alpha (${expectedAlphaIRR}), got null`);
        const diff = Math.abs(reportIRR - expectedAlphaIRR);
        // Tolerance 1e-5: terminal dated `today` discounted over a ~31-year horizon
        // (1995→present) magnifies the Newton convergence gap vs the hand-assembled
        // reference. Report and reference still agree to 4 significant figures.
        if (diff > 1e-5) throw new Error(`Alpha IRR mismatch: report=${reportIRR}, expected=${expectedAlphaIRR}`);
      }
    });

    // ================================================================
    // Section C: thesisPerformance
    // ================================================================
    console.log('\n  thesisPerformance');

    const thesisRows2 = await thesisPerformance(OPTS);
    const thesisByName = {};
    for (const t of thesisRows2) thesisByName[t.thesis] = t;

    await test('AI Infra total_invested = Alpha(10000*1.0) + Gamma(9000*0.5) = 14500', async () => {
      // SUM(i.invested * it.weight / 100.0): Alpha=10000*100/100=10000, Gamma=9000*50/100=4500
      approx(Number(thesisByName['AI Infrastructure & Safety'].total_invested), 14500, 1e-4);
    });

    await test("Hard Tech total_invested = Gamma(9000*0.5) = 4500", async () => {
      approx(Number(thesisByName["Hard Tech That Reprices What's Possible"].total_invested), 4500, 1e-4);
    });

    await test('AI Infra total_net_value = Alpha(35000*1.0) + Gamma(18000*0.5) = 44000', async () => {
      // SUM(i.net_value * it.weight / 100.0): Alpha=35000*1.0=35000, Gamma=18000*0.5=9000
      // Note: Beta has no thesis tag, so it does NOT appear in thesisPerformance.
      // Note: Delta has no thesis tag either.
      approx(Number(thesisByName['AI Infrastructure & Safety'].total_net_value), 44000, 1e-4);
    });

    await test("Hard Tech total_net_value = Gamma(18000*0.5) = 9000", async () => {
      approx(Number(thesisByName["Hard Tech That Reprices What's Possible"].total_net_value), 9000, 1e-4);
    });

    await test('AI Infra TVPI = SUM(COALESCE(net_value,invested)*weight/100) / total_invested = 44000/14500 ≈ 3.034', async () => {
      // COALESCE(35000,10000)*1.0 + COALESCE(18000,9000)*0.5 = 35000 + 9000 = 44000
      approx(Number(thesisByName['AI Infrastructure & Safety'].tvpi), 44000 / 14500, 1e-4);
    });

    await test("Hard Tech TVPI = COALESCE(18000,9000)*0.5 / 4500 = 9000/4500 = 2.0", async () => {
      approx(Number(thesisByName["Hard Tech That Reprices What's Possible"].tvpi), 2.0, 1e-4);
    });

    // ================================================================
    // Section D: performanceWindows (vintage year rows)
    // ================================================================
    console.log('\n  performanceWindows (vintage year)');

    const { byVintageYear } = await performanceWindows();
    const vintageByYear = {};
    for (const v of byVintageYear) vintageByYear[v.vintage_year] = v;

    await test('vintage 1995 exists', async () => {
      if (!vintageByYear[1995]) throw new Error('vintage 1995 row missing');
    });

    await test('vintage 1996 exists', async () => {
      if (!vintageByYear[1996]) throw new Error('vintage 1996 row missing');
    });

    await test('vintage 1995 deal_count = 3 (Alpha, Beta, Delta)', async () => {
      // Alpha invest_date=1995-01-01, Beta=1995-06-01, Delta=1995-09-01
      eq(Number(vintageByYear[1995].deal_count), 3);
    });

    await test('vintage 1996 deal_count = 1 (Gamma)', async () => {
      eq(Number(vintageByYear[1996].deal_count), 1);
    });

    await test('vintage 1995 invested = COALESCE(computed_net_invested, invested): 10000+5000+5000 = 20000', async () => {
      // computed_net_invested is NULL for all fixtures → falls back to invested column
      // Alpha=10000, Beta=5000, Delta=5000 (invested column is NET of refund per spec)
      eq(Number(vintageByYear[1995].invested), 20000);
    });

    await test('vintage 1996 invested = 9000 (Gamma)', async () => {
      eq(Number(vintageByYear[1996].invested), 9000);
    });

    await test('vintage 1995 current_value = COALESCE(computed_total_value, unr+real): 35000+0+5000 = 40000', async () => {
      // Alpha: COALESCE(NULL, 30000+5000) = 35000
      // Beta:  COALESCE(NULL, NULL+NULL) = COALESCE(NULL, 0+0) = 0
      // Delta: COALESCE(NULL, 5000+0) = 5000
      // Total = 40000
      eq(Number(vintageByYear[1995].current_value), 40000);
    });

    await test('vintage 1996 current_value = COALESCE(computed_total_value, 18000+0) = 18000', async () => {
      eq(Number(vintageByYear[1996].current_value), 18000);
    });

    await test('vintage 1995 TVPI = ROUND(40000/20000, 3) = 2.000', async () => {
      approx(Number(vintageByYear[1995].tvpi), 2.0, 1e-4);
    });

    await test('vintage 1996 TVPI = ROUND(18000/9000, 3) = 2.000', async () => {
      approx(Number(vintageByYear[1996].tvpi), 2.0, 1e-4);
    });

  } finally {
    await cleanupFixtures();
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
