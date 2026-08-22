import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  atomicWriteJson,
  classifyEvalFailure,
  runCheckpointedCase,
} from './checkpoint-runner.js';

assert.deepEqual(classifyEvalFailure({ code: 'COUNCIL_STAGE_TIMEOUT' }), {
  outcome: 'timed_out', retryable: true, errorKind: 'stage_timeout',
});
assert.equal(classifyEvalFailure({ detail: 'Connection closed mid-response' }).retryable, true);
assert.equal(classifyEvalFailure(new Error('schema mismatch')).retryable, false);

const attempts = [];
let calls = 0;
let checkpoints = 0;
const result = await runCheckpointedCase({
  selector: { suite: 'release', case_id: 'chunk_all-3' },
  attempts,
  wait: async () => {},
  onCheckpoint: () => { checkpoints += 1; },
  operation: async () => {
    calls += 1;
    if (calls < 3) {
      const error = new Error('Council research stage exceeded 10ms');
      error.code = 'COUNCIL_STAGE_TIMEOUT';
      throw error;
    }
    return { value: 25, modelPolicy: { research: 'test-model' } };
  },
});
assert.equal(result.value, 25);
assert.equal(calls, 3);
assert.equal(checkpoints, 3);
assert.deepEqual(attempts.map(item => item.outcome), ['timed_out', 'timed_out', 'passed']);

let validationCalls = 0;
await assert.rejects(() => runCheckpointedCase({
  selector: { suite: 'semantic', fixture_id: 'private-only-seed' },
  attempts: [],
  wait: async () => {},
  operation: async () => {
    validationCalls += 1;
    throw new Error('semantic validation failed');
  },
}), /semantic validation failed/);
assert.equal(validationCalls, 1, 'validation failures are not retried');

const scratch = mkdtempSync(join(tmpdir(), 'radar-eval-checkpoint-'));
try {
  const path = join(scratch, 'checkpoint.json');
  atomicWriteJson(path, { complete: true });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { complete: true });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log('evaluation checkpoint runner: retry classification and atomic writes passed');
