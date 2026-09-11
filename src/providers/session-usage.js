const FIELDS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens',
  'cacheCreationInputTokens', 'totalCostUsd'];
// Missing legacy fields retain their established zero default. An explicit
// null is an adapter's attestation that usage is UNKNOWN, and must propagate.
const value = n => n === null ? null : Number(n || 0);
const plus = (a, b) => a === null || b === null ? null : a + b;

export function aggregateStageUsage(stages) {
  const total = Object.fromEntries(FIELDS.map(key => [key, 0]));
  const byModel = new Map();
  const perStage = stages.map(stage => {
    const usage = stage.result.usage || {};
    const normalized = Object.fromEntries(FIELDS.map(key => [key, value(usage[key])]));
    for (const key of FIELDS) total[key] = plus(total[key], normalized[key]);
    for (const [model, part] of Object.entries(usage.byModel || {})) {
      const fields = FIELDS.map(key => key === 'totalCostUsd' ? 'costUsd' : key);
      const sum = byModel.get(model) || Object.fromEntries(fields.map(key => [key, 0]));
      for (const key of fields) sum[key] = plus(sum[key], value(part[key]));
      byModel.set(model, sum);
    }
    return { stage: stage.stage, model: stage.result.model || null,
      numTurns: Number(stage.result.numTurns || 0), usage: normalized };
  });
  if (byModel.size) total.byModel = Object.fromEntries(byModel);
  return { total, perStage };
}
