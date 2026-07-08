#!/usr/bin/env node

// Unit tests for session-errors.js (A3 error handling + fallback, A4 redaction).
// Hermetic: fake providers, explicit env objects, no real SDK/credentials.
// Run: node src/providers/test-session-errors.js

import {
  resolveFallbackFlag,
  redactSecrets,
  classifySessionError,
  shouldFallback,
  describeSessionError,
  runWithFallback,
  FALLBACK_ENV,
} from './session-errors.js';

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function eq(a, b, msg = '') {
  if (a !== b) throw new Error(`${msg ? msg + ': ' : ''}expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function ok(v, msg = 'expected truthy') { if (!v) throw new Error(msg); }
async function throwsAsync(fn, matchMsg = '') {
  let threw = false;
  try { await fn(); } catch (e) {
    threw = true;
    if (matchMsg && !e.message.includes(matchMsg)) throw new Error(`threw, but message lacked ${JSON.stringify(matchMsg)}: ${e.message}`);
  }
  if (!threw) throw new Error('expected a throw, got none');
}

// Fake providers.
const okProvider = (apiKeySource = 'oauth') => ({ async runSession() { return { text: 'OK', apiKeySource }; } });
const failProvider = (message, subtype) => ({ async runSession() { const e = new Error(message); if (subtype) e.subtype = subtype; throw e; } });

console.log('\n  Session-errors (A3/A4) tests\n');

// ---- resolveFallbackFlag: opt-in only ----
test('fallback flag: exact "true" enables', () => eq(resolveFallbackFlag({ [FALLBACK_ENV]: 'true' }), true));
test('fallback flag: unset -> off', () => eq(resolveFallbackFlag({}), false));
test('fallback flag: "1"/"yes"/"TRUE" do NOT enable (exact match only)', () => {
  eq(resolveFallbackFlag({ [FALLBACK_ENV]: '1' }), false);
  eq(resolveFallbackFlag({ [FALLBACK_ENV]: 'yes' }), false);
  eq(resolveFallbackFlag({ [FALLBACK_ENV]: 'TRUE' }), false);
});

// ---- redactSecrets (A4) ----
test('redact: scrubs the live ANTHROPIC_API_KEY value', () => {
  const env = { ANTHROPIC_API_KEY: 'supersecretvalue123' };
  const out = redactSecrets('error using supersecretvalue123 now', env);
  ok(!out.includes('supersecretvalue123'), 'value must be gone');
  ok(out.includes('[REDACTED]'), out);
});
test('redact: scrubs OAuth token value', () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok-abcdef' };
  ok(!redactSecrets('tok=oauth-tok-abcdef', env).includes('oauth-tok-abcdef'));
});
test('redact: masks sk-ant- key shape even if not in env', () => {
  const out = redactSecrets('key sk-ant-api03-ZZZ_zzz-123 leaked', {});
  ok(!out.includes('sk-ant-api03-ZZZ_zzz-123'), out);
  ok(out.includes('sk-ant-[REDACTED]'), out);
});
test('redact: leaves ordinary text untouched; handles null', () => {
  eq(redactSecrets('nothing secret here', {}), 'nothing secret here');
  eq(redactSecrets(null, {}), null);
});

// ---- classifySessionError ----
test('classify: "Not logged in" -> auth (not retryable)', () => {
  const c = classifySessionError(new Error('Agent SDK session failed: Not logged in'));
  eq(c.kind, 'auth'); eq(c.retryable, false);
});
test('classify: rate limit / 429 -> rate_limit', () => {
  eq(classifySessionError(new Error('429 Too Many Requests')).kind, 'rate_limit');
  eq(classifySessionError(new Error('rate limit exceeded')).kind, 'rate_limit');
});
test('classify: credit/quota/usage limit -> credit', () => {
  eq(classifySessionError(new Error('credit balance exhausted')).kind, 'credit');
  eq(classifySessionError(new Error('monthly usage limit reached')).kind, 'credit');
});
test('classify: unknown -> other (not retryable)', () => {
  eq(classifySessionError(new Error('some weird failure')).kind, 'other');
});

// ---- shouldFallback (policy) ----
test('policy: credit + enabled + subscription -> fall back', () =>
  ok(shouldFallback({ kind: 'credit' }, { fallbackEnabled: true, currentMode: 'subscription' })));
test('policy: rate_limit + enabled + subscription -> fall back', () =>
  ok(shouldFallback({ kind: 'rate_limit' }, { fallbackEnabled: true, currentMode: 'subscription' })));
test('policy: credit + DISABLED -> no fallback (never silent)', () =>
  ok(!shouldFallback({ kind: 'credit' }, { fallbackEnabled: false, currentMode: 'subscription' })));
test('policy: credit + enabled but already api_key -> no fallback (nowhere to go)', () =>
  ok(!shouldFallback({ kind: 'credit' }, { fallbackEnabled: true, currentMode: 'api_key' })));
test('policy: auth error never falls back even if enabled', () =>
  ok(!shouldFallback({ kind: 'auth' }, { fallbackEnabled: true, currentMode: 'subscription' })));

// ---- describeSessionError ----
test('describe: credit on subscription w/o flag names RADAR_FALLBACK_TO_API', () => {
  const m = describeSessionError({ kind: 'credit' }, 'subscription', false);
  ok(m.includes(FALLBACK_ENV), m);
});
test('describe: credit on subscription WITH flag does not re-suggest the flag', () => {
  const m = describeSessionError({ kind: 'credit' }, 'subscription', true);
  ok(!m.includes(FALLBACK_ENV), m);
});
test('describe: auth message points at setup-token / ANTHROPIC_API_KEY', () => {
  const m = describeSessionError({ kind: 'auth' }, 'subscription', false);
  ok(m.includes('setup-token') && m.includes('ANTHROPIC_API_KEY'), m);
});

// ---- runWithFallback (orchestration) ----
test('run: primary succeeds -> usedFallback false', async () => {
  const { result, usedFallback } = await runWithFallback({ prompt: 'x' }, {
    primary: okProvider(), currentMode: 'subscription', fallbackEnabled: false,
  });
  eq(usedFallback, false); eq(result.text, 'OK');
});
test('run: credit error + flag + subscription -> retries on api_key fallback', async () => {
  let built = false;
  const { result, usedFallback, primaryErrorKind } = await runWithFallback({ prompt: 'x' }, {
    primary: failProvider('credit exhausted'),
    currentMode: 'subscription',
    fallbackEnabled: true,
    buildFallback: () => { built = true; return okProvider('user'); },
  });
  eq(usedFallback, true); eq(built, true); eq(primaryErrorKind, 'credit'); eq(result.apiKeySource, 'user');
});
test('run: credit error + flag DISABLED -> throws, no silent fallback, names the flag', async () => {
  await throwsAsync(() => runWithFallback({ prompt: 'x' }, {
    primary: failProvider('credit exhausted'), currentMode: 'subscription', fallbackEnabled: false,
    buildFallback: () => okProvider('user'),
  }), FALLBACK_ENV);
});
test('run: auth error never falls back even with flag on', async () => {
  let built = false;
  await throwsAsync(() => runWithFallback({ prompt: 'x' }, {
    primary: failProvider('Not logged in'), currentMode: 'subscription', fallbackEnabled: true,
    buildFallback: () => { built = true; return okProvider(); },
  }), 'authentication failed');
  eq(built, false, 'fallback provider must not be built for an auth error');
});
test('run: surfaced error carries a redacted detail, never the raw token', async () => {
  const env = { ANTHROPIC_API_KEY: 'leaky-secret-77' };
  try {
    await runWithFallback({ prompt: 'x' }, {
      primary: failProvider('boom with leaky-secret-77 inside'),
      currentMode: 'api_key', fallbackEnabled: false, env,
    });
    throw new Error('should have thrown');
  } catch (e) {
    ok(!(e.detail || '').includes('leaky-secret-77'), 'detail must be redacted');
    ok(!(e.message || '').includes('leaky-secret-77'), 'message must not leak the token');
  }
});

for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failed++; }
}
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
