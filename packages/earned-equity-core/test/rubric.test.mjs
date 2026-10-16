import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rubric = JSON.parse(readFileSync(fileURLToPath(new URL('../rubric.v1.json', import.meta.url)), 'utf8'));

// Rows from plan section 7, in order.
const PLAN_ROWS = [
  ['weak_retention_unproven_demand', 'Weak retention or unproven demand'],
  ['paid_channel_dependent_growth', 'Paid/channel-dependent growth'],
  ['weak_contribution_economics', 'Weak contribution economics or long payback'],
  ['short_runway_high_burn', 'Short runway/high burn'],
  ['strong_business_demanding_valuation', 'Strong business at a demanding valuation'],
  ['preferences_or_debt_unresolved', 'Material preferences or debt unresolved'],
  ['early_stage_no_operating_history', 'Early stage without operating history'],
];

function* keys(value) {
  if (Array.isArray(value)) for (const item of value) yield* keys(item);
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) { yield key; yield* keys(child); }
  }
}

test('rubric has the seven plan rows with their economic questions', () => {
  assert.equal(rubric.version, 1);
  assert.deepEqual(rubric.rows.map(row => [row.id, row.businessFinding]), PLAN_ROWS);
  for (const row of rubric.rows) {
    assert.ok(row.requiredEconomicQuestion.length > 20, row.id);
    assert.ok(rubric.directions.includes(row.direction), row.id);
    assert.ok(rubric.affectedAssumptions.includes(row.affectedAssumption), row.id);
    assert.ok(row.applicableStages.length && row.applicableStages.every(stage => rubric.stages.includes(stage)), row.id);
    assert.ok(row.businessModels.every(model => rubric.businessModels.includes(model)), row.id);
    assert.ok(row.evidenceNeeded.length > 0, row.id);
    assert.equal(row.confirmationRequired, true, row.id);
    assert.equal(row.numericSensitivityRequires, 'cited_evidence_or_user_estimate', row.id);
  }
  assert.equal(new Set(rubric.rows.map(row => row.id)).size, rubric.rows.length);
});

test('rubric lists the finding fields the contract requires', () => {
  assert.deepEqual(rubric.findingFields, [
    'id', 'rubricRowId', 'evidenceIds', 'applicability', 'direction', 'affectedAssumption',
    'proposedSensitivity', 'uncertainty', 'counterevidence', 'confirmationState',
  ]);
});

test('row-specific rules', () => {
  const byId = Object.fromEntries(rubric.rows.map(row => [row.id, row]));
  assert.equal(byId.preferences_or_debt_unresolved.withholdDefinitiveCommonPayout, true);
  assert.equal(byId.early_stage_no_operating_history.forbidMatureMetricSubstitution, true);
  assert.deepEqual(byId.early_stage_no_operating_history.applicableStages, ['pre-seed', 'seed', 'unknown']);
  assert.match(byId.weak_retention_unproven_demand.stageNotes, /never a retention value of zero/);
  assert.deepEqual(byId.short_runway_high_burn.correlatedExposures, ['financing', 'dilution', 'employment_interruption', 'exercise_funding']);
});

test('no probability fields anywhere in the rubric', () => {
  const banned = /probab|likelihood|odds|chance|expected_?value|exit_?prob/i;
  assert.deepEqual([...keys(rubric)].filter(key => banned.test(key)), []);
});

test('no universal SaaS cutoffs or personal-fit language in the rubric', () => {
  const text = JSON.stringify(rubric);
  assert.doesNotMatch(text, /\b(?:LTV|CAC)\s*[:/]\s*(?:CAC|LTV)?\s*\d/i);
  assert.doesNotMatch(text, /culture|career|check size|syndicate|portfolio fit/i);
});
