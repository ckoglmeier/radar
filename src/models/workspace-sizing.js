import { query } from '../db/index.js';

const moneyFields = ['risk_capital', 'floor', 'min_check', 'max_check', 'late_stage_approved_check'];
const rateFields = ['single_position_cap_pct', 'cluster_cap_pct', 'illiquid_ceiling_pct', 'opportunity_cost_rate'];
const allowed = new Set([...moneyFields, ...rateFields, 'tiers']);

export function validateWorkspaceSizing(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Sizing settings are required.');
  if (Object.keys(input).some(key => !allowed.has(key))) throw new TypeError('Unknown sizing setting. Annual budgets are saved separately.');
  const config = {};
  for (const field of [...moneyFields, ...rateFields]) {
    const value = input[field];
    const max = rateFields.includes(field) ? 1 : 999999999999.99;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new TypeError(`Invalid ${field}.`);
    config[field] = value;
  }
  if (config.risk_capital <= 0 || config.floor >= config.risk_capital) throw new TypeError('Capital must be positive and exceed the protected floor.');
  if (config.min_check <= 0 || config.max_check < config.min_check || config.max_check > config.risk_capital) throw new TypeError('Check limits must be positive, ordered, and within capital.');
  if (config.late_stage_approved_check !== 0 && (config.late_stage_approved_check < config.min_check || config.late_stage_approved_check > config.max_check)) throw new TypeError('Late-stage check must be zero or within check limits.');
  if (!Array.isArray(input.tiers) || input.tiers.length < 1 || input.tiers.length > 51) throw new TypeError('Check tiers are required.');
  let previous = 51;
  config.tiers = input.tiers.map(tier => {
    if (!tier || Object.keys(tier).some(key => !['min_score', 'check'].includes(key))) throw new TypeError('Invalid check tier.');
    if (!Number.isInteger(tier.min_score) || tier.min_score < 0 || tier.min_score >= previous) throw new TypeError('Tier scores must descend uniquely from 50 or less.');
    previous = tier.min_score;
    if (typeof tier.check !== 'number' || !Number.isFinite(tier.check) || (tier.check !== 0 && (tier.check < config.min_check || tier.check > config.max_check))) throw new TypeError('Tier check must be zero or within check limits.');
    return { min_score: tier.min_score, check: tier.check };
  });
  if (previous !== 0) throw new TypeError('Include a final tier starting at score zero.');
  return config;
}

export async function getWorkspaceSizing() {
  const [row] = await query('SELECT * FROM workspace_sizing_versions ORDER BY version DESC LIMIT 1');
  return row || null;
}

export async function saveWorkspaceSizing({ config, expectedVersion, changeNote }) {
  const validated = validateWorkspaceSizing(config);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new TypeError('Expected sizing version is required.');
  const note = String(changeNote || '').trim();
  if (!note || note.length > 2000) throw new TypeError('A change note of 1–2000 characters is required.');
  const previous = await getWorkspaceSizing();
  if (Number(previous?.version || 0) !== expectedVersion) throw new Error('Sizing settings changed. Reload before saving.');
  // A concurrent writer receives a unique-version conflict, never overwrites.
  const [saved] = await query('INSERT INTO workspace_sizing_versions (version, config, change_note) VALUES ($1, $2::jsonb, $3) RETURNING *', [expectedVersion + 1, JSON.stringify(validated), note]);
  return saved;
}
