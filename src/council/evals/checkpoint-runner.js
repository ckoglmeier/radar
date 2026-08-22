import { renameSync, writeFileSync } from 'node:fs';

const TRANSIENT_PATTERNS = [
  /connection closed/i,
  /connectionrefused/i,
  /connection reset/i,
  /econnrefused/i,
  /econnreset/i,
  /etimedout/i,
  /socket hang up/i,
  /unable to connect/i,
  /ended without a result/i,
];

export function atomicWriteJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function classifyEvalFailure(error) {
  if (error?.code === 'COUNCIL_STAGE_TIMEOUT') {
    return { outcome: 'timed_out', retryable: true, errorKind: 'stage_timeout' };
  }
  const detail = `${error?.message || ''} ${error?.detail || ''}`;
  if (error?.kind === 'rate_limit' || TRANSIENT_PATTERNS.some(pattern => pattern.test(detail))) {
    return { outcome: 'transport_failed', retryable: true, errorKind: error?.kind || 'transport' };
  }
  return {
    outcome: 'validation_failed',
    retryable: false,
    errorKind: error?.kind || error?.code || 'validation',
  };
}

export async function runCheckpointedCase({
  selector,
  attempts,
  operation,
  onCheckpoint,
  maxRetries = 2,
  backoffMs = [1_000, 3_000],
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  const selectorKey = JSON.stringify(selector);
  const priorAttemptCount = attempts.filter(
    item => JSON.stringify(item.selector) === selectorKey,
  ).length;
  for (let localAttempt = 1; localAttempt <= maxRetries + 1; localAttempt += 1) {
    const attempt = priorAttemptCount + localAttempt;
    const startedAt = new Date();
    try {
      const value = await operation(attempt);
      const completedAt = new Date();
      attempts.push({
        selector,
        attempt,
        model_policy: value?.modelPolicy || null,
        started_at: startedAt.toISOString(),
        completed_at: completedAt.toISOString(),
        duration_ms: completedAt.getTime() - startedAt.getTime(),
        outcome: 'passed',
        error_kind: null,
        error_detail: null,
      });
      onCheckpoint?.();
      return value;
    } catch (error) {
      const completedAt = new Date();
      const failure = classifyEvalFailure(error);
      attempts.push({
        selector,
        attempt,
        model_policy: null,
        started_at: startedAt.toISOString(),
        completed_at: completedAt.toISOString(),
        duration_ms: completedAt.getTime() - startedAt.getTime(),
        outcome: failure.outcome,
        error_kind: failure.errorKind,
        error_detail: error?.detail || error?.message || String(error),
      });
      onCheckpoint?.();
      if (!failure.retryable || localAttempt > maxRetries) throw error;
      await wait(backoffMs[Math.min(localAttempt - 1, backoffMs.length - 1)] || 0);
    }
  }
  throw new Error('evaluation retry loop exhausted unexpectedly');
}
