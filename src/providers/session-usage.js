// Aggregates provider usage across council stages.
//
// Token fields: a MISSING legacy field counts as 0; an explicit null is an
// adapter's attestation that usage is UNKNOWN and propagates.
// Cost fields (totalCostUsd, estimatedCostUsd, billedCostUsd): missing OR null
// means UNKNOWN. A single unknown contributor makes the total null; unknown is
// never coerced to 0. reasoningTokens is a subset of outputTokens and is
// reported separately, never added into outputTokens.
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens',
  'cacheCreationInputTokens', 'reasoningTokens'];
const COST_FIELDS = ['totalCostUsd', 'estimatedCostUsd', 'billedCostUsd'];
const FIELDS = [...TOKEN_FIELDS, ...COST_FIELDS];

const tokenValue = n => n === null ? null : Number(n || 0);
const costValue = n => n === null || n === undefined || !Number.isFinite(Number(n)) ? null : Number(n);
const plus = (a, b) => a === null || b === null ? null : a + b;

function normalizeTools(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (item && item.tool) out.push({ tool: String(item.tool), calls: Number(item.calls || 0) });
  }
  return out;
}

export function sumBillableTools(lists) {
  const sums = new Map();
  for (const list of lists) {
    for (const { tool, calls } of normalizeTools(list)) sums.set(tool, (sums.get(tool) || 0) + calls);
  }
  return [...sums].map(([tool, calls]) => ({ tool, calls }));
}

function baseStage(name) {
  return String(name).replace(/_invalid$/, '');
}

/**
 * @param {Array<{stage: string, reusedCheckpoint?: boolean, result: object}>} stages
 * @param {{defaultProvider?: string|null}} [opts]
 * @returns {{total: object, perStage: object[], records: object[]}}
 */
export function aggregateStageUsage(stages, { defaultProvider = null } = {}) {
  const total = Object.fromEntries(FIELDS.map(key => [key, 0]));
  const byModel = new Map();
  const versions = [];
  const attempts = new Map();
  const toolLists = [];
  const perStage = [];
  const records = [];

  // A rejected attempt is `<stage>_invalid`; the accepted follow-up for the
  // same stage is its repair. Number attempts per base stage in order.
  const rejectedCount = new Map();
  for (const s of stages) if (s.stage.endsWith('_invalid')) {
    rejectedCount.set(baseStage(s.stage), (rejectedCount.get(baseStage(s.stage)) || 0) + 1);
  }

  for (const stage of stages) {
    const result = stage.result || {};
    const usage = result.usage || {};
    const normalized = {};
    for (const key of TOKEN_FIELDS) normalized[key] = tokenValue(usage[key]);
    for (const key of COST_FIELDS) normalized[key] = costValue(usage[key]);
    for (const key of FIELDS) total[key] = plus(total[key], normalized[key]);

    for (const [model, part] of Object.entries(usage.byModel || {})) {
      const fields = [...TOKEN_FIELDS.filter(k => k !== 'reasoningTokens'), 'costUsd'];
      const sum = byModel.get(model) || Object.fromEntries(fields.map(key => [key, 0]));
      for (const key of fields) {
        sum[key] = plus(sum[key], key === 'costUsd' ? costValue(part[key]) : tokenValue(part[key]));
      }
      byModel.set(model, sum);
    }

    const tools = normalizeTools(usage.billableTools);
    toolLists.push(tools);
    if (result.modelPolicyVersion != null) versions.push(result.modelPolicyVersion);

    const name = baseStage(stage.stage);
    const rejected = stage.stage.endsWith('_invalid');
    const attempt = (attempts.get(name) || 0) + 1;
    attempts.set(name, attempt);
    const attemptKind = rejected ? 'rejected' : (rejectedCount.get(name) ? 'repair' : 'initial');

    const record = {
      stage: name,
      attempt,
      attemptKind,
      reusedCheckpoint: Boolean(stage.reusedCheckpoint),
      provider: result.provider ?? defaultProvider ?? null,
      model: result.model || null,
      ...normalized,
      billableTools: tools,
    };
    records.push(record);
    perStage.push({
      stage: stage.stage,
      reusedCheckpoint: record.reusedCheckpoint,
      provider: record.provider,
      model: record.model,
      numTurns: Number(result.numTurns || 0),
      usage: normalized,
      billableTools: tools,
    });
  }

  if (byModel.size) total.byModel = Object.fromEntries(byModel);
  total.billableTools = sumBillableTools(toolLists);
  const distinct = [...new Set(versions)];
  total.model_policy_version = distinct.length ? distinct[0] : null;
  if (distinct.length > 1) total.model_policy_versions = distinct;
  total.stages = records;
  return { total, perStage, records };
}

/**
 * Read any stored usage_snapshot (pre- or post-aggregation-fix) into the
 * current shape without throwing. Old snapshots lack the new keys; those read
 * as null/empty (unknown), and a legacy numeric totalCostUsd is passed through
 * unchanged (it could not distinguish 0 from unknown).
 */
export function readUsageSnapshot(snapshot) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const out = { ...s };
  for (const key of TOKEN_FIELDS) out[key] = s[key] === undefined ? null : s[key];
  for (const key of COST_FIELDS) out[key] = costValue(s[key]);
  out.billableTools = normalizeTools(s.billableTools);
  out.stages = Array.isArray(s.stages) ? s.stages : [];
  out.model_policy_version = s.model_policy_version ?? null;
  return out;
}
