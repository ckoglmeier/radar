#!/usr/bin/env node

// Unit tests for auth-mode.js (Phase A2). Hermetic: every case passes an explicit
// env object, never process.env. No real SDK/credentials involved — the live
// credential probe is exercised with a fake provider.
// Run: node src/providers/test-auth-mode.js

import {
  resolveAuthMode,
  assertSubscriptionAllowed,
  validateAuthStartup,
  isApiKeySourceConsistent,
  verifyActualCredential,
  probeActiveCredential,
  formatAuthStatus,
  DEFAULT_AUTH_MODE,
} from './auth-mode.js';
import { describeCredentialSelection } from './credentials.js';

let passed = 0;
let failed = 0;

// Collect tests and run them sequentially with await at the end, so async cases
// (the probe tests) are counted correctly alongside sync ones.
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function eq(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function throws(fn, matchMsg = '') {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (matchMsg && !e.message.includes(matchMsg)) {
      throw new Error(`threw, but message lacked ${JSON.stringify(matchMsg)}: ${e.message}`);
    }
  }
  if (!threw) throw new Error('expected a throw, got none');
}

function ok(v, msg = 'expected truthy') { if (!v) throw new Error(msg); }

console.log('\n  Auth-mode (A2) tests\n');

// ---- resolveAuthMode ----
test('resolveAuthMode: unset -> default api_key', () => eq(resolveAuthMode({}), 'api_key'));
test('resolveAuthMode: empty string -> default', () => eq(resolveAuthMode({ RADAR_AUTH_MODE: '' }), 'api_key'));
test('resolveAuthMode: DEFAULT_AUTH_MODE is api_key (safe default)', () => eq(DEFAULT_AUTH_MODE, 'api_key'));
test('resolveAuthMode: subscription', () => eq(resolveAuthMode({ RADAR_AUTH_MODE: 'subscription' }), 'subscription'));
test('resolveAuthMode: api_key', () => eq(resolveAuthMode({ RADAR_AUTH_MODE: 'api_key' }), 'api_key'));
test('resolveAuthMode: invalid value fails loud (no silent default)', () =>
  throws(() => resolveAuthMode({ RADAR_AUTH_MODE: 'subscribe' }), 'invalid auth mode'));

// ---- assertSubscriptionAllowed (single-user gate) ----
test('gate: api_key is always allowed (no-op) even under RADAR_MODE=cloud', () =>
  assertSubscriptionAllowed('api_key', { RADAR_MODE: 'cloud' }));
test('gate: subscription allowed when RADAR_MODE unset (local/CLI/desktop)', () =>
  assertSubscriptionAllowed('subscription', {}));
test('gate: subscription allowed when RADAR_MODE=local', () =>
  assertSubscriptionAllowed('subscription', { RADAR_MODE: 'local' }));
test('gate: subscription REFUSED under a hosted/multi-user RADAR_MODE', () =>
  throws(() => assertSubscriptionAllowed('subscription', { RADAR_MODE: 'cloud' }), 'single-user/local use only'));

// ---- validateAuthStartup (config + fail-loud guards together) ----
test('startup: empty env -> api_key mode', () => eq(validateAuthStartup({}).mode, 'api_key'));
test('startup: subscription + clean env -> ok, nothing stripped', () => {
  const { mode, selection } = validateAuthStartup({ RADAR_AUTH_MODE: 'subscription' });
  eq(mode, 'subscription');
  eq(selection.strippedApiKey, false);
  eq(selection.expectedCredentialEnv, 'CLAUDE_CODE_OAUTH_TOKEN');
});
test('startup: subscription + ANTHROPIC_API_KEY present -> shadow fail-loud', () =>
  throws(() => validateAuthStartup({ RADAR_AUTH_MODE: 'subscription', ANTHROPIC_API_KEY: 'sk-ant-xxx' }),
    'would shadow'));
test('startup: subscription + RADAR_MODE=cloud -> single-user gate fail-loud', () =>
  throws(() => validateAuthStartup({ RADAR_AUTH_MODE: 'subscription', RADAR_MODE: 'cloud' }),
    'single-user/local use only'));
test('startup: api_key + ANTHROPIC_API_KEY present -> ok, key preserved (not stripped)', () => {
  const { mode, selection } = validateAuthStartup({ RADAR_AUTH_MODE: 'api_key', ANTHROPIC_API_KEY: 'sk-ant-xxx' });
  eq(mode, 'api_key');
  eq(selection.strippedApiKey, false);
  eq(selection.apiKeyPresentInParent, true);
  eq(selection.expectedCredentialEnv, 'ANTHROPIC_API_KEY');
});

// ---- credential consistency (report the actually-winning credential) ----
test('consistency: subscription + oauth is consistent', () => ok(isApiKeySourceConsistent('subscription', 'oauth')));
test('consistency: subscription + user is INconsistent', () => ok(!isApiKeySourceConsistent('subscription', 'user')));
test('consistency: api_key + user is consistent', () => ok(isApiKeySourceConsistent('api_key', 'user')));
test('consistency: api_key + oauth is INconsistent', () => ok(!isApiKeySourceConsistent('api_key', 'oauth')));

test('verify: subscription + oauth -> ok', () => eq(verifyActualCredential('subscription', 'oauth').ok, true));
test('verify: subscription + user -> throws (would bill API account)', () =>
  throws(() => verifyActualCredential('subscription', 'user'), 'bill the API account'));
test('verify: api_key + user -> ok', () => eq(verifyActualCredential('api_key', 'user').ok, true));
test('verify: api_key + oauth -> throws (unexpected subscription billing)', () =>
  throws(() => verifyActualCredential('api_key', 'oauth'), 'credential mismatch'));

// ---- probeActiveCredential (with a fake provider — no real SDK) ----
test('probe: extracts apiKeySource from the session result', async () => {
  const fake = { async runSession() { return { text: 'OK', apiKeySource: 'oauth' }; } };
  eq(await probeActiveCredential(fake), 'oauth');
});
test('probe: returns null when the result carries no apiKeySource', async () => {
  const fake = { async runSession() { return { text: 'OK' }; } };
  eq(await probeActiveCredential(fake), null);
});

// ---- formatAuthStatus (secret-free) ----
test('status: subscription line names mode + stripped + verified credential', () => {
  const sel = describeCredentialSelection('subscription', { ANTHROPIC_API_KEY: 'sk-ant-SECRET' });
  const line = formatAuthStatus('subscription', sel, 'oauth');
  ok(line.includes('subscription'), 'names the mode');
  ok(line.includes('stripped'), 'notes the key was stripped');
  ok(line.includes('oauth'), 'reports the verified credential');
  ok(!line.includes('sk-ant-SECRET'), 'must never leak the key value');
});
test('status: api_key line, not-yet-probed', () => {
  const sel = describeCredentialSelection('api_key', {});
  const line = formatAuthStatus('api_key', sel);
  ok(line.includes('api_key') && line.includes('not yet probed'), line);
});

for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
