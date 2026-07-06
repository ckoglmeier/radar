#!/usr/bin/env node

// Integration tests for decision_records and the draft/seal model API.
// Hits the real DATABASE_URL; run under npm run test:local for throwaway PGlite.
//
// Run: node src/models/test-decisions.js

import { query } from '../db/index.js';
import {
  createDecisionDraft,
  updateDecisionDraft,
  sealDecision,
  getDecisionsForInvestment,
  listDecisions,
} from './decisions.js';
import { upsertInvestment } from './investments.js';

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
    throw new Error(`${msg ? msg + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function ok(value, msg = 'expected truthy value') {
  if (!value) throw new Error(msg);
}

async function expectRejects(fn, pattern) {
  let caught = null;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  if (!caught) throw new Error('expected function to reject');
  if (pattern && !pattern.test(caught.message)) {
    throw new Error(`expected error matching ${pattern}, got ${caught.message}`);
  }
}

async function cleanupCompany(company) {
  const rows = await query(`SELECT id FROM investments WHERE company_name = $1`, [company]);
  if (rows.length === 0) return;
  const ids = rows.map(r => r.id);
  await query(`DELETE FROM decision_records WHERE investment_id = ANY($1::int[])`, [ids]);
  await query(`DELETE FROM investment_theses WHERE investment_id = ANY($1::int[])`, [ids]);
  await query(`DELETE FROM investments WHERE id = ANY($1::int[])`, [ids]);
}

const BASE_INVESTMENT = {
  status: 'Live',
  invested: 5000,
  unrealized_value: null,
  realized_value: null,
  net_value: null,
  multiple: null,
  investment_entity: null,
  lead: 'Apex Syndicate',
  investment_type: null,
  round: 'Seed',
  stage_bucket: null,
  market: 'AI',
  fund_name: null,
  allocation: null,
  instrument: null,
  round_size: null,
  valuation_cap_type: null,
  valuation_cap: null,
  discount: null,
  carry: null,
  share_class: null,
  source: 'test',
};

async function run() {
  const stamp = Date.now();

  await test('create draft → update draft → seal returns frozen sizing_basis', async () => {
    const company = `Test Decision Records ${stamp}-1`;
    try {
      const investment = await upsertInvestment({
        ...BASE_INVESTMENT,
        company_name: company,
        invest_date: '2026-07-06',
      });
      const initialBasis = {
        binding_constraint: 'single_position_cap',
        lenses: { naive_kelly_raw: 12000, single_position_cap: 8000 },
      };

      const draft = await createDecisionDraft({
        investment_id: investment.id,
        decision: 'invest',
        what_was_known: 'Seed-stage infrastructure company.',
        confidence: 3,
        chosen_size: 5000,
        sizing_basis: initialBasis,
        review_due: '2027-07-06',
      });
      eq(draft.sealed, false, 'draft starts unsealed');
      eq(draft.sizing_basis.binding_constraint, 'single_position_cap');

      const updated = await updateDecisionDraft(draft.id, {
        confidence: 4,
        bear_view: 'Distribution risk remains high.',
      });
      eq(updated.confidence, 4);
      eq(updated.bear_view, 'Distribution risk remains high.');

      const sealBasis = {
        binding_constraint: 'annual_budget_remaining',
        lenses: { annual_budget_remaining: 4000 },
      };
      const sealed = await sealDecision(draft.id, {
        chosen_size: 4000,
        sizing_basis: sealBasis,
      });
      eq(sealed.sealed, true, 'seal flips sealed');
      ok(sealed.sealed_at, 'sealed_at is set');
      eq(Number(sealed.chosen_size), 4000);
      eq(sealed.sizing_basis.binding_constraint, 'annual_budget_remaining');

      const rows = await getDecisionsForInvestment(investment.id);
      eq(rows.length, 1);
      eq(rows[0].sizing_basis.binding_constraint, 'annual_budget_remaining');
    } finally {
      await cleanupCompany(company);
    }
  });

  await test('updateDecisionDraft rejects sealed rows and sizing_basis remains unchanged', async () => {
    const company = `Test Decision Sealed ${stamp}-2`;
    try {
      const investment = await upsertInvestment({
        ...BASE_INVESTMENT,
        company_name: company,
        invest_date: '2026-07-07',
      });
      const draft = await createDecisionDraft({
        investment_id: investment.id,
        decision: 'pass',
        confidence: 2,
        sizing_basis: { frozen: true, value: 1 },
      });
      await sealDecision(draft.id);

      await expectRejects(
        () => updateDecisionDraft(draft.id, {
          decision: 'invest',
          sizing_basis: { frozen: false, value: 999 },
        }),
        /sealed/
      );

      const rows = await getDecisionsForInvestment(investment.id);
      eq(rows.length, 1);
      eq(rows[0].decision, 'pass');
      eq(rows[0].sizing_basis.frozen, true);
      eq(rows[0].sizing_basis.value, 1);
    } finally {
      await cleanupCompany(company);
    }
  });

  await test('sealDecision rejects repeat seals', async () => {
    const company = `Test Decision Double Seal ${stamp}-3`;
    try {
      const investment = await upsertInvestment({
        ...BASE_INVESTMENT,
        company_name: company,
        invest_date: '2026-07-08',
      });
      const draft = await createDecisionDraft({
        investment_id: investment.id,
        decision: 'defer',
        confidence: 1,
      });
      await sealDecision(draft.id);
      await expectRejects(() => sealDecision(draft.id), /already sealed/);
    } finally {
      await cleanupCompany(company);
    }
  });

  await test('listDecisions can filter sealed and unsealed records', async () => {
    const company = `Test Decision List ${stamp}-4`;
    try {
      const investment = await upsertInvestment({
        ...BASE_INVESTMENT,
        company_name: company,
        invest_date: '2026-07-09',
      });
      const draft = await createDecisionDraft({
        investment_id: investment.id,
        decision: 'invest',
        confidence: 5,
      });
      await createDecisionDraft({
        investment_id: investment.id,
        decision: 'defer',
        confidence: 3,
      });
      await sealDecision(draft.id);

      const sealed = await listDecisions({ sealed: true, limit: 50 });
      const unsealed = await listDecisions({ sealed: false, limit: 50 });
      ok(sealed.some(row => row.id === draft.id), 'sealed list includes sealed row');
      ok(unsealed.some(row => row.investment_id === investment.id && row.id !== draft.id), 'unsealed list includes draft row');
    } finally {
      await cleanupCompany(company);
    }
  });

  await test('confidence must be an integer from 0 to 5', async () => {
    await expectRejects(
      () => createDecisionDraft({ decision: 'invest', confidence: 6 }),
      /confidence/
    );
    await expectRejects(
      () => createDecisionDraft({ decision: 'invest', confidence: 2.5 }),
      /confidence/
    );
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
