#!/usr/bin/env node

import { selectPipelineNextAction } from './pipeline-readiness.js';

const cases = [
  [{ runStatus: 'running' }, 'wait_for_council'],
  [{ runStatus: 'queued' }, 'wait_for_council'],
  [{ runStatus: 'failed' }, 'retry_council'],
  [{ hasEvaluation: false }, 'run_council'],
  [{ hasEvaluation: true, criticalEvidenceMissing: true }, 'add_evidence'],
  [{ hasEvaluation: true, unresolvedCriticalQuestions: 1 }, 'answer_followup'],
  [{ hasEvaluation: true, sizingBlocked: true }, 'complete_sizing'],
  [{ hasEvaluation: true, sealed: false }, 'record_decision'],
  [{ hasEvaluation: true, sealed: true, inviteStatus: 'committed' }, 'mark_executed'],
  [{ hasEvaluation: true, sealed: true, inviteStatus: 'invested' }, 'none'],
];

let failed = 0;
for (const [state, expected] of cases) {
  const result = selectPipelineNextAction({
    runStatus: null,
    hasEvaluation: false,
    criticalEvidenceMissing: false,
    unresolvedCriticalQuestions: 0,
    sizingBlocked: false,
    sealed: false,
    inviteStatus: 'invite',
    ...state,
  });
  if (result.nextAction.type !== expected) {
    failed++;
    console.error(`  ✗ expected ${expected}, got ${result.nextAction.type}`);
  } else {
    console.log(`  ✓ ${expected}`);
  }
}
if (failed) process.exit(1);
